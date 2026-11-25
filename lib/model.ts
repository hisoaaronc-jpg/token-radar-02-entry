// model.ts — the radar's valuation model and farm-plan writer.
//
// Idea: a pre-token protocol's token, if it launched today, would most likely
// be priced the way the market already prices comparable live protocols. So
// the model learns a market-cap-to-TVL multiple for every category from the
// snapshot's own token-bearing protocols (median, shrunk toward the global
// median when a category has few samples), then applies that multiple to a
// pre-token protocol's TVL and adjusts for what the snapshot says about its
// momentum (7-day TVL change) and its maturity (days since DefiLlama began
// tracking it). Nothing is hand-tuned per protocol: rerun the program on a
// future snapshot and the board rebuilds itself.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  watchlist: boolean;
  category_multiple: number;
  momentum_factor: number;
  maturity_factor: number;
  radar_score: number;
  farm_steps: string[];
}

const NO_CATEGORY = 'Uncategorized';
const SHRINK_PRIOR = 6; // pseudo-samples of the global median in each category
const MULTIPLE_MIN = 0.03;
const MULTIPLE_MAX = 2.5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Per-category mcap/TVL multiples learned from the snapshot itself. */
export function learnMultiples(protocols: Protocol[]): Map<string, number> {
  const ratiosByCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const cat = p.category ?? NO_CATEGORY;
    const list = ratiosByCat.get(cat) ?? [];
    list.push(ratio);
    ratiosByCat.set(cat, list);
    all.push(ratio);
  }
  const globalMedian = all.length > 0 ? median(all) : 0.2;
  const out = new Map<string, number>();
  for (const [cat, ratios] of ratiosByCat) {
    const shrunk =
      (ratios.length * median(ratios) + SHRINK_PRIOR * globalMedian) /
      (ratios.length + SHRINK_PRIOR);
    out.set(cat, clamp(shrunk, MULTIPLE_MIN, MULTIPLE_MAX));
  }
  out.set(NO_CATEGORY, clamp(globalMedian, MULTIPLE_MIN, MULTIPLE_MAX));
  return out;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso + 'T00:00:00Z');
  const to = Date.parse(toIso + 'T00:00:00Z');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86400000));
}

/** Older protocols have survived long enough to launch credibly: 0.62 → 1.00. */
export function maturityFactor(p: Protocol, asOf: string): number {
  if (p.listed_at === null) return 0.8;
  const age = daysBetween(p.listed_at, asOf);
  return round3(0.62 + 0.38 * Math.min(1, age / 900));
}

/** A protocol gaining TVL into a launch is worth more than one bleeding out. */
export function momentumFactor(p: Protocol): number {
  if (p.change_7d === null) return 1;
  const c = clamp(p.change_7d, -60, 120);
  return round3(1 + (c / 100) * 0.45);
}

export function impliedValue(
  p: Protocol,
  multiples: Map<string, number>,
  asOf: string,
): { value: number; multiple: number; momentum: number; maturity: number } {
  const multiple = multiples.get(p.category ?? NO_CATEGORY) ?? (multiples.get(NO_CATEGORY) as number);
  const momentum = momentumFactor(p);
  const maturity = maturityFactor(p, asOf);
  const raw = p.tvl_usd * multiple * momentum * maturity;
  return {
    value: Math.max(1, Math.round(raw)),
    multiple: round3(multiple),
    momentum,
    maturity,
  };
}

// ---------------------------------------------------------------- farm plans

export function fmtUsd(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toString();
}

function fmtChange(c: number | null): string {
  if (c === null) return 'flat on the week';
  const sign = c > 0 ? '+' : '';
  return sign + c.toFixed(1) + '% over the last 7 days';
}

// A tiny deterministic hash so the shared steps rotate by protocol instead of
// reading identically on all 240 rows.
function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

type Playbook = (p: Protocol, ctx: Ctx) => string[];

interface Ctx {
  chain: string;
  chainList: string;
  tvl: string;
  change: string;
}

function ctxOf(p: Protocol): Ctx {
  const chain = p.chains[0] ?? 'Ethereum';
  return {
    chain,
    chainList: p.chains.length > 0 ? p.chains.join(', ') : 'Ethereum',
    tvl: fmtUsd(p.tvl_usd),
    change: fmtChange(p.change_7d),
  };
}

const PLAYBOOKS: Record<string, Playbook> = {
  dex: (p, c) => [
    `Open ${p.name} on ${c.chain} and make small recurring swaps between the deepest pairs; steady weekly volume, not one big trade, is what points systems and launch snapshots usually reward.`,
    `Provide liquidity to a top-three pool on ${p.name} (${c.chain}) and keep the position active across several weeks; concentrated ranges earn more fees but need rebalancing after large moves.`,
    `Route some of your normal ${c.chain} swaps through ${p.name} instead of a rival DEX for a month, and keep the transaction history on one wallet so any future eligibility check sees consistent usage.`,
  ],
  lending: (p, c) => [
    `Supply a blue-chip asset (ETH or a major stablecoin) to ${p.name} on ${c.chain} and leave the deposit in place; lenders with long, unbroken supply history are the classic first snapshot for a lending token.`,
    `Open a small, well-collateralised borrow on ${p.name} and repay it in full before liquidation risk builds; a completed borrow-and-repay cycle shows the protocol you used both sides of the market.`,
    `Repeat the supply position weekly on ${p.name} rather than depositing once and forgetting it: recurring deposits across many epochs read as an active user, not a one-off airdrop wallet.`,
  ],
  bridge: (p, c) => [
    `Bridge a modest amount to ${c.chain} through ${p.name} and keep the funds working on the far side for a few weeks; bridges reward routes that end in real activity, not round trips.`,
    `Use ${p.name} for transfers you would make anyway between ${c.chainList}, spreading them over several days so your history shows organic, repeated bridging rather than a single burst.`,
    `Try both directions of one ${p.name} route (into ${c.chain} and back) at least once, and hold a small balance on each side so you appear in snapshots on both chains.`,
  ],
  yield: (p, c) => [
    `Deposit into the flagship vault or strategy on ${p.name} (${c.chain}) and stay through at least one full reward epoch; vault shares held across epochs are the position a launch snapshot can see.`,
    `Split a small allocation across two ${p.name} strategies instead of one, so you hold more than one of its share tokens and show up in more of its holder sets if it tokenises.`,
    `Claim and re-deposit rewards on ${p.name} instead of withdrawing them; compounding keeps your share balance growing and your wallet active in the protocol's own accounting.`,
  ],
  staking: (p, c) => [
    `Stake a small amount through ${p.name} on ${c.chain} and hold the liquid staking position rather than selling it; duration-weighted staking is the metric most staking launches snapshot.`,
    `Use the ${p.name} staking token inside one partner money market on ${c.chain} (as collateral or in a liquidity pool) so your stake is visible in two protocols' records at once.`,
    `Restake or re-delegate a portion of rewards on ${p.name} each epoch; a growing stake over many weeks reads as conviction and is cheap to maintain.`,
  ],
  derivatives: (p, c) => [
    `Trade small, hedged perpetual positions on ${p.name} (${c.chain}) on a regular cadence; consistent weekly volume with controlled risk is what derivatives venues track for maker and trader rewards.`,
    `Post margin on ${p.name} and keep an open position through a funding cycle or two, closing cleanly; accounts that complete full trade lifecycles rank above one-minute wonders.`,
    `Use more than one market on ${p.name} (for example BTC and ETH perps) so your activity is not confined to a single pair when the venue reviews trader history.`,
  ],
  rwa: (p, c) => [
    `Complete onboarding/KYC on ${p.name} early if it offers it, then make a first small subscription on ${c.chain}; verified accounts are a small set, and launches favour users who cleared the gate before any announcement.`,
    `Hold a position in one of ${p.name}'s tokenised assets across a full distribution or reporting period so your wallet appears in its holder register at more than one snapshot date.`,
    `Add a second, smaller position on ${p.name} in a different asset class it offers (for example credit versus treasuries) to show breadth of use on ${c.chain}.`,
  ],
  chain: (p, c) => [
    `Be an early active wallet on ${p.name}: bridge a small amount in, transact weekly, and use its native dApps so your address ages inside the ecosystem before any token exists.`,
    `Hold a balance on ${p.name} across many weeks rather than passing through; chain launches consistently reward wallets with long balance history and many active days.`,
    `Deploy or interact with one contract on ${p.name} if you are technical (a simple token or NFT mint is enough) — builder activity is a separate, smaller eligibility class on most chain launches.`,
  ],
  generic: (p, c) => [
    `Start with the core action ${p.name} exists for on ${c.chain} — deposit, trade or route a small amount — and repeat it weekly; the radar's premise is that real, repeated usage is what a launch snapshot can verify.`,
    `Hold whatever position ${p.name} gives you (share, receipt or LP token) on ${c.chain} without churning it; balances that survive several weeks are weighted far above same-day round trips.`,
    `Use ${p.name} on more than one of its chains (${c.chainList}) if your wallet already operates there, so you appear in the protocol's records on each network it may snapshot.`,
  ],
};

function playbookKey(category: string | null): string {
  switch (category) {
    case 'Dexs':
      return 'dex';
    case 'Lending':
    case 'Uncollateralized Lending':
    case 'CDP':
      return 'lending';
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge':
      return 'bridge';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Leveraged Farming':
    case 'Basis Trading':
    case 'Liquidity Manager':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return 'yield';
    case 'Liquid Staking':
    case 'Liquid Restaking':
    case 'Staking Pool':
    case 'Restaked BTC':
      return 'staking';
    case 'Derivatives':
      return 'derivatives';
    case 'RWA':
      return 'rwa';
    case 'Chain':
      return 'chain';
    default:
      return 'generic';
  }
}

const SHARED_STEPS: Array<(p: Protocol, c: Ctx) => string> = [
  (p, c) =>
    `Track ${p.name} through its official site and social channels for a points program or testnet announcement; it currently holds ${c.tvl} in TVL (${c.change}), and campaigns usually open to wallets that were active before the announcement.`,
  (p, c) =>
    `Keep one clean wallet for ${p.name} on ${c.chain}: no sybil splitting, no wash activity. If a token launches, eligibility screens punish linked clusters, and a single honest history is the asset you are building.`,
  (p, c) =>
    `Set a weekly calendar reminder for ${p.name}: repeat your core action, claim anything claimable, and screenshot your position. Consistency across 6-10 weeks is the cheapest edge a farmer has before a snapshot.`,
  (p, c) =>
    `Watch ${p.name}'s governance forum and docs for words like points, season, rewards or genesis distribution; with ${c.tvl} of TVL and no token yet, any such program is the starting gun — join in week one, not week six.`,
];

export function farmSteps(p: Protocol): string[] {
  const c = ctxOf(p);
  const core = (PLAYBOOKS[playbookKey(p.category)] as Playbook)(p, c);
  const h = slugHash(p.slug);
  const shared = [
    SHARED_STEPS[h % SHARED_STEPS.length] as (p: Protocol, c: Ctx) => string,
    SHARED_STEPS[(h + 2) % SHARED_STEPS.length] as (p: Protocol, c: Ctx) => string,
  ].map((fn) => fn(p, c));
  return [...core, ...shared];
}

// ---------------------------------------------------------------- eligibility

// "Records no token" is necessary but not sufficient: the snapshot also
// lists products OF tokens that already trade — a wrapped or staked asset, a
// bridged representation, an exchange's reserve entry. Those are not
// protocols waiting on a launch of their own, so the board leaves them out:
//   * categories that are by construction a claim on an underlying asset
//     (liquid staking/restaking, canonical bridges) or an exchange itself;
//   * names carrying a whole word wrapped/staked/staking, names beginning
//     with an exchange's name, and names ending in a version marker;
//   * bridge entries named as a bare asset ticker (WBTC, USDT0): the entry
//     is the bridged asset, not the bridge protocol.
const DERIVATIVE_CATEGORIES = new Set([
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Canonical Bridge',
  'CEX',
]);
const EXCHANGE_PREFIXES = [
  'Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini',
];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const BARE_TICKER = /^[A-Z0-9]{2,6}$/;

export function isLaunchCandidate(p: Protocol): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (
    (p.category === 'Bridge' || p.category === 'Cross Chain Bridge') &&
    !p.name.includes(' ') &&
    BARE_TICKER.test(p.name)
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- the board

export const BOARD_CAP = 400;

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const multiples = learnMultiples(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter(isLaunchCandidate);
  const scored = preToken.map((p) => {
    const iv = impliedValue(p, multiples, snapshot.as_of);
    return { p, ...iv };
  });
  scored.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    if (b.p.tvl_usd !== a.p.tvl_usd) return b.p.tvl_usd - a.p.tvl_usd;
    return a.p.slug < b.p.slug ? -1 : 1;
  });
  const chosen: typeof scored = [];
  const chosenSlugs = new Set<string>();
  // The watchlist is a floor: every watchlist protocol is on the board even
  // when its learned multiple is small.
  for (const s of scored) {
    if (watch.has(s.p.slug)) {
      chosen.push(s);
      chosenSlugs.add(s.p.slug);
    }
  }
  for (const s of scored) {
    if (chosen.length >= BOARD_CAP) break;
    if (!chosenSlugs.has(s.p.slug)) {
      chosen.push(s);
      chosenSlugs.add(s.p.slug);
    }
  }
  chosen.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    if (b.p.tvl_usd !== a.p.tvl_usd) return b.p.tvl_usd - a.p.tvl_usd;
    return a.p.slug < b.p.slug ? -1 : 1;
  });
  const top = chosen.length > 0 ? chosen[0].value : 1;
  return chosen.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.value,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    watchlist: watch.has(s.p.slug),
    category_multiple: s.multiple,
    momentum_factor: s.momentum,
    maturity_factor: s.maturity,
    radar_score: Math.round(100 * (Math.log10(s.value + 1) / Math.log10(top + 1))),
    farm_steps: farmSteps(s.p),
  }));
}
