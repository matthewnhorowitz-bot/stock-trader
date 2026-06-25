'use strict';

let POSITIONS = [];
let BOUNDARIES = []; // semi-annual rebalance dates (Jan 1 / Jul 1) for the Congress Index
let SPYCLOSE = []; // SPY close at each boundary (benchmark)
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

// Per-period return is winsorized to tame junk tickers (delisted/duplicate symbols,
// OCR mis-matches) without nuking real moves like NVDA (~+78%/6mo).
const CI_RET_CAP = 1.5; // +150% per period
const CI_RET_FLOOR = -0.95; // -95% per period

// Rules-based, periodically-rebalanced index, measured MARK-TO-MARKET between rebalance
// dates (so returns are non-overlapping and chaining is legitimate — unlike attributing
// each trade's full multi-year return to its entry period and compounding that).
// Each period: pick the top-`n` members by trailing total return over the prior `lookback`
// years (>= `minTrades` trades), then the period's return = weighted price change of that
// roster's positions held during the period. periodMonths = 12 (annual) or 6 (semi-annual);
// boundaries are emitted semi-annually so annual just steps every 2nd boundary.
function buildCongressIndex({ n, minPerMonth, lookback, weighting, periodMonths = 12, minSize = 0, chamber = 'all' }) {
  if (!POSITIONS.length || !BOUNDARIES.length) return [];
  const step = Math.max(1, Math.round(periodMonths / 6)); // boundaries per period: 1 (6mo) or 2 (annual)
  const lookbackMonths = lookback * 12;
  const minTrades = Math.max(1, Math.ceil(minPerMonth * lookbackMonths)); // ">=1/month" => 24 over a 2yr lookback
  const wfn = weighting === 'amount' ? (p) => p.amountLow || 1 : () => 1;
  let pos = POSITIONS.filter((p) => (p.entryDate || '') >= '2012'); // STOCK Act era
  if (chamber !== 'all') pos = pos.filter((p) => p.chamber === chamber); // chamber tilt
  if (minSize) pos = pos.filter((p) => (p.amountLow || 0) >= minSize); // conviction floor
  if (!pos.length) return [];
  for (const p of pos) {
    if (p._mi === undefined) p._mi = monthIndex(p);
    if (!p._mm) {
      p._mm = new Map();
      for (const [bi, g] of p.marks || []) p._mm.set(bi, g);
    }
  }
  const minEntryMi = Math.min(...pos.map((p) => p._mi));
  const lastBi = BOUNDARIES.length - 1;
  const miOf = (d) => Number(d.slice(0, 4)) * 12 + (Number(d.slice(5, 7)) - 1);
  // Growth of a position vs its entry, at boundary index bi. null = not resolvable yet.
  const growthAt = (p, bi) => {
    if (BOUNDARIES[bi] <= p.entryDate) return 1; // at/before entry
    if (p.closed) {
      if (BOUNDARIES[bi] >= p.exitDate) return 1 + p.ret; // at/after exit
    } else if (bi >= lastBi) return 1 + p.ret; // open: marked to latest at the current boundary
    const g = p._mm.get(bi);
    return g == null ? null : g;
  };
  const rows = [];
  let level = 100, spyLevel = 100;
  for (let bStart = 0; bStart + step <= lastBi; bStart += step) {
    const bEnd = bStart + step;
    const startMi = miOf(BOUNDARIES[bStart]);
    if (startMi < minEntryMi + lookbackMonths) continue; // not enough lookback history yet
    // roster: top-n members by trailing total return over [startMi - lookbackMonths, startMi)
    const winLo = startMi - lookbackMonths;
    const byM = new Map();
    for (const p of pos)
      if (p._mi >= winLo && p._mi < startMi) {
        if (!byM.has(p.member)) byM.set(p.member, []);
        byM.get(p.member).push(p);
      }
    const roster = [...byM.entries()]
      .filter(([, ps]) => ps.length >= minTrades)
      .map(([member, ps]) => ({ member, ret: wmean(ps, (p) => p.ret, wfn), n: ps.length }))
      .filter((x) => x.ret != null)
      .sort((a, b) => b.ret - a.ret)
      .slice(0, n);
    const names = new Set(roster.map((x) => x.member));
    const startD = BOUNDARIES[bStart], endD = BOUNDARIES[bEnd];
    // held = rostered members' positions overlapping [startD, endD); their mark-to-market
    // return over just this period.
    const held = [];
    for (const p of pos) {
      if (!names.has(p.member)) continue;
      if (p.entryDate >= endD) continue; // not opened yet
      if (p.closed && p.exitDate <= startD) continue; // already closed before the period
      const g0 = growthAt(p, bStart), g1 = growthAt(p, bEnd);
      if (g0 == null || g1 == null || g0 === 0) continue; // price marks not warmed yet
      let r = g1 / g0 - 1;
      if (r > CI_RET_CAP) r = CI_RET_CAP;
      else if (r < CI_RET_FLOOR) r = CI_RET_FLOOR;
      held.push({ p, r });
    }
    const ret = held.length ? wmean(held, (h) => h.r, (h) => wfn(h.p)) : null;
    // Each roster member's ACTUAL return during this period (what they contributed),
    // so the chips reconcile with the period total — distinct from x.ret, the trailing
    // selection return. null = member held nothing this period (inactive).
    const heldByMember = new Map();
    for (const h of held) {
      if (!heldByMember.has(h.p.member)) heldByMember.set(h.p.member, []);
      heldByMember.get(h.p.member).push(h);
    }
    for (const x of roster) {
      const hs = heldByMember.get(x.member);
      x.pret = hs && hs.length ? wmean(hs, (h) => h.r, (h) => wfn(h.p)) : null;
    }
    const sp0 = SPYCLOSE[bStart], sp1 = SPYCLOSE[bEnd];
    const spyRet = sp0 && sp1 ? sp1 / sp0 - 1 : null;
    if (ret != null) {
      level *= 1 + ret;
      if (spyRet != null) spyLevel *= 1 + spyRet;
    }
    rows.push({
      label: periodLabel(startMi, periodMonths),
      ret,
      spyRet,
      level,
      spyLevel,
      active: new Set(held.map((h) => h.p.member)).size,
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
  const minSize = Math.max(0, Number($('ciMinSize').value || 0));
  const chamber = $('ciChamber').value;
  const showStats = $('ciStats').checked;
  const rows = buildCongressIndex({ n, minPerMonth, lookback, weighting, periodMonths, minSize, chamber }).filter((r) => r.ret != null);
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
          ${r.roster
            .map((x, i) => {
              const cls = x.pret == null ? '' : x.pret >= 0 ? 'pos' : 'neg';
              const val = x.pret == null ? '<span style="color:var(--muted)">— idle</span>' : `<span class="${cls}">${fmtPct(x.pret)}</span>`;
              const tip = `${x.member} — this period ${x.pret == null ? 'held nothing' : fmtPct(x.pret)}; picked on +${fmtPct(x.ret)} trailing 2yr; click to backtest`;
              return `<button type="button" class="rchip" data-member="${esc(x.member)}" title="${esc(tip)}">${i + 1}. ${esc(x.member)} ${val}</button>`;
            })
            .join('')}
        </div></details>`
      )
      .join('')}
    <div class="note">Each member chip shows that member's return <i>during that period</i> (so they sum to the period total) — not the trailing record they were picked on (hover a chip to see both). Click any member to backtest just their trades, or “Backtest all” to load the whole roster into the backtester below. Backtest only — the roster is chosen <i>because</i> it performed well, so past results don't predict the future. Returns are marked-to-market between rebalance dates (each period counts only the price change earned during that period, so nothing is double-counted), vs the real S&P over the same dates. Per-period moves are capped at ±~150% to limit junk-ticker outliers.</div>`;
}

// Brute-force search for the parameter combo with the highest historical beat. This is
// explicitly OVERFITTING (it's chosen to fit the past), so it's labelled loudly as such.
function ciConfigGrid() {
  const grid = [];
  for (const n of [5, 10, 20])
    for (const minPerMonth of [0.5, 1, 2])
      for (const lookback of [1, 2, 3])
        for (const weighting of ['amount', 'equal'])
          for (const periodMonths of [6, 12])
            for (const minSize of [0, 50000])
              for (const chamber of ['all', 'senate', 'house'])
                grid.push({ n, minPerMonth, lookback, weighting, periodMonths, minSize, chamber });
  return grid;
}

function findBestConfig() {
  const out = $('ciFindOut');
  out.innerHTML = '<div class="note">Scanning configurations…</div>';
  setTimeout(() => {
    const results = [];
    for (const cfg of ciConfigGrid()) {
      const rows = buildCongressIndex(cfg).filter((r) => r.ret != null);
      if (rows.length < 6) continue; // reject degenerate tiny samples
      const last = rows[rows.length - 1];
      if (!last.spyLevel) continue;
      results.push({ cfg, beat: last.level / last.spyLevel - 1, mult: last.level / 100, spyMult: last.spyLevel / 100, periods: rows.length });
    }
    results.sort((a, b) => b.beat - a.beat);
    const top = results.slice(0, 5);
    if (!top.length) {
      out.innerHTML = '<div class="note">No configuration produced enough periods. Try again once more price data has loaded.</div>';
      return;
    }
    const desc = (c) =>
      `${c.n} members · ${c.periodMonths === 6 ? '6-mo' : 'annual'} · ${c.lookback}y lookback · ≥${c.minPerMonth}/mo · ${c.weighting === 'amount' ? 'by size' : 'equal'}${
        c.minSize ? ' · ≥$' + (c.minSize / 1000) + 'k' : ''
      }${c.chamber !== 'all' ? ' · ' + c.chamber : ''}`;
    out.innerHTML =
      `<div class="note" style="color:var(--red);font-weight:600;margin-bottom:8px">⚠ Overfit — these settings are cherry-picked to fit the past; they will NOT predict the future. For curiosity only.</div>` +
      top
        .map(
          (r, i) =>
            `<button type="button" class="ci-cfg" data-cfg="${esc(JSON.stringify(r.cfg))}" style="display:block;width:100%;text-align:left;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:7px 10px;margin-bottom:6px;color:var(--text);cursor:pointer;font-family:inherit">
            <b>#${i + 1}</b> <span class="pos">+${(r.beat * 100).toFixed(0)}% vs S&P</span> <span style="color:var(--muted)">(${r.mult.toFixed(1)}× vs ${r.spyMult.toFixed(1)}×, ${r.periods} periods)</span><br>
            <span style="font-size:12px;color:var(--muted)">${esc(desc(r.cfg))}</span></button>`
        )
        .join('') +
      `<div class="note">Click any row to apply it. Applying #1 now.</div>`;
    applyCiConfig(top[0].cfg);
  }, 0);
}

// Push a config's values into the controls, then re-render the index.
function applyCiConfig(c) {
  $('ciN').value = c.n;
  $('ciMin').value = c.minPerMonth;
  $('ciLook').value = c.lookback;
  $('ciWeight').value = c.weighting;
  $('ciRebalance').value = c.periodMonths;
  $('ciMinSize').value = c.minSize;
  $('ciChamber').value = c.chamber;
  renderCongressIndex();
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
    BOUNDARIES = data.boundaries || [];
    SPYCLOSE = data.spy || [];
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
['ciN', 'ciMin', 'ciLook', 'ciWeight', 'ciRebalance', 'ciStats', 'ciMinSize', 'ciChamber'].forEach((id) => {
  const el = $(id);
  el.oninput = renderCongressIndex;
  el.onchange = renderCongressIndex;
});
$('ciFind').onclick = findBestConfig;
$('ciFindOut').onclick = (e) => {
  const btn = e.target.closest('.ci-cfg');
  if (btn) applyCiConfig(JSON.parse(btn.dataset.cfg));
};
$('run').onclick = runBacktest;
// Roster chips in the Congress Index load members into the backtester above.
$('ci').onclick = (e) => {
  const rosterBtn = e.target.closest('[data-roster]');
  if (rosterBtn) return loadIntoBacktester(rosterBtn.dataset.roster.split('|'));
  const memberBtn = e.target.closest('[data-member]');
  if (memberBtn) loadIntoBacktester([memberBtn.dataset.member]);
};
boot();
