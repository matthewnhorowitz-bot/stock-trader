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

// --- boot --------------------------------------------------------------------
async function boot() {
  try {
    const res = await fetch('./positions.json', { cache: 'no-store' });
    const data = await res.json();
    POSITIONS = data.positions || [];
    $('meta').textContent = `${POSITIONS.length} priced positions · updated ${(data.generatedAt || '').slice(0, 10)}`;
    refreshMemberUI();
    renderLeaderboard();
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
$('run').onclick = runBacktest;
boot();
