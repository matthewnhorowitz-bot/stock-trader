// Performance index for the alerts: the "copyable return" of following each buy.
//
// Entry = the disclosure date (first day the public could act). A position is
// closed by the next sell of the same member+ticker (FIFO, equal-weight: each buy
// is one unit, each sell closes the oldest open buy). Open positions are marked to
// the latest close. Reports a number per member + one total, vs an SPY benchmark.
//
// Sources: data/alert_history.json (forward, from recordAlerts) +
// data/tracked_trades.json (backfill). Prices via priceCache (FMP free, cached).

import { config } from './config.js';
import { readState, writeState } from './stateStore.js';
import { priceClose, priceLatest, savePriceCache, fetchesUsed } from './priceCache.js';

const BENCH = 'SPY';

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

// Load + merge both trade sources into a normalized, deduped, sorted list.
async function loadTrades() {
  const hist = await readState('alert_history.json', []);
  const tracked = await readState('tracked_trades.json', []);
  const all = [...hist, ...tracked].map((t) => ({
    politician: cleanName(t.politician) || 'Unknown',
    type: normType(t.type),
    ticker: (t.ticker || '').toUpperCase(),
    transactionDate: t.transactionDate || '',
    disclosureDate: t.disclosureDate || t.alertedAt?.slice(0, 10) || '',
    amount: t.amount || '',
  }));
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
        positions.push({ member: buy.politician, ticker: buy.ticker, entry: buy.disclosureDate, exit: t.disclosureDate, closed: true });
      }
      // a sell with no matching open buy is ignored (we only track buy->sell round trips)
    }
  }
  for (const [, q] of open) {
    for (const buy of q) {
      positions.push({ member: buy.politician, ticker: buy.ticker, entry: buy.disclosureDate, exit: null, closed: false });
    }
  }
  return positions;
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

  // Price each position (copyable return) + SPY over the same window. Fetches are
  // lazy + bounded inside priceCache; SPY is pre-warmed so the benchmark resolves.
  await priceClose(BENCH, positions[0]?.entry || '2022-01-03', maxFetches);
  const priced = [];
  let unpriced = 0;
  let openCount = 0;
  for (const p of positions) {
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
    priced.push({ ...p, ret, bRet });
  }
  await savePriceCache();

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
  return report;
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
