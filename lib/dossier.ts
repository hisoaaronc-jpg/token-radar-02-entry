// dossier.ts — builds the makefun/dossier/v1 document for a finished output
// directory: a canonical-JSON record holding base64 copies of the screenshots
// plus a source listing of the dashboard, cut to a fixed UTF-8 byte budget.
//
// The format is a contract with the bounty scorer, so this module implements
// the published dossier rules exactly:
//   * screenshots/ contributes every regular file whose name does not start
//     with '.', in code-unit name order; each must be a whole PNG or JPEG and
//     carry a plain name (letters, digits and . _ -, 1-128 chars).
//   * dashboard/ is walked recursively; dot-directories and non-plain names
//     are refused. Every file is listed in a "## Dashboard" block by relative
//     path with its byte size, in code-unit path order.
//   * a "## Source" section then shows each text file (extension .html, .css,
//     .js, .json, .mjs, .svg, .md or .txt) as a heading plus a fenced block.
//     Files are included whole, in path order, while they fit the budget; the
//     first file that does not fit whole is shown up to its last complete
//     line that fits, its fence closed, followed by a note of how many of its
//     lines are hidden and a cut line accounting for everything left out.
//   * the JSON is canonical: object keys in code-unit order, no whitespace.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class DossierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DossierError';
  }
}

const SCHEMA_ID = 'makefun/dossier/v1';
const DOSSIER_LIMIT = 4 * 1024 * 1024;
const IMAGE_LIMIT = 8;
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const TEXT_EXT = /\.(?:html|css|js|json|mjs|svg|md|txt)$/;
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff];

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function utf8Len(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function digestHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function startsWith(bytes: Uint8Array, head: readonly number[]): boolean {
  if (bytes.length < head.length) return false;
  for (let i = 0; i < head.length; i++) if (bytes[i] !== head[i]) return false;
  return true;
}

// Canonical JSON: the one spelling of a value — primitives via JSON.stringify,
// arrays in order, plain objects with keys sorted by code unit.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: number must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects and arrays');
    }
    const rec = value as Record<string, unknown>;
    const parts = Object.keys(rec)
      .sort(cmpStr)
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(rec[key]));
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError('canonicalJson: unsupported type ' + typeof value);
}

interface DashEntry {
  path: string;
  size: number;
}

// Every regular file under root, relative paths joined with '/', sorted by
// path. Refuses dot-directories, non-plain file names and anything that is
// neither a regular file nor a directory.
function walkDashboard(root: string): DashEntry[] {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new DossierError('buildDossier: no dashboard/ directory');
  }
  if (!rootStat.isDirectory()) throw new DossierError('buildDossier: dashboard is not a directory');
  const found: DashEntry[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    const rel = pending.pop() as string;
    const here = rel === '' ? root : join(root, rel);
    for (const ent of readdirSync(here, { withFileTypes: true })) {
      const p = rel === '' ? ent.name : rel + '/' + ent.name;
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) {
          throw new DossierError('buildDossier: dashboard/' + p + ' is a dot-directory');
        }
        pending.push(p);
      } else if (ent.isFile()) {
        if (!PLAIN_NAME.test(ent.name)) {
          throw new DossierError('buildDossier: dashboard/' + p + ': name is not plain');
        }
        found.push({ path: p, size: lstatSync(join(root, p)).size });
      } else {
        throw new DossierError('buildDossier: dashboard/' + p + ' is neither a file nor a directory');
      }
    }
  }
  found.sort((a, b) => cmpStr(a.path, b.path));
  return found;
}

function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n += 1;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

// A fence one backtick longer than the longest backtick run in the body.
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenceLang(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return ext === 'mjs' ? 'js' : ext;
}

interface ShownSection {
  heading: string;
  block: string | null; // fenced block, or null for an empty file
  blockBytes: number;
  rawBytes: number; // the file's own byte length
  text: string;
  fence: string;
  lang: string;
  lines: number;
}

// The heading plus (when it fits the remaining room) a prefix of a file's
// lines inside its fence, a note of the hidden lines, and the caller's tail
// line. Returns null when not even one line fits.
function partialSection(
  sec: ShownSection,
  room: number,
  tailFor: (hiddenBytes: number) => string,
): string | null {
  const total = sec.lines;
  const lines = sec.text.split('\n');
  const open = sec.fence + sec.lang + '\n';
  const close = sec.fence + '\n\n';
  const noteFor = (k: number): string =>
    '[' + (total - k) + " of this file's " + total + ' lines not shown.]\n';
  const fixed = utf8Len(sec.heading) + utf8Len(open) + utf8Len(close);
  let best = 0;
  let shownBytes = 0;
  let rawCursor = 0;
  for (let k = 1; k < total; k++) {
    shownBytes += utf8Len(lines[k - 1] as string) + 1;
    rawCursor = sec.rawIndexOfNewline(rawCursor) + 1;
    const hidden = sec.byteLength - rawCursor;
    if (fixed + shownBytes + utf8Len(noteFor(k)) + utf8Len(tailFor(hidden)) <= room) {
      best = k;
    }
  }
  if (best === 0) return null;
  let rawEnd = 0;
  for (let k = 0; k < best; k++) rawEnd = sec.rawIndexOfNewline(rawEnd) + 1;
  const headText = lines
    .slice(0, best)
    .map((l) => l + '\n')
    .join('');
  return (
    sec.heading + open + headText + close + noteFor(best) + tailFor(sec.byteLength - rawEnd)
  );
}

// Helper attached per section: byte offset search over the raw file bytes and
// the raw byte length, kept beside the decoded text.
interface Section extends ShownSection {
  byteLength: number;
  rawIndexOfNewline: (from: number) => number;
}

export function buildDossier(
  dir: string,
  caps: { text_max_bytes: number },
): Uint8Array {
  const max = caps.text_max_bytes;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new DossierError('buildDossier: caps.text_max_bytes must be a positive integer');
  }

  const files = walkDashboard(join(dir, 'dashboard'));

  // ---- images
  const shotsDir = join(dir, 'screenshots');
  let shotNames: string[];
  try {
    shotNames = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(cmpStr);
  } catch {
    throw new DossierError('buildDossier: screenshots/ cannot be read');
  }
  if (shotNames.length === 0) {
    throw new DossierError('buildDossier: screenshots/ holds no image');
  }
  if (shotNames.length > IMAGE_LIMIT) {
    throw new DossierError('buildDossier: screenshots/ holds too many images');
  }
  const images = shotNames.map((name) => {
    if (!PLAIN_NAME.test(name)) {
      throw new DossierError('buildDossier: screenshots/' + name + ': name is not plain');
    }
    const bytes: Uint8Array = readFileSync(join(shotsDir, name));
    if (bytes.length > DOSSIER_LIMIT) {
      throw new DossierError('buildDossier: screenshots/' + name + ' is over the byte limit');
    }
    const media = startsWith(bytes, PNG_HEAD)
      ? 'image/png'
      : startsWith(bytes, JPEG_HEAD)
        ? 'image/jpeg'
        : null;
    if (media === null) {
      throw new DossierError('buildDossier: screenshots/' + name + ' is neither a PNG nor a JPEG');
    }
    return {
      name,
      media_type: media,
      sha256: digestHex(bytes),
      base64: Buffer.from(bytes).toString('base64'),
    };
  });

  // ---- text
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const head = [
    '## Dashboard',
    '',
    'Files: ' + files.length + ' (' + totalBytes + ' bytes)',
    ...files.map((f) => '- ' + f.path + ' (' + f.size + ' bytes)'),
    '',
    '## Source',
    '',
    '',
  ].join('\n');

  const sections: Section[] = [];
  for (const f of files) {
    if (!TEXT_EXT.test(f.path)) continue;
    const raw: Uint8Array = readFileSync(join(dir, 'dashboard', f.path));
    const lines = countLines(raw);
    const heading =
      '### ' + f.path + '\n\n' + raw.length + ' bytes, ' + lines +
      ' line' + (lines === 1 ? '' : 's') + '\n\n';
    if (raw.length === 0) {
      sections.push({
        heading,
        block: null,
        blockBytes: 0,
        rawBytes: 0,
        text: '',
        fence: '',
        lang: '',
        lines: 0,
        byteLength: 0,
        rawIndexOfNewline: () => -1,
      });
      continue;
    }
    const text = new TextDecoder('utf-8').decode(raw);
    const fence = fenceFor(text);
    const lang = fenceLang(f.path);
    const block =
      fence + lang + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence + '\n\n';
    sections.push({
      heading,
      block,
      blockBytes: utf8Len(block),
      rawBytes: raw.length,
      text,
      fence,
      lang,
      lines,
      byteLength: raw.length,
      rawIndexOfNewline: (from: number) => raw.indexOf(0x0a, from),
    });
  }

  // bytesAfter[k]: summed byte length of the sections after section k.
  const bytesAfter = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) {
    bytesAfter[k] =
      (bytesAfter[k + 1] as number) +
      (k + 1 < sections.length ? (sections[k + 1] as Section).rawBytes : 0);
  }

  const cutLine = (count: number, bytes: number): string =>
    '[Cut at ' + max + ' bytes: ' + count + ' file' + (count === 1 ? '' : 's') +
    ' and ' + bytes + ' bytes left out.]\n';

  let out = head;
  let used = utf8Len(head);
  if (used + utf8Len(cutLine(0, 0)) > max) {
    throw new DossierError('buildDossier: text cap cannot hold the Dashboard block');
  }
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const sec = sections[kept] as Section;
    const size = utf8Len(sec.heading) + sec.blockBytes;
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : utf8Len(cutLine(restCount, bytesAfter[kept] as number));
    if (used + size + tail > max) break;
    out += sec.block === null ? sec.heading : sec.heading + sec.block;
    used += size;
  }
  if (kept < sections.length) {
    const first = sections[kept] as Section;
    const restCount = sections.length - kept - 1;
    const after = bytesAfter[kept] as number;
    const part =
      first.block === null
        ? null
        : partialSection(first, max - used, (hidden) => cutLine(restCount, after + hidden));
    out += part ?? cutLine(restCount + 1, after + first.rawBytes);
  }
  if (utf8Len(out) > max) {
    throw new DossierError('buildDossier: text cap cannot hold the Dashboard block');
  }

  const doc = { schema: SCHEMA_ID, cover: 0, text: out.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  if (bytes.length > DOSSIER_LIMIT) {
    throw new DossierError('buildDossier: the dossier is over the byte limit');
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
