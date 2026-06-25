'use strict';

let POSITIONS = [];
const selected = new Set();

const $ = (id) => document.getElementById(id);
const pctClass = (x) => (x >= 0 ? 'pos' : 'neg');
const fmtPct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const fmtUSD = (x) =>
  (x < 0 ? '-' : '') + '$' + Math.abs(Math.round(x)).toLocaleString('en-US');

// Weighted mean of value(item), weighted by weight(item).
function wmean(items, value, weight) {
  let sw = 0;
  let s = 0;
  for (const it of items) {
    const v = value(it);
    if (v == null) continue;
    const w = weight(it);
    s += v * w;
    sw += w;
  }
  return sw ? s / sw : null;
}

// --- member list -------------------------------------------------------------
function memberStats() {
  const m = new Map();
  for (const p of POSITIONS) {
    if (!m.has(p.member)) m.set(p.member, []);
    m.get(p.member).push(p.ret);
  }
  return [...m.entries()]
    .map(([member, rets]) => ({
      member,
      count: rets.length,
      avg: rets.reduce((a, b) => a + b, 0) / rets.length,
    }))
    .sort((a, b) => b.avg - a.avg);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Dropdown of not-yet-selected members + removable chips for the selected ones.
function refreshMemberUI() {
  const stats = memberStats();
  $('memberPick').innerHTML =
    '<option value="">— Add a member —</option>' +
    stats
      .filter((s) => !selected.has(s.member))
      .map((s) => `<option value="${esc(s.member)}">${esc(s.member)} (${s.count} · ${fmtPct(s.avg)})</option>`)
      .join('');
  $('chips').innerHTML = selected.size
    ? [...selected].map((m) => `<span class="chip">${esc(m)}<button class="x" data-m="${esc(m)}">×</button></span>`).join('')
    : '<span class="note" style="margin:0">None selected — backtest will copy ALL members.</span>';
}

// --- backtest ----------------------------------------------------------------
function runBacktest() {
  const from = $('from').value;
  const to = $('to').value;
  const minSize = Number($('minSize').value || 0);
  const weighting = $('weight').value;
  const includeOpen = $('includeOpen').checked;

  const filtered = POSITIONS.filter((p) => {
    if (selected.size && !selected.has(p.member)) return false;
    if (from && p.entryDate < from) return false;
    if (to && p.entryDate > to) return false;
    if (minSize && (p.amountLow || 0) < minSize) return false;
    if (!includeOpen && !p.closed) return false;
    return true;
  });

  const invest = Math.max(0, Number($('invest').value || 0));

  const wfn = weighting === 'amount' ? (p) => p.amountLow || 1 : () => 1;
  const total = wmean(filtered, (p) => p.ret, wfn);
  const spy = wmean(filtered, (p) => p.spyRet, wfn);
  const openN = filtered.filter((p) => !p.closed).length;

  // Allocate the investment across positions by the chosen weighting, then each
  // position's dollar P/L = its allocation × its return.
  const totalW = filtered.reduce((s, p) => s + wfn(p), 0) || 1;
  for (const p of filtered) {
    p._alloc = (invest * wfn(p)) / totalW;
    p._pl = p.ret == null ? 0 : p._alloc * p.ret;
  }
  const plTotal = invest && total != null ? invest * total : 0;
  const plSpy = invest && spy != null ? invest * spy : 0;

  // per member (with dollar P/L)
  const byM = new Map();
  for (const p of filtered) {
    if (!byM.has(p.member)) byM.set(p.member, []);
    byM.get(p.member).push(p);
  }
  const perMember = [...byM.entries()]
    .map(([member, ps]) => ({
      member,
      n: ps.length,
      avg: wmean(ps, (p) => p.ret, wfn),
      pl: ps.reduce((s, p) => s + (p._pl || 0), 0),
    }))
    .sort((a, b) => b.avg - a.avg);

  renderResults({ filtered, total, spy, openN, perMember, wfn, invest, plTotal, plSpy });
  renderLeaderboard(); // keep the leaderboard in sync with the current parameters
}

function renderResults({ filtered, total, spy, openN, perMember, wfn, invest, plTotal, plSpy }) {
  const r = $('results');
  if (!filtered.length) {
    r.innerHTML = '<div class="note">No positions match. Try selecting more members or widening the filters (most positions are still awaiting price data, which fills in over the next 1–2 weeks).</div>';
    return;
  }
  const beat = total != null && spy != null ? total - spy : null;
  const dollarCards = invest
    ? `
      <div class="card"><div class="k">Invested</div><div class="v">${fmtUSD(invest)}</div></div>
      <div class="card"><div class="k">Ending value</div><div class="v">${fmtUSD(invest + plTotal)}</div></div>
      <div class="card"><div class="k">Profit / loss</div><div class="v ${pctClass(plTotal)}">${plTotal >= 0 ? '+' : ''}${fmtUSD(plTotal)}</div></div>
      <div class="card"><div class="k">Return</div><div class="v ${pctClass(total)}">${fmtPct(total)}</div></div>
      <div class="card"><div class="k">vs S&P 500</div><div class="v ${pctClass(beat)}">${beat >= 0 ? '+' : ''}${fmtPct(beat)} <span style="font-size:12px;color:var(--muted)">(${fmtUSD(plTotal - plSpy)})</span></div></div>`
    : `
      <div class="card"><div class="k">Index return</div><div class="v ${pctClass(total)}">${fmtPct(total)}</div></div>
      <div class="card"><div class="k">S&P 500 (SPY)</div><div class="v ${pctClass(spy)}">${fmtPct(spy)}</div></div>
      <div class="card"><div class="k">vs S&P 500</div><div class="v ${pctClass(beat)}">${beat >= 0 ? '+' : ''}${fmtPct(beat)}</div></div>`;
  r.innerHTML = `
    <div class="cards">
      ${dollarCards}
      <div class="card"><div class="k">Positions</div><div class="v">${filtered.length}<span style="font-size:13px;color:var(--muted)"> (${openN} open)</span></div></div>
    </div>
    ${equityCurve(filtered, wfn)}
    <h2 style="margin-top:18px;">By member</h2>
    <table>
      <thead><tr><th>Member</th><th class="num">Avg return</th>${invest ? '<th class="num">$ P/L</th>' : ''}<th class="num"># trades</th></tr></thead>
      <tbody>
        ${perMember
          .map(
            (m) =>
              `<tr><td>${m.member}</td><td class="num ${pctClass(m.avg)}">${fmtPct(m.avg)}</td>${
                invest ? `<td class="num ${pctClass(m.pl)}">${m.pl >= 0 ? '+' : ''}${fmtUSD(m.pl)}</td>` : ''
              }<td class="num">${m.n}</td></tr>`
          )
          .join('')}
      </tbody>
    </table>
    <div class="note">Copyable return: buy at each trade's disclosure date, sell when they sell (open positions marked to the latest price). Dollars allocated by the chosen weighting. End-of-day prices. Not financial advice.</div>`;
}

// Running weighted-average realized return through time (closed positions by exit date),
// with an SPY line over the same set. Dependency-free inline SVG.
function equityCurve(filtered, wfn) {
  const closed = filtered.filter((p) => p.closed && p.exitDate).sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  if (closed.length < 2) return '<div class="note">Not enough closed positions yet to draw a curve.</div>';

  const pts = [];
  const acc = [];
  for (const p of closed) {
    acc.push(p);
    pts.push({
      d: p.exitDate,
      me: wmean(acc, (x) => x.ret, wfn),
      spy: wmean(acc, (x) => x.spyRet, wfn),
    });
  }
  const W = 700, H = 240, padL = 44, padB = 26, padT = 12, padR = 12;
  const xs = pts.map((_, i) => i);
  const ys = pts.flatMap((p) => [p.me, p.spy]).filter((v) => v != null);
  const ymin = Math.min(...ys, 0);
  const ymax = Math.max(...ys, 0);
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * (H - padT - padB);
  const line = (key, color) =>
    `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')}"/>`;
  const zeroY = y(0);
  const yticks = [ymin, (ymin + ymax) / 2, ymax]
    .map((v) => `<text x="6" y="${(y(v) + 4).toFixed(1)}" fill="#8b98a5" font-size="11">${(v * 100).toFixed(0)}%</text>`)
    .join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="#2d3744"/>
      ${yticks}
      <text x="${padL}" y="${H - 8}" fill="#8b98a5" font-size="11">${pts[0].d}</text>
      <text x="${W - padR}" y="${H - 8}" fill="#8b98a5" font-size="11" text-anchor="end">${pts[pts.length - 1].d}</text>
      ${line('spy', '#8b98a5')}
      ${line('me', '#2ea043')}
    </svg>
    <div class="legend"><span class="dot" style="background:#2ea043"></span>Copied members &nbsp; <span class="dot" style="background:#8b98a5"></span>S&P 500 — running average realized return as each position closes</div>`;
}

// --- leaderboard -------------------------------------------------------------
function readParams() {
  return {
    from: $('from').value,
    to: $('to').value,
    minSize: Math.max(0, Number($('minSize').value || 0)),
    includeOpen: $('includeOpen').checked,
    weighting: $('weight').value,
  };
}

// Per-member ranking from ALL positions (ignores the member selection), using
// the current parameters + chamber filter.
function memberStatsFiltered({ from, to, minSize, includeOpen, weighting, chamber }) {
  const wfn = weighting === 'amount' ? (p) => p.amountLow || 1 : () => 1;
  const byM = new Map();
  for (const p of POSITIONS) {
    if (chamber && chamber !== 'all' && p.chamber !== chamber) continue;
    if (from && p.entryDate < from) continue;
    if (to && p.entryDate > to) continue;
    if (minSize && (p.amountLow || 0) < minSize) continue;
    if (!includeOpen && !p.closed) continue;
    if (!byM.has(p.member)) byM.set(p.member, { ps: [], chamber: p.chamber });
    byM.get(p.member).ps.push(p);
  }
  return [...byM.entries()]
    .map(([member, o]) => ({ member, chamber: o.chamber, n: o.ps.length, avg: wmean(o.ps, (p) => p.ret, wfn) }))
    .filter((m) => m.avg != null)
    .sort((a, b) => b.avg - a.avg);
}

const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r);

function renderLeaderboard() {
  if (!POSITIONS.length) return;
  const stats = memberStatsFiltered({ ...readParams(), chamber: $('lbChamber').value });
  $('leaderboard').innerHTML = `
    <table>
      <thead><tr><th class="rank">#</th><th>Member</th><th>Chamber</th><th class="num">Return</th><th class="num"># trades</th></tr></thead>
      <tbody>
        ${stats
          .map(
            (m, i) =>
              `<tr><td class="rank">${medal(i + 1)}</td><td>${esc(m.member)}</td><td style="color:var(--muted);text-transform:capitalize">${m.chamber}</td><td class="num ${pctClass(
                m.avg
              )}">${fmtPct(m.avg)}</td><td class="num">${m.n}</td></tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

// --- congress index ----------------------------------------------------------
// Month index since year 0 ("YYYY-MM-DD" -> Y*12 + (M-1)) so we can bucket by any
// period length, not just calendar years.
const monthIndex = (p) => {
  const d = p.entryDate || '';
  return Number(d.slice(0, 4)) * 12 + (Number(d.slice(5, 7)) - 1);
};
// Period label for a period's start month index: annual -> "2021", 6-month -> "2021 H1".
function periodLabel(startMi, periodMonths) {
  const year = Math.floor(startMi / 12);
  if (periodMonths >= 12) return String(year);
  const half = Math.floor((startMi % 12) / periodMonths) + 1; // 1-based sub-period within the year
  return `${year} H${half}`;
}

// Rules-based, periodically-rebalanced index. Each period: pick the top-`n` members by
// trade-size-weighted return over the prior `lookback` years (>= `minTrades` trades),
// then the period's return = weighted return of that roster's trades entered in it. Chain
// to an index level (start 100), alongside an SPY level over the same trades.
// periodMonths = 12 (annual, default) or 6 (semi-annual). periodMonths=12 reproduces the
// original calendar-year behavior exactly.
function buildCongressIndex({ n, minPerMonth, lookback, weighting, periodMonths = 12 }) {
  const lookbackMonths = lookback * 12;
  const minTrades = Math.max(1, Math.ceil(minPerMonth * lookbackMonths)); // ">=1/month" => 24 over a 2yr lookback
  const wfn = weighting === 'amount' ? (p) => p.amountLow || 1 : () => 1;
  const pos = POSITIONS.filter((p) => (p.entryDate || '') >= '2012').map((p) => ({ p, mi: monthIndex(p) })); // STOCK Act era
  if (!pos.length) return [];
  const minMi = Math.min(...pos.map((x) => x.mi));
  const now = new Date();
  const maxMi = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const firstP = Math.floor(minMi / periodMonths);
  const lastP = Math.floor(maxMi / periodMonths);
  const lookbackPeriods = Math.ceil(lookbackMonths / periodMonths);
  const rows = [];
  let level = 100, spyLevel = 100;
  for (let pIdx = firstP + lookbackPeriods; pIdx <= lastP; pIdx++) {
    const startMi = pIdx * periodMonths;
    const winLo = startMi - lookbackMonths; // lookback window [winLo, startMi)
    const byM = new Map();
    for (const { p, mi } of pos) {
      if (mi >= winLo && mi < startMi) {
        if (!byM.has(p.member)) byM.set(p.member, []);
        byM.get(p.member).push(p);
      }
    }
    const roster = [...byM.entries()]
      .filter(([, ps]) => ps.length >= minTrades)
      .map(([member, ps]) => ({ member, ret: wmean(ps, (p) => p.ret, wfn), n: ps.length }))
      .filter((x) => x.ret != null)
      .sort((a, b) => b.ret - a.ret)
      .slice(0, n);
    const names = new Set(roster.map((x) => x.member));
    const held = pos
      .filter(({ p, mi }) => names.has(p.member) && mi >= startMi && mi < startMi + periodMonths)
      .map((x) => x.p);
    const ret = held.length ? wmean(held, (p) => p.ret, wfn) : null;
    const spyRet = held.length ? wmean(held, (p) => p.spyRet, wfn) : null;
    if (ret != null) {
      level *= 1 + ret;
      spyLevel *= 1 + (spyRet || 0);
    }
    rows.push({
      label: periodLabel(startMi, periodMonths),
      ret,
      spyRet,
      level,
      spyLevel,
      active: new Set(held.map((p) => p.member)).size,
      rosterSize: names.size,
      roster,
    });
  }
  return rows;
}

// Advanced recap metrics over the chained period rows (priced periods only).
function computeStats(rows, periodMonths) {
  const ppy = 12 / periodMonths; // periods per year
  const rets = rows.map((r) => r.ret).filter((x) => x != null);
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  const vol = sd * Math.sqrt(ppy); // annualized volatility
  const ratio = sd ? (mean / sd) * Math.sqrt(ppy) : null; // Sharpe-style (no risk-free)
  // max drawdown of the index level series
  let peak = 100, maxDD = 0;
  for (const r of rows) {
    if (r.level > peak) peak = r.level;
    const dd = peak ? (peak - r.level) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  // consistency
  const scored = rows.filter((r) => r.ret != null && r.spyRet != null);
  const wins = scored.filter((r) => r.ret > r.spyRet).length;
  const winRate = scored.length ? wins / scored.length : null;
  let best = null, worst = null;
  for (const r of rows) {
    if (r.ret == null) continue;
    if (!best || r.ret > best.ret) best = r;
    if (!worst || r.ret < worst.ret) worst = r;
  }
  // average roster turnover between consecutive periods
  const turns = [];
  for (let i = 1; i < rows.length; i++) {
    const cur = new Set(rows[i].roster.map((x) => x.member));
    const prev = new Set(rows[i - 1].roster.map((x) => x.member));
    if (!cur.size) continue;
    let kept = 0;
    for (const m of cur) if (prev.has(m)) kept++;
    turns.push(1 - kept / cur.size);
  }
  const turnover = turns.length ? turns.reduce((a, b) => a + b, 0) / turns.length : null;
  return { vol, maxDD, ratio, winRate, best, worst, turnover };
}

// Two-line level chart (index vs SPY) across years — inline SVG, no deps.
function levelChart(pts) {
  const W = 700, H = 240, padL = 48, padB = 26, padT = 12, padR = 12;
  const ymax = Math.max(...pts.flatMap((p) => [p.idx, p.spy]), 1);
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / ymax) * (H - padT - padB);
  const line = (k, c) => `<polyline fill="none" stroke="${c}" stroke-width="2.5" points="${pts.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ')}"/>`;
  const yticks = [0, ymax / 2, ymax].map((v) => `<text x="6" y="${(y(v) + 4).toFixed(1)}" fill="#8b949e" font-size="11">${Math.round(v)}</text>`).join('');
  const every = Math.ceil(pts.length / 12); // thin labels when crowded (e.g. semi-annual)
  const xlabels = pts
    .map((p, i) => (i % every === 0 || i === pts.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="#8b949e" font-size="11" text-anchor="middle">${p.label}</text>` : ''))
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${yticks}${xlabels}${line('spy', '#8b949e')}${line('idx', '#3fb950')}</svg>`;
}

function renderCongressIndex() {
  if (!POSITIONS.length) return;
  const n = Math.max(1, Number($('ciN').value || 20));
  const minPerMonth = Math.max(0, Number($('ciMin').value || 1));
  const lookback = Math.max(1, Number($('ciLook').value || 2));
  const weighting = $('ciWeight').value;
  const periodMonths = Number($('ciRebalance').value || 12);
  const showStats = $('ciStats').checked;
  const rows = buildCongressIndex({ n, minPerMonth, lookback, weighting, periodMonths }).filter((r) => r.ret != null);
  const el = $('ci');
  if (rows.length < 1) {
    el.innerHTML = '<div class="note">Not enough data for these settings — try fewer min trades or members.</div>';
    return;
  }
  const last = rows[rows.length - 1];
  const beat = last.spyLevel ? last.level / last.spyLevel - 1 : null; // % the index beat the S&P by
  const pts = [{ label: 'start', idx: 100, spy: 100 }, ...rows.map((r) => ({ label: r.label, idx: r.level, spy: r.spyLevel }))];
  const periodWord = periodMonths >= 12 ? 'Periods' : 'Periods (6-mo)';

  const stats = showStats ? computeStats(rows, periodMonths) : null;
  const statCard = (k, v, cls = '') => `<div class="card"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const statsHtml =
    stats == null
      ? ''
      : `<h2 style="margin:18px 0 8px;">Advanced stats</h2>
    <div class="cards">
      ${statCard('Volatility (annual)', (stats.vol * 100).toFixed(1) + '%')}
      ${statCard('Max drawdown', '-' + (stats.maxDD * 100).toFixed(1) + '%', 'neg')}
      ${statCard('Return / vol', stats.ratio != null ? stats.ratio.toFixed(2) : 'n/a', stats.ratio >= 0 ? 'pos' : 'neg')}
      ${statCard('Win rate vs S&P', stats.winRate != null ? (stats.winRate * 100).toFixed(0) + '%' : 'n/a', stats.winRate >= 0.5 ? 'pos' : 'neg')}
      ${statCard('Best period', stats.best ? `${fmtPct(stats.best.ret)}` : 'n/a', 'pos')}
      ${statCard('Worst period', stats.worst ? `${fmtPct(stats.worst.ret)}` : 'n/a', 'neg')}
      ${statCard('Avg roster turnover', stats.turnover != null ? (stats.turnover * 100).toFixed(0) + '%' : 'n/a')}
    </div>
    <div class="note">Volatility &amp; return/vol are annualized (no risk-free rate). Max drawdown is the largest peak-to-trough drop of the index level. Win rate = share of periods the index beat the S&P. Turnover = share of the roster that changes each rebalance.</div>`;

  el.innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">Index (from 100)</div><div class="v pos">${Math.round(last.level).toLocaleString()}</div></div>
      <div class="card"><div class="k">S&P 500</div><div class="v">${Math.round(last.spyLevel).toLocaleString()}</div></div>
      <div class="card"><div class="k">Beat the S&P by</div><div class="v ${beat >= 0 ? 'pos' : 'neg'}">${beat != null ? (beat >= 0 ? '+' : '') + (beat * 100).toFixed(0) + '%' : 'n/a'}</div></div>
      <div class="card"><div class="k">${periodWord}</div><div class="v">${rows.length}</div></div>
    </div>
    ${levelChart(pts)}
    <div class="legend"><span class="dot" style="background:#3fb950"></span>Congress Index &nbsp; <span class="dot" style="background:#8b949e"></span>S&P 500 — index level (started at 100)</div>
    ${statsHtml}
    <h2 style="margin:18px 0 8px;">Period by period &amp; roster</h2>
    ${rows
      .map(
        (r) => `<details><summary><b>${r.label}</b> — Index <span class="${r.ret >= 0 ? 'pos' : 'neg'}">${fmtPct(r.ret)}</span> vs S&P <span class="${r.spyRet >= 0 ? 'pos' : 'neg'}">${fmtPct(r.spyRet)}</span> · ${r.active}/${r.rosterSize} active</summary>
        <div class="roster">
          <button type="button" class="roster-load" data-roster="${esc(r.roster.map((x) => x.member).join('|'))}">⤓ Backtest all ${r.roster.length}</button>
          ${r.roster.map((x, i) => `<button type="button" class="rchip" data-member="${esc(x.member)}" title="Backtest ${esc(x.member)}'s trades">${i + 1}. ${esc(x.member)} <span class="${x.ret >= 0 ? 'pos' : 'neg'}">${fmtPct(x.ret)}</span></button>`).join('')}
        </div></details>`
      )
      .join('')}
    <div class="note">Tip: click any member to backtest just their trades, or “Backtest all” to load the whole roster into the backtester below. Backtest only — the roster is chosen <i>because</i> it performed well, so past results don't predict the future. Uses priced trades; a trade's full return is attributed to its entry period; S&P shown over the same holding windows. Typically only ~half a roster trades in a given period.</div>`;
}

// Load a roster (or a single member) into the member backtester above, run it,
// and scroll there — lets you drill into the actual trades behind an index roster.
function loadIntoBacktester(members) {
  selected.clear();
  members.forEach((m) => selected.add(m));
  refreshMemberUI();
  runBacktest();
  $('backtester').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- boot --------------------------------------------------------------------
async function boot() {
  try {
    const res = await fetch('./positions.json', { cache: 'no-store' });
    const data = await res.json();
    POSITIONS = data.positions || [];
    $('meta').textContent = `${POSITIONS.length} priced positions · updated ${(data.generatedAt || '').slice(0, 10)}`;
    refreshMemberUI();
    renderLeaderboard();
    renderCongressIndex();
  } catch (e) {
    $('chips').innerHTML = `<div class="note">Could not load data: ${e.message}</div>`;
  }
}
$('memberPick').onchange = (e) => {
  if (e.target.value) {
    selected.add(e.target.value);
    refreshMemberUI();
  }
};
$('chips').onclick = (e) => {
  if (e.target.classList.contains('x')) {
    selected.delete(e.target.dataset.m);
    refreshMemberUI();
  }
};
$('selAll').onclick = () => { memberStats().forEach((s) => selected.add(s.member)); refreshMemberUI(); };
$('selNone').onclick = () => { selected.clear(); refreshMemberUI(); };
$('lbChamber').onchange = renderLeaderboard;
['ciN', 'ciMin', 'ciLook', 'ciWeight', 'ciRebalance', 'ciStats'].forEach((id) => {
  const el = $(id);
  el.oninput = renderCongressIndex;
  el.onchange = renderCongressIndex;
});
$('run').onclick = runBacktest;
// Roster chips in the Congress Index load members into the backtester above.
$('ci').onclick = (e) => {
  const rosterBtn = e.target.closest('[data-roster]');
  if (rosterBtn) return loadIntoBacktester(rosterBtn.dataset.roster.split('|'));
  const memberBtn = e.target.closest('[data-member]');
  if (memberBtn) loadIntoBacktester([memberBtn.dataset.member]);
};
boot();
