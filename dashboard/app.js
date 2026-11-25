// Token Launch Radar — dashboard behaviour.
// Renders window.RADAR_DATA (written by main.ts as data.js) into the board,
// wires the filters, and shows a protocol's model breakdown and farm plan in
// the detail panel. The URL hash can preset the view for sharing:
//   #detail=<slug>   open a protocol's detail panel
//   #cat=<category>  start filtered to a category
//   #watch=1         start with the watchlist-only filter on

(function () {
  'use strict';

  var data = window.RADAR_DATA || { as_of: '', floor_usd: 0, protocol_count: 0, watchlist_count: 0, rows: [] };
  var rows = data.rows || [];
  var selected = null;

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }

  function fmtChange(c) {
    if (c === null || c === undefined) return '<span class="chains">—</span>';
    var cls = c >= 0 ? 'up' : 'down';
    var sign = c > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + c.toFixed(1) + '%</span>';
  }

  function hashParams() {
    var out = {};
    var h = window.location.hash.replace(/^#/, '');
    h.split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      if (i > 0) out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    });
    return out;
  }

  function fillSelect(select, values) {
    values.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
  }

  function currentFilters() {
    return {
      q: el('q').value.trim().toLowerCase(),
      cat: el('f-category').value,
      chain: el('f-chain').value,
      sort: el('f-sort').value,
      watch: el('f-watch').checked,
    };
  }

  function visibleRows() {
    var f = currentFilters();
    var out = rows.filter(function (r) {
      if (f.watch && !r.watchlist) return false;
      if (f.cat && (r.category || 'Uncategorized') !== f.cat) return false;
      if (f.chain && (r.chains || []).indexOf(f.chain) === -1) return false;
      if (f.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(f.q) === -1) return false;
      return true;
    });
    var key = {
      value: function (r) { return r.implied_value_usd; },
      tvl: function (r) { return r.tvl_usd; },
      change: function (r) { return r.change_7d == null ? -Infinity : r.change_7d; },
      score: function (r) { return r.radar_score; },
    }[f.sort];
    out.sort(function (a, b) { return key(b) - key(a) || a.rank - b.rank; });
    return out;
  }

  function render() {
    var vis = visibleRows();
    var tbody = el('rows');
    var html = '';
    vis.forEach(function (r) {
      html +=
        '<tr data-slug="' + esc(r.slug) + '"' + (selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' +
        (r.watchlist ? '<span class="badge">watchlist</span>' : '') +
        '<br><span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || 'Uncategorized') + '</td>' +
        '<td class="chains">' + esc((r.chains || []).slice(0, 3).join(', ')) + ((r.chains || []).length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtChange(r.change_7d) + '</td>' +
        '<td class="num value">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td><div class="scorebar"><div style="width:' + r.radar_score + '%"></div></div></td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
    el('empty').hidden = vis.length > 0;
    el('count').textContent = vis.length + ' of ' + rows.length + ' shown';
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { showDetail(tr.getAttribute('data-slug')); });
    });
  }

  function showDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    selected = slug;
    var steps = (r.farm_steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    el('detail').innerHTML =
      '<div class="big-label">Rank #' + r.rank + ' · implied value</div>' +
      '<div class="big-value">' + fmtUsd(r.implied_value_usd) + '</div>' +
      '<h2>' + esc(r.name) + (r.watchlist ? '<span class="badge">watchlist</span>' : '') + '</h2>' +
      '<div class="dslug">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorized') + ' · ' + esc((r.chains || []).join(', ')) + '</div>' +
      '<div class="model-box">' +
      '<div class="mrow"><span>TVL</span><span>' + fmtUsd(r.tvl_usd) + '</span></div>' +
      '<div class="mrow"><span>Category multiple</span><span>× ' + r.category_multiple.toFixed(3) + '</span></div>' +
      '<div class="mrow"><span>Momentum (7d ' + (r.change_7d == null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + ')</span><span>× ' + r.momentum_factor.toFixed(3) + '</span></div>' +
      '<div class="mrow"><span>Maturity</span><span>× ' + r.maturity_factor.toFixed(3) + '</span></div>' +
      '<div class="mrow"><span>Radar score</span><span>' + r.radar_score + ' / 100</span></div>' +
      '</div>' +
      '<h3>How to farm it</h3>' +
      '<ol>' + steps + '</ol>';
    render();
  }

  function init() {
    el('stat-date').textContent = data.as_of || '—';
    el('stat-scanned').textContent = data.protocol_count || 0;
    el('stat-board').textContent = rows.length;
    el('stat-watch').textContent =
      rows.filter(function (r) { return r.watchlist; }).length + ' / ' + (data.watchlist_count || 0);
    var total = rows.reduce(function (n, r) { return n + r.implied_value_usd; }, 0);
    el('stat-total').textContent = fmtUsd(total);

    var cats = {};
    var chains = {};
    rows.forEach(function (r) {
      cats[r.category || 'Uncategorized'] = true;
      (r.chains || []).forEach(function (c) { chains[c] = true; });
    });
    fillSelect(el('f-category'), Object.keys(cats).sort());
    fillSelect(el('f-chain'), Object.keys(chains).sort());

    var h = hashParams();
    if (h.cat) el('f-category').value = h.cat;
    if (h.watch === '1') el('f-watch').checked = true;
    if (h.q) el('q').value = h.q;

    ['q', 'f-category', 'f-chain', 'f-sort', 'f-watch'].forEach(function (id) {
      el(id).addEventListener('input', render);
      el(id).addEventListener('change', render);
    });

    render();
    if (h.detail) showDetail(h.detail);
    else if (rows.length > 0) showDetail(rows[0].slug);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
