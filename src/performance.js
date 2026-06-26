// Performance index for the alerts: the "copyable return" of following each buy.
//
// Entry = the disclosure date (first day the public could act). A position is
// closed by the next sell of the same member+ticker (FIFO, equal-weight: each buy
// is one unit, each sell closes the oldest open buy). Open positions are marked to
// the latest close. Reports a number per member + one total, vs an SPY benchmark.
//
// Sources: data/alert_history.json (forward, from recordAlerts) +
// data/tracked_trades.json (backfill). Prices via priceCache (FMP free, cached).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { readState, writeState, writeText } from './stateStore.js';
import { priceClose, priceLatest, savePriceCache, fetchesUsed } from './priceCache.js';
import { getDepartures } from './legislators.js';
import { committeesFor, getProfiles, profile, overlapsFor } from './enrich.js';
import { getHistoricalCommittees } from './committeesHistorical.js';

const BENCH = 'SPY';

// Semi-annual rebalance boundaries (Jan 1 / Jul 1) from the STOCK Act era to today.
// The index front end measures each period's return between consecutive boundaries
// (annual uses every 2nd one), so we emit a price "mark" per position at each boundary.
function semiAnnualBoundaries() {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (let y = 2012; y <= Number(today.slice(0, 4)); y++) {
    for (const mmdd of ['01-01', '07-01']) {
      const d = `${y}-${mmdd}`;
      if (d <= today) out.push(d);
    }
  }
  return out;
}

function normType(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('purchase') || s === 'buy' || s === 'p') return 'buy';
  if (s.includes('sale') || s.includes('sell') || s === 's') return 'sell';
  return 'other';
}

// Normalize member names across sources (mirror "Hon."/middle names, eFD/Clerk
// "First Last", stray "None"/"Honorable") so a member aggregates into one row.
function cleanName(s) {
  return String(s || '')
    .replace(/\b(hon|honorable|mr|mrs|ms|dr|rep|sen|senator|representative|none)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function key(t) {
  return [t.politician, t.type, t.ticker, t.transactionDate, t.disclosureDate, t.amount]
    .join('|')
    .toLowerCase();
}

// "$1,001 - $15,000" -> { low: 1001, high: 15000 }
function parseRange(raw) {
  const nums = String(raw || '').match(/[\d,]+/g);
  if (!nums) return { low: 0, high: 0 };
  const v = nums.map((n) => Number(n.replace(/,/g, '')));
  return { low: v[0] || 0, high: v[1] || v[0] || 0 };
}

// Load + merge both trade sources into a normalized, deduped, sorted list.
async function loadTrades() {
  const hist = await readState('alert_history.json', []);
  const tracked = await readState('tracked_trades.json', []);
  const all = [...hist, ...tracked].map((t) => {
    const r = parseRange(t.amount);
    return {
      politician: cleanName(t.politician) || 'Unknown',
      chamber: t.chamber || '',
      type: normType(t.type),
      ticker: (t.ticker || '').toUpperCase(),
      transactionDate: t.transactionDate || '',
      disclosureDate: t.disclosureDate || t.alertedAt?.slice(0, 10) || '',
      amount: t.amount || '',
      amountLow: r.low,
      amountHigh: r.high,
    };
  });
  const seen = new Set();
  const out = [];
  for (const t of all) {
    if (!t.ticker || (t.type !== 'buy' && t.type !== 'sell') || !t.disclosureDate) continue;
    const k = key(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  out.sort((a, b) => a.disclosureDate.localeCompare(b.disclosureDate));
  return out;
}

// Build positions: one per buy, closed FIFO by a later sell of same member+ticker.
function buildPositions(trades) {
  const open = new Map(); // `${member}|${ticker}` -> [buy, buy, ...]
  const positions = [];
  for (const t of trades) {
    const gk = `${t.politician.toLowerCase()}|${t.ticker}`;
    if (t.type === 'buy') {
      if (!open.has(gk)) open.set(gk, []);
      open.get(gk).push(t);
    } else {
      const q = open.get(gk);
      if (q && q.length) {
        const buy = q.shift();
        positions.push(mkPos(buy, t.disclosureDate, true));
      }
      // a sell with no matching open buy is ignored (we only track buy->sell round trips)
    }
  }
  for (const [, q] of open) {
    for (const buy of q) positions.push(mkPos(buy, null, false));
  }
  return positions;
}

function mkPos(buy, exit, closed) {
  return {
    member: buy.politician,
    chamber: buy.chamber,
    ticker: buy.ticker,
    entry: buy.disclosureDate,
    exit,
    closed,
    amountLow: buy.amountLow,
    amountHigh: buy.amountHigh,
  };
}

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
function avg(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export async function buildPerformance({ maxFetches = Number(process.env.PERF_MAX_FETCHES || 200) } = {}) {
  const trades = await loadTrades();
  const positions = buildPositions(trades);

  // Force-close open positions of members who have LEFT office: you stop copying a
  // member when they leave, so sell at their last day served (otherwise an unsold
  // trade is marked to market forever). Departed members are matched by name.
  const dep = await getDepartures().catch((e) => {
    console.error(`[perf] departures unavailable: ${e.message}`);
    return { departureDate: () => null };
  });
  // Each member's most recent trade — if they kept trading AFTER their supposed
  // departure date, they're clearly still active (stale/odd congress-legislators
  // record, e.g. a House->Senate move), so don't force-close them.
  const lastActivity = new Map();
  for (const p of positions) {
    const cur = lastActivity.get(p.member);
    if (!cur || p.entry > cur) lastActivity.set(p.member, p.entry);
  }
  let forcedClosed = 0;
  for (const p of positions) {
    if (p.closed) continue;
    const d = dep.departureDate(p.member);
    if (d && d > p.entry && d >= (lastActivity.get(p.member) || '')) {
      p.exit = d;
      p.closed = true;
      p.departed = true;
      forcedClosed++;
    }
  }
  console.log(`[perf] force-closed ${forcedClosed} open position(s) of departed members`);

  // Price each position (copyable return) + SPY over the same window. Fetches are
  // lazy + bounded inside priceCache; SPY is pre-warmed so the benchmark resolves.
  // Price RECENT positions first so the limited daily fetch budget reaches 2022+
  // activity (all Senate trades, recent House) instead of being consumed by the
  // older 2020-2022 House backfill.
  await priceClose(BENCH, positions[0]?.entry || '2022-01-03', maxFetches);
  const boundaries = semiAnnualBoundaries();
  const todayStr = new Date().toISOString().slice(0, 10);
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const pricingOrder = [...positions].sort((a, b) => (b.entry || '').localeCompare(a.entry || ''));
  const priced = [];
  let unpriced = 0;
  let openCount = 0;
  for (const p of pricingOrder) {
    if (!p.closed) openCount++;
    const entryPx = await priceClose(p.ticker, p.entry, maxFetches);
    const exitPx = p.closed ? await priceClose(p.ticker, p.exit, maxFetches) : await priceLatest(p.ticker, maxFetches);
    if (entryPx == null || exitPx == null || entryPx === 0) {
      unpriced++;
      continue;
    }
    const ret = exitPx / entryPx - 1;
    const bEntry = await priceClose(BENCH, p.entry, maxFetches);
    const bExit = p.closed ? await priceClose(BENCH, p.exit, maxFetches) : await priceLatest(BENCH, maxFetches);
    const bRet = bEntry && bExit ? bExit / bEntry - 1 : null;
    // Price marks (growth vs entry) at each boundary strictly inside the holding window.
    // The ticker's series is already warm from the entry/exit lookups above, so these
    // resolve from memory with no extra fetches.
    const hardEnd = p.closed ? p.exit : todayStr;
    const marks = [];
    for (let bi = 0; bi < boundaries.length; bi++) {
      const bd = boundaries[bi];
      if (bd <= p.entry) continue;
      if (bd >= hardEnd) break;
      const px = await priceClose(p.ticker, bd, maxFetches);
      if (px != null) marks.push([bi, r4(px / entryPx)]);
    }
    priced.push({ ...p, ret, bRet, marks });
  }
  // SPY close at each boundary (one shared benchmark series for the index).
  const spyClose = [];
  for (const bd of boundaries) {
    const px = await priceClose(BENCH, bd, maxFetches);
    spyClose.push(px == null ? null : Math.round(px * 100) / 100);
  }
  await savePriceCache();

  // Committee-overlap flag per position (feeds the index's committee-relevance factor):
  // 1 = the stock's sector overlaps a committee the member held IN THAT CONGRESS, 0 = no,
  // absent = sector not warmed yet. Committees are period-accurate (per-Congress snapshots);
  // sectors come from FMP, bounded per run (free 250/day cap) so they fill in over ~1-2 days.
  if (config.enrich) {
    try {
      const hist = await getHistoricalCommittees();
      let sectors = await readState('sectors.json', {});
      const SECTOR_MAX = Number(process.env.SECTOR_MAX || 40);
      if (config.providers.fmpKey && SECTOR_MAX > 0) {
        const need = [...new Set(priced.map((p) => p.ticker))].filter((t) => t && !(t in sectors)).slice(0, SECTOR_MAX);
        if (need.length) {
          await getProfiles(need); // fetches + persists data/sectors.json
          sectors = await readState('sectors.json', {});
        }
      }
      for (const p of priced) {
        const prof = profile(sectors[p.ticker]);
        if (!prof.s && !prof.i) continue; // sector unknown -> leave ov absent
        const idx = hist.indexForYear(Number((p.entry || '').slice(0, 4))); // committees as of the trade's Congress
        if (!idx) continue;
        const committees = committeesFor(idx, { chamber: p.chamber, politician: p.member, bioguide: '' });
        p.ov = overlapsFor(committees, `${prof.s} ${prof.i}`.toLowerCase()).length ? 1 : 0;
      }
    } catch (e) {
      console.error(`[perf] committee enrichment skipped: ${e.message}`);
    }
  }

  // Aggregate per member + total.
  const byMember = new Map();
  for (const p of priced) {
    if (!byMember.has(p.member)) byMember.set(p.member, []);
    byMember.get(p.member).push(p.ret);
  }
  const perMember = [...byMember.entries()]
    .map(([member, rets]) => ({ member, positions: rets.length, avgReturn: avg(rets) }))
    .sort((a, b) => b.avgReturn - a.avgReturn);

  const totalReturn = avg(priced.map((p) => p.ret));
  const spyReturn = avg(priced.map((p) => p.bRet).filter((x) => x != null));

  const report = {
    generatedAt: new Date().toISOString(),
    basis: 'copyable return (from disclosure date)',
    totals: {
      positions: positions.length,
      priced: priced.length,
      open: openCount,
      unpriced,
      avgReturn: totalReturn,
      spyAvgReturn: spyReturn,
    },
    perMember,
  };
  await writeState('performance.json', report);
  await writeText('performance.md', renderMarkdown(report));
  await writePositions(priced, boundaries, spyClose);
  return report;
}

// Compact per-position dataset for the in-browser backtester (docs/positions.json).
// `boundaries`/`spy` + per-row `marks` let the Congress Index compute mark-to-market
// returns between rebalance dates (instead of compounding full lifetime returns).
async function writePositions(priced, boundaries, spyClose) {
  const round = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
  const rows = priced.map((p) => ({
    member: p.member,
    chamber: p.chamber || '',
    ticker: p.ticker,
    entryDate: p.entry,
    exitDate: p.exit, // null = still open
    closed: p.closed,
    ret: round(p.ret),
    spyRet: round(p.bRet),
    amountLow: p.amountLow || 0,
    amountHigh: p.amountHigh || 0,
    marks: p.marks || [], // [[boundaryIndex, growthVsEntry], ...]
    ...(p.ov === undefined ? {} : { ov: p.ov }), // committee-sector overlap: 1/0
    ...(p.departed ? { departed: 1 } : {}), // closed because the member left office
  }));
  const out = { generatedAt: new Date().toISOString(), boundaries, spy: spyClose, positions: rows };
  const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, 'positions.json'), JSON.stringify(out));
}

// Human-readable report — open data/performance.md in anything.
function renderMarkdown(r) {
  const t = r.totals;
  const lines = [
    '# Congressional Trade Performance Index',
    '',
    `_Copyable return — measured from each trade's disclosure date. Generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC._`,
    '',
    `## Total`,
    '',
    `- **Index (all tracked buys): ${pct(t.avgReturn)}**`,
    `- S&P 500 (SPY) over the same windows: ${pct(t.spyAvgReturn)}`,
    `- Priced positions: ${t.priced}  ·  still open: ${t.open}  ·  awaiting price data: ${t.unpriced}`,
    '',
    `## By member (average return, # positions)`,
    '',
    '| Member | Avg return | Positions |',
    '| --- | ---: | ---: |',
    ...r.perMember.map((m) => `| ${m.member} | ${pct(m.avgReturn)} | ${m.positions} |`),
    '',
    '_Equal-weighted; end-of-day prices. Not financial advice._',
  ];
  return lines.join('\n');
}

function printReport(r) {
  console.log('\n📊 Performance index — copyable return (from disclosure date)');
  console.log('────────────────────────────────────────────────────────');
  console.log(
    `TOTAL: ${pct(r.totals.avgReturn)} across ${r.totals.priced} priced position(s)  |  SPY: ${pct(
      r.totals.spyAvgReturn
    )}`
  );
  console.log(`(${r.totals.open} still open, ${r.totals.unpriced} unpriced/pending price data)\n`);
  console.log('Per member (avg return, # positions):');
  for (const m of r.perMember.slice(0, 30)) {
    console.log(`  ${pct(m.avgReturn).padStart(7)}  (${m.positions})  ${m.member}`);
  }
  if (r.perMember.length > 30) console.log(`  …and ${r.perMember.length - 30} more`);
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('performance.js')) {
  buildPerformance()
    .then((r) => {
      printReport(r);
      console.log(`\n(price fetches used this run: ${fetchesUsed()})`);
    })
    .catch((e) => {
      console.error('performance failed:', e.message);
      process.exit(1);
    });
}
