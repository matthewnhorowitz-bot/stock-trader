'use strict';

let POSITIONS = [];
let BOUNDARIES = []; // semi-annual rebalance dates (Jan 1 / Jul 1) for the Congress Index
let DEPARTURES = {}; // member -> date they left office; excluded from rosters after that date
let SPYCLOSE = []; // SPY close at each boundary (benchmark)
const selected = new Set();
let CHART_SEQ = 0; // monotonic id source so inline-SVG gradient ids never collide

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

// Total-return equity curve: the value of the invested money marked to market
// through time (not a running average), vs the same allocation put in the S&P.
// Each position holds `wfn`-weighted share of the portfolio; its growth is 1 before
// entry, marked-to-market while held (semi-annual boundary marks), and frozen at its
// final return once closed (open positions marked to the latest price). The curve's
// endpoint therefore equals the headline total return. Dependency-free inline SVG.
function equityCurve(filtered, wfn) {
  if (!BOUNDARIES.length || !filtered.length) return '<div class="note">Not enough data to draw a curve yet.</div>';
  const totalW = filtered.reduce((s, p) => s + wfn(p), 0) || 1;
  const lastBi = BOUNDARIES.length - 1;
  const biOnOrAfter = (d) => { for (let i = 0; i < BOUNDARIES.length; i++) if (BOUNDARIES[i] >= d) return i; return lastBi; };
  for (const p of filtered) {
    if (!p._btMarks) p._btMarks = new Map(p.marks || []);
    if (p._btEntryBi === undefined) p._btEntryBi = biOnOrAfter(p.entryDate);
    if (p._btExitBi === undefined) p._btExitBi = p.closed && p.exitDate ? biOnOrAfter(p.exitDate) : lastBi;
  }
  // Portfolio growth of a position at boundary bi (1 = flat). `carry` = last known
  // mark, carried forward when a boundary mark hasn't been priced yet.
  const meGrowth = (p, bi, carry) => {
    if (BOUNDARIES[bi] <= p.entryDate) return 1;
    if (p.closed) { if (BOUNDARIES[bi] >= p.exitDate) return 1 + p.ret; }
    else if (bi >= lastBi) return 1 + p.ret;
    const g = p._btMarks.get(bi);
    return g == null ? carry : g;
  };
  // SPY-equivalent: the same money in the S&P over each position's holding window,
  // shaped by SPYCLOSE and pinned so the endpoint equals its realized spyRet.
  const spyGrowth = (p, bi) => {
    if (bi <= p._btEntryBi) return 1;
    if (bi >= p._btExitBi) return 1 + (p.spyRet || 0);
    const den = SPYCLOSE[p._btExitBi] - SPYCLOSE[p._btEntryBi];
    if (!den) return 1;
    return 1 + (p.spyRet || 0) * ((SPYCLOSE[bi] - SPYCLOSE[p._btEntryBi]) / den);
  };

  const firstBi = filtered.reduce((m, p) => Math.min(m, p._btEntryBi), lastBi);
  const pts = [];
  const carry = new Map();
  for (let bi = firstBi; bi <= lastBi; bi++) {
    let me = 0, spy = 0;
    for (const p of filtered) {
      const w = wfn(p) / totalW;
      const g = meGrowth(p, bi, carry.get(p) ?? 1);
      carry.set(p, g);
      me += w * g;
      spy += w * spyGrowth(p, bi);
    }
    pts.push({ d: BOUNDARIES[bi], me: me - 1, spy: spy - 1 });
  }
  if (pts.length < 2) return '<div class="note">Not enough history to draw a curve yet.</div>';

  const W = 700, H = 240, padL = 44, padB = 26, padT = 12, padR = 12;
  const ys = pts.flatMap((p) => [p.me, p.spy]).filter((v) => v != null);
  const ymin = Math.min(...ys, 0);
  const ymax = Math.max(...ys, 0);
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * (H - padT - padB);
  const gid = `eq${CHART_SEQ++}`;
  const zeroY = y(0);
  const mePts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.me).toFixed(1)}`).join(' ');
  const spyPts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.spy).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${zeroY.toFixed(1)} ${mePts} ${x(pts.length - 1).toFixed(1)},${zeroY.toFixed(1)}`;
  const grid = [ymin, (ymin + ymax) / 2, ymax]
    .map((v) => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,0.05)"/>`)
    .join('');
  const yticks = [ymin, (ymin + ymax) / 2, ymax]
    .map((v) => `<text x="6" y="${(y(v) + 4).toFixed(1)}" fill="#8b97a7" font-size="11">${(v * 100).toFixed(0)}%</text>`)
    .join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3fb950" stop-opacity="0.32"/>
        <stop offset="1" stop-color="#3fb950" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <polygon fill="url(#${gid})" stroke="none" points="${area}"/>
      <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="#3a4453"/>
      ${yticks}
      <text x="${padL}" y="${H - 8}" fill="#8b97a7" font-size="11">${pts[0].d}</text>
      <text x="${W - padR}" y="${H - 8}" fill="#8b97a7" font-size="11" text-anchor="end">${pts[pts.length - 1].d}</text>
      <polyline fill="none" stroke="#8b97a7" stroke-width="2" points="${spyPts}"/>
      <polyline fill="none" stroke="#56d364" stroke-width="3.5" stroke-opacity="0.22" stroke-linejoin="round" stroke-linecap="round" points="${mePts}"/>
      <polyline fill="none" stroke="#3fb950" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" points="${mePts}"/>
    </svg>
    <div class="legend"><span class="dot" style="background:#3fb950"></span>Copied members &nbsp; <span class="dot" style="background:#8b97a7"></span>S&P 500 — total return of the invested amount, marked to market over time</div>`;
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
  const minTrades = Number($('lbMinTrades').value || 0);
  const stats = memberStatsFiltered({ ...readParams(), chamber: $('lbChamber').value }).filter((m) => m.n >= minTrades);
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

// Min-max normalize each factor across the candidate pool to [0,1] so the weights are
// comparable, then Score = wA·alpha + wC·cons + wK·comm. Mutates each candidate (.score).
function scoreCandidates(cands, wA, wC, wK) {
  if (!cands.length) return;
  const norm = (key) => {
    const vs = cands.map((c) => c[key]);
    const lo = Math.min(...vs), hi = Math.max(...vs), d = hi - lo;
    return (x) => (d ? (x - lo) / d : 0.5);
  };
  const nA = norm('alpha'), nC = norm('cons'), nK = norm('comm');
  for (const c of cands) c.score = wA * nA(c.alpha) + wC * nC(c.cons) + wK * nK(c.comm);
}

// Rules-based, periodically-rebalanced index, measured MARK-TO-MARKET between rebalance
// dates (so returns are non-overlapping and chaining is legitimate — unlike attributing
// each trade's full multi-year return to its entry period and compounding that).
// Each period: pick the top-`n` members by trailing total return over the prior `lookback`
// years (>= `minTrades` trades), then the period's return = weighted price change of that
// roster's positions held during the period. periodMonths = 12 (annual) or 6 (semi-annual);
// boundaries are emitted semi-annually so annual just steps every 2nd boundary.
function buildCongressIndex({ n, minPerMonth, lookback, weighting, periodMonths = 12, minSize = 0, chamber = 'all', wAlpha = 0.5, wCons = 0.3, wComm = 0.2 }) {
  if (!POSITIONS.length || !BOUNDARIES.length) return [];
  const step = Math.max(1, Math.round(periodMonths / 6)); // boundaries per period: 1 (6mo) or 2 (annual)
  const lookbackMonths = lookback * 12;
  const minTrades = Math.max(1, Math.ceil(minPerMonth * lookbackMonths)); // ">=1/month" => 24 over a 2yr lookback
  const isScore = weighting === 'score'; // multi-factor: select + weight members by Score
  const wfn = weighting === 'amount' ? (p) => p.amountLow || 1 : () => 1; // amount/equal modes
  const subWfn = (p) => p.amountLow || 1; // within-member conviction weight in score mode
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
    // Exclude members who had already LEFT office by the period start — a late-disclosed
    // trade (entry = disclosure date) can otherwise float a departed member into the roster
    // via the lookback window (e.g. Perdue left Jan-2021 but Feb-2020 trades disclosed
    // May-2021 put him in 2022-23 rosters). You can't copy a member who's no longer serving.
    const startD = BOUNDARIES[bStart];
    const cands = [...byM.entries()].filter(
      ([member, ps]) => ps.length >= minTrades && !(DEPARTURES[member] && DEPARTURES[member] <= startD)
    );
    // Quota guard: skip a period unless the qualifying pool is at least TWICE the roster size,
    // so "top n" is a genuine selection from a real field — not just holding whoever traded.
    // The early STOCK-Act years have too few members clearing the trade-count bar (through
    // 2015 fewer than ~15 qualify), so those near-random rosters would compound into the chain
    // and distort the result. Requiring 2×n effectively starts the index in 2016 and
    // self-adjusts if n changes.
    if (cands.length < 2 * n) continue;
    let roster, memberWeight = null;
    if (isScore) {
      // Multi-factor Score per member over their lookback trades:
      //   Score = wAlpha·Alpha + wCons·Consistency + wComm·CommitteeRelevance
      // Alpha = mean(ret − spyRet); Consistency = win rate vs S&P; Committee = share of
      // trades whose stock's sector overlaps a committee (ov flag). Each factor is min-max
      // normalized across the candidate pool so the weights are comparable.
      const scored = cands.map(([member, ps]) => {
        const alpha = ps.reduce((a, p) => a + ((p.ret || 0) - (p.spyRet || 0)), 0) / ps.length;
        let wins = 0, wn = 0;
        for (const p of ps) if (p.ret != null && p.spyRet != null) { wn++; if (p.ret > p.spyRet) wins++; }
        const cons = wn ? wins / wn : 0;
        let ovSum = 0, ovN = 0;
        for (const p of ps) if (p.ov === 0 || p.ov === 1) { ovN++; ovSum += p.ov; }
        const comm = ovN ? ovSum / ovN : 0;
        return { member, alpha, cons, comm, n: ps.length };
      });
      scoreCandidates(scored, wAlpha, wCons, wComm); // adds .score
      roster = scored.sort((a, b) => b.score - a.score).slice(0, n);
      const maxS = Math.max(0, ...roster.map((x) => x.score));
      memberWeight = new Map(roster.map((x) => [x.member, maxS > 0 ? x.score : 1])); // fallback equal
      for (const x of roster) x.ret = x.alpha; // chip tooltip shows alpha as the headline factor
    } else {
      roster = cands
        .map(([member, ps]) => ({ member, ret: wmean(ps, (p) => p.ret, wfn), n: ps.length }))
        .filter((x) => x.ret != null)
        .sort((a, b) => b.ret - a.ret)
        .slice(0, n);
    }
    const names = new Set(roster.map((x) => x.member));
    const endD = BOUNDARIES[bEnd];
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
    // Each roster member's ACTUAL return during this period (what they contributed),
    // so the chips reconcile with the period total — distinct from x.ret, the trailing
    // selection metric. null = member held nothing this period (inactive).
    const pw = isScore ? subWfn : wfn; // within-member position weighting
    const heldByMember = new Map();
    for (const h of held) {
      if (!heldByMember.has(h.p.member)) heldByMember.set(h.p.member, []);
      heldByMember.get(h.p.member).push(h);
    }
    for (const x of roster) {
      const hs = heldByMember.get(x.member);
      x.pret = hs && hs.length ? wmean(hs, (h) => h.r, (h) => pw(h.p)) : null;
    }
    // Period return: score mode weights each member by their Score; else weight positions
    // directly by amount/equal.
    let ret;
    if (isScore) {
      let sw = 0, s = 0;
      for (const [m, hs] of heldByMember) {
        const w = memberWeight.get(m) || 0;
        if (w <= 0) continue;
        const r = wmean(hs, (h) => h.r, (h) => subWfn(h.p));
        if (r == null) continue;
        s += w * r;
        sw += w;
      }
      ret = sw ? s / sw : null;
    } else {
      ret = held.length ? wmean(held, (h) => h.r, (h) => wfn(h.p)) : null;
    }
    // Each member's SHARE of the period's weighting (for tooltips): dollars in amount
    // mode, position count in equal mode, Score in multi-factor mode. Explains how a
    // few big-$ positions can swing the total against the raw win/loss headcount.
    let totW = 0;
    const mW = new Map();
    for (const [m, hs] of heldByMember) {
      const w = isScore ? (memberWeight.get(m) || 0) : hs.reduce((s, h) => s + wfn(h.p), 0);
      mW.set(m, w);
      totW += w;
    }
    for (const x of roster) x.weight = totW ? (mW.get(x.member) || 0) / totW : 0;
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
function levelChart(pts, fmtY) {
  const W = 700, H = 240, padL = 48, padB = 26, padT = 12, padR = 12;
  const f = fmtY || ((v) => Math.round(v).toLocaleString());
  const ymax = Math.max(...pts.flatMap((p) => [p.idx, p.spy]), 1);
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / ymax) * (H - padT - padB);
  const gid = `lv${CHART_SEQ++}`;
  const base = y(0);
  const idxPts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.idx).toFixed(1)}`).join(' ');
  const spyPts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.spy).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${base.toFixed(1)} ${idxPts} ${x(pts.length - 1).toFixed(1)},${base.toFixed(1)}`;
  const grid = [0, ymax / 2, ymax].map((v) => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,0.05)"/>`).join('');
  const yticks = [0, ymax / 2, ymax].map((v) => `<text x="6" y="${(y(v) + 4).toFixed(1)}" fill="#8b97a7" font-size="11">${f(v)}</text>`).join('');
  const every = Math.ceil(pts.length / 12); // thin labels when crowded (e.g. semi-annual)
  const xlabels = pts
    .map((p, i) => (i % every === 0 || i === pts.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="#8b97a7" font-size="11" text-anchor="middle">${p.label}</text>` : ''))
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fb950" stop-opacity="0.3"/><stop offset="1" stop-color="#3fb950" stop-opacity="0"/></linearGradient></defs>` +
    `${grid}<polygon fill="url(#${gid})" stroke="none" points="${area}"/>${yticks}${xlabels}` +
    `<polyline fill="none" stroke="#8b97a7" stroke-width="2" points="${spyPts}"/>` +
    `<polyline fill="none" stroke="#56d364" stroke-width="4" stroke-opacity="0.2" stroke-linejoin="round" stroke-linecap="round" points="${idxPts}"/>` +
    `<polyline fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${idxPts}"/></svg>`;
}

function renderCongressIndex() {
  if (!POSITIONS.length) return;
  const invest = Math.max(0, Number($('ciInvest').value || 10000));
  const n = Math.max(1, Number($('ciN').value || 10));
  const minPerMonth = Math.max(0, Number($('ciMin').value || 1));
  const lookback = Math.max(1, Number($('ciLook').value || 2));
  const weighting = $('ciWeight').value;
  const periodMonths = Number($('ciRebalance').value || 6);
  const minSize = Math.max(0, Number($('ciMinSize').value || 0));
  const chamber = $('ciChamber').value;
  const showStats = $('ciStats').checked;
  const wAlpha = Math.max(0, Number($('ciWAlpha').value || 0));
  const wCons = Math.max(0, Number($('ciWCons').value || 0));
  const wComm = Math.max(0, Number($('ciWComm').value || 0));
  // show/hide the factor-weight controls in score mode
  const fw = document.getElementById('ciFactorWeights');
  if (fw) fw.style.display = weighting === 'score' ? '' : 'none';
  const rows = buildCongressIndex({ n, minPerMonth, lookback, weighting, periodMonths, minSize, chamber, wAlpha, wCons, wComm }).filter((r) => r.ret != null);
  const el = $('ci');
  if (rows.length < 1) {
    el.innerHTML = '<div class="note">Not enough data for these settings — try fewer min trades or members.</div>';
    return;
  }
  const last = rows[rows.length - 1];
  const beat = last.spyLevel ? last.level / last.spyLevel - 1 : null; // % the index beat the S&P by
  // Dollar view: a level of 100 = the starting investment, so $ value = invest * level/100.
  const toUSD = (level) => (invest * level) / 100;
  const congVal = toUSD(last.level); // what the index turned $invest into
  const spyVal = toUSD(last.spyLevel); // what the S&P turned the same into
  const profit = congVal - invest;
  const beatUSD = congVal - spyVal; // $ ahead of the S&P
  const pts = [{ label: 'start', idx: invest, spy: invest }, ...rows.map((r) => ({ label: r.label, idx: toUSD(r.level), spy: toUSD(r.spyLevel) }))];
  // Compact $ axis labels: $10k, $64k, $1.2M.
  const fmtAxis = (v) =>
    v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$' + Math.round(v);
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
      <div class="card"><div class="k">Invested</div><div class="v">${fmtUSD(invest)}</div></div>
      <div class="card"><div class="k">Congress Index now</div><div class="v ${profit >= 0 ? 'pos' : 'neg'}">${fmtUSD(congVal)}</div></div>
      <div class="card"><div class="k">S&P 500 now</div><div class="v">${fmtUSD(spyVal)}</div></div>
      <div class="card"><div class="k">Profit / loss</div><div class="v ${profit >= 0 ? 'pos' : 'neg'}">${profit >= 0 ? '+' : ''}${fmtUSD(profit)}</div></div>
      <div class="card"><div class="k">vs S&P 500</div><div class="v ${beat >= 0 ? 'pos' : 'neg'}">${beat != null ? (beat >= 0 ? '+' : '') + (beat * 100).toFixed(0) + '%' : 'n/a'} <span style="font-size:12px;color:var(--muted)">(${beatUSD >= 0 ? '+' : ''}${fmtUSD(beatUSD)})</span></div></div>
      <div class="card"><div class="k">${periodWord}</div><div class="v">${rows.length}</div></div>
    </div>
    ${levelChart(pts, fmtAxis)}
    <div class="legend"><span class="dot" style="background:#3fb950"></span>Congress Index &nbsp; <span class="dot" style="background:#8b97a7"></span>S&P 500 — value of ${fmtUSD(invest)} invested at the start</div>
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
              const why =
                weighting === 'score' && x.score != null
                  ? `Score ${x.score.toFixed(2)} (alpha ${fmtPct(x.alpha)} · win ${(x.cons * 100).toFixed(0)}% · committee ${(x.comm * 100).toFixed(0)}%)`
                  : `picked on ${fmtPct(x.ret)} trailing return`;
              const wtxt = x.weight >= 0.01 ? `${Math.round(x.weight * 100)}%` : '<1%';
              const share = x.pret == null ? 'held nothing' : `${fmtPct(x.pret)}, ${wtxt} of index weight`;
              const tip = `${x.member} — this period ${share}; ${why}; click to backtest`;
              return `<button type="button" class="rchip" data-member="${esc(x.member)}" title="${esc(tip)}">${i + 1}. ${esc(x.member)} ${val}</button>`;
            })
            .join('')}
        </div></details>`
      )
      .join('')}
    ${
      weighting === 'score'
        ? `<div class="note"><b>Multi-factor weighting:</b> each member's index weight = Score = ${wAlpha}·Alpha + ${wCons}·Consistency + ${wComm}·Committee, where Alpha = trailing return above the S&P, Consistency = win rate vs the S&P, and Committee = share of their trades whose sector overlaps a committee they sit on. Each factor is normalized across the roster. Committee data is current-day &amp; fills in as sector data warms (it may read ~0 early).</div>`
        : ''
    }
    <div class="note">Each member chip shows that member's return <i>during that period</i> — hover for their share of the index weight (dollar-weighted, so a few large trades can move the total more than the win/loss headcount) and why they were picked. Click any member to backtest just their trades, or “Backtest all” to load the whole roster into the backtester below. Backtest only — the roster is chosen <i>because</i> it performed well, so past results don't predict the future. Returns are marked-to-market between rebalance dates, vs the real S&P over the same dates; per-period moves are capped at ±~150%. When a member leaves office their unsold positions are closed at the price on their last day served (not marked to market forever).</div>`;
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
    DEPARTURES = data.departures || {};
    SPYCLOSE = data.spy || [];
    const cov = data.coverage; // { positions, priced, unpriced, coverage } or null
    const covPct = cov && cov.coverage != null ? ` · ${(cov.coverage * 100).toFixed(0)}% price coverage` : '';
    $('meta').textContent = `${POSITIONS.length} priced positions${covPct} · updated ${(data.generatedAt || '').slice(0, 10)}`;
    if (cov && cov.unpriced) {
      $('meta').title =
        `${cov.unpriced} of ${cov.positions} positions are excluded for missing prices. ` +
        `Excluded positions count toward no return — a lower coverage means more survivorship risk.`;
    }
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
$('lbMinTrades').onchange = renderLeaderboard;
['ciInvest', 'ciN', 'ciMin', 'ciLook', 'ciWeight', 'ciRebalance', 'ciStats', 'ciMinSize', 'ciChamber', 'ciWAlpha', 'ciWCons', 'ciWComm'].forEach((id) => {
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
