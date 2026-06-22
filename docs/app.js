'use strict';

let POSITIONS = [];
const selected = new Set();

const $ = (id) => document.getElementById(id);
const pctClass = (x) => (x >= 0 ? 'pos' : 'neg');
const fmtPct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

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

function renderMembers() {
  const q = $('search').value.trim().toLowerCase();
  const stats = memberStats().filter((s) => s.member.toLowerCase().includes(q));
  const el = $('members');
  el.innerHTML = '';
  for (const s of stats) {
    const div = document.createElement('div');
    div.className = 'member';
    div.innerHTML = `<input type="checkbox" style="width:auto" ${selected.has(s.member) ? 'checked' : ''}/>
      <span class="nm">${s.member}</span>
      <span class="stat">${s.count} · <span class="${pctClass(s.avg)}">${fmtPct(s.avg)}</span></span>`;
    div.onclick = (e) => {
      if (e.target.tagName !== 'INPUT') {
        const cb = div.querySelector('input');
        cb.checked = !cb.checked;
      }
      const cb = div.querySelector('input');
      if (cb.checked) selected.add(s.member);
      else selected.delete(s.member);
    };
    el.appendChild(div);
  }
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

  const wfn = weighting === 'amount' ? (p) => p.amountLow || 1 : () => 1;
  const total = wmean(filtered, (p) => p.ret, wfn);
  const spy = wmean(filtered, (p) => p.spyRet, wfn);
  const openN = filtered.filter((p) => !p.closed).length;

  // per member
  const byM = new Map();
  for (const p of filtered) {
    if (!byM.has(p.member)) byM.set(p.member, []);
    byM.get(p.member).push(p);
  }
  const perMember = [...byM.entries()]
    .map(([member, ps]) => ({ member, n: ps.length, avg: wmean(ps, (p) => p.ret, wfn) }))
    .sort((a, b) => b.avg - a.avg);

  renderResults(filtered, total, spy, openN, perMember, wfn);
}

function renderResults(filtered, total, spy, openN, perMember, wfn) {
  const r = $('results');
  if (!filtered.length) {
    r.innerHTML = '<div class="note">No positions match. Try selecting more members or widening the filters (most positions are still awaiting price data, which fills in over the next 1–2 weeks).</div>';
    return;
  }
  const beat = total != null && spy != null ? total - spy : null;
  r.innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">Index return</div><div class="v ${pctClass(total)}">${fmtPct(total)}</div></div>
      <div class="card"><div class="k">S&P 500 (SPY)</div><div class="v ${pctClass(spy)}">${fmtPct(spy)}</div></div>
      <div class="card"><div class="k">vs S&P 500</div><div class="v ${pctClass(beat)}">${beat >= 0 ? '+' : ''}${fmtPct(beat)}</div></div>
      <div class="card"><div class="k">Positions</div><div class="v">${filtered.length}<span style="font-size:13px;color:var(--muted)"> (${openN} open)</span></div></div>
    </div>
    ${equityCurve(filtered, wfn)}
    <h2 style="margin-top:18px;">By member</h2>
    <table>
      <thead><tr><th>Member</th><th class="num">Avg return</th><th class="num"># trades</th></tr></thead>
      <tbody>
        ${perMember.map((m) => `<tr><td>${m.member}</td><td class="num ${pctClass(m.avg)}">${fmtPct(m.avg)}</td><td class="num">${m.n}</td></tr>`).join('')}
      </tbody>
    </table>
    <div class="note">Copyable return: buy at each trade's disclosure date, sell when they sell (open positions marked to the latest price). Equal/size-weighted; end-of-day prices. Not financial advice.</div>`;
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

// --- boot --------------------------------------------------------------------
async function boot() {
  try {
    const res = await fetch('./positions.json', { cache: 'no-store' });
    const data = await res.json();
    POSITIONS = data.positions || [];
    $('meta').textContent = `${POSITIONS.length} priced positions · updated ${(data.generatedAt || '').slice(0, 10)}`;
    renderMembers();
  } catch (e) {
    $('members').innerHTML = `<div class="note">Could not load data: ${e.message}</div>`;
  }
}
$('search').oninput = renderMembers;
$('selAll').onclick = () => { memberStats().forEach((s) => selected.add(s.member)); renderMembers(); };
$('selNone').onclick = () => { selected.clear(); renderMembers(); };
$('run').onclick = runBacktest;
boot();
