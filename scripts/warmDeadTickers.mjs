// Warm the price cache for delisted/acquired tickers via Tiingo, so the next index
// build prices them from cache. Surgical: touches ONLY tickers Yahoo has purged, so
// the whole Tiingo quota goes to recovery (not the recent backlog). Mirrors the dates
// buildPerformance needs per position: entry, exit (or latest), and in-window boundaries.
// Tiingo's free tier (~50 symbols/hr) may cap a run — just re-run; it resumes.
//   node scripts/warmDeadTickers.mjs
import { loadTrades } from '../src/performance.js';
import { readState } from '../src/stateStore.js';
import { canonicalTicker } from '../src/tickerAliases.js';
import { priceClose, priceLatest, savePriceCache, fetchesUsed, tiingoUsed } from '../src/priceCache.js';

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

const cache = await readState('price_cache.json', {});
const trades = await loadTrades();
const tradedCanon = new Set(trades.map((t) => canonicalTicker(t.ticker)));
// Dead set = Yahoo-purged tickers (tombstoned `miss`) that are NOT auto-remappable and
// appear in trades. Precise on purpose: a Yahoo miss is one quick request, so this won't
// trip Yahoo's throttle breaker before the Tiingo fallback runs. e.tnf = Tiingo also empty.
const dead = new Set();
for (const [tk, e] of Object.entries(cache)) {
  if (!e || !e.miss || e.tnf) continue;
  if (canonicalTicker(tk) !== tk || !tradedCanon.has(tk)) continue;
  dead.add(tk);
}
console.log(`dead tickers to warm: ${dead.size}`);
// Rebuild FIFO positions (same rule as performance.buildPositions) but only for dead tickers.
const open = new Map();
const positions = [];
for (const t of trades) {
  if (!dead.has(canonicalTicker(t.ticker))) continue;
  const gk = `${t.politician.toLowerCase()}|${t.ticker}`;
  if (t.type === 'buy') {
    if (!open.has(gk)) open.set(gk, []);
    open.get(gk).push(t);
  } else {
    const q = open.get(gk);
    if (q && q.length) {
      const b = q.shift();
      positions.push({ ticker: b.ticker, entry: b.disclosureDate, exit: t.disclosureDate, closed: true });
    }
  }
}
for (const [, q] of open) for (const b of q) positions.push({ ticker: b.ticker, entry: b.disclosureDate, exit: null, closed: false });
console.log(`positions in dead tickers: ${positions.length}`);

// Group positions by ticker so one Tiingo fetch (memoized per run) covers all of a
// ticker's positions, and we can save after each ticker — progress survives a timeout
// or an hourly-cap stop partway through.
const byTicker = new Map();
for (const p of positions) {
  if (!byTicker.has(p.ticker)) byTicker.set(p.ticker, []);
  byTicker.get(p.ticker).push(p);
}
const boundaries = semiAnnualBoundaries();
const today = new Date().toISOString().slice(0, 10);
let priced = 0, unresolved = 0, processed = 0;
let lastTiingo = 0;
for (const [, ps] of byTicker) {
  for (const p of ps) {
    const entryPx = await priceClose(p.ticker, p.entry);
    const exitPx = p.closed ? await priceClose(p.ticker, p.exit) : await priceLatest(p.ticker);
    if (entryPx == null || exitPx == null) unresolved++;
    else priced++;
    const hardEnd = p.closed ? p.exit : today; // in-window boundary marks for the Congress Index
    for (const bd of boundaries) {
      if (bd <= p.entry) continue;
      if (bd >= hardEnd) break;
      await priceClose(p.ticker, bd);
    }
  }
  processed++;
  if (processed % 10 === 0) {
    await savePriceCache();
    console.log(`  …${processed}/${byTicker.size} tickers, ${tiingoUsed()} Tiingo recoveries`);
  }
  // If Tiingo stopped recovering (hourly cap) after some successes, stop early and save —
  // re-run later to resume. Detect: several tickers in a row with no new recovery.
  if (tiingoUsed() === lastTiingo && tiingoUsed() > 0 && processed > tiingoUsed() + 5) {
    console.log('  Tiingo appears rate-limited — stopping early, re-run to resume.');
    break;
  }
  lastTiingo = tiingoUsed();
}
await savePriceCache();
console.log(`warmed: ${priced} priced, ${unresolved} still unresolved | Yahoo fetches ${fetchesUsed()}, Tiingo recoveries ${tiingoUsed()}`);
