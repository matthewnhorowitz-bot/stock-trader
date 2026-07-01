// Warm the price cache for tickers that have NEVER been fetched (absent from the
// cache entirely) — the opposite of warmDeadTickers.mjs, which only re-tries known
// Yahoo-misses. The whole-portfolio reprice can't reach these within its fetch budget
// (it re-touches already-cached tickers first), so target them directly. Most are live
// symbols Yahoo prices immediately; genuine delistings fall through to the Tiingo
// fallback inside priceClose. Saves after every 10 tickers so progress survives a stop.
//   node scripts/warmUncached.mjs
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

const BUDGET = Number(process.env.WARM_MAX_FETCHES || 4000); // stay under Yahoo's ~5-6k throttle
const cache = await readState('price_cache.json', {});
const trades = await loadTrades();
// Target set = canonical tickers appearing in trades that have NO usable cache data:
// either no entry at all (never fetched) OR an "empty shell" — an entry with no dated
// closes, no `latest`, and no miss/tnf tombstone. Empty shells are left behind when a
// prior run created the entry (priceClose calls entry()) but ran out of fetch budget or
// tripped Yahoo's throttle breaker before fetching, so they were never priced and never
// tombstoned. They need a run whose budget actually reaches them.
function needsWarm(c) {
  const e = cache[c];
  if (!e) return true; // never fetched
  const nd = e.d ? Object.keys(e.d).length : 0;
  return nd === 0 && e.latest == null && !e.miss && !e.tnf; // empty shell
}
const uncached = new Set();
for (const t of trades) {
  const c = canonicalTicker(t.ticker);
  if (!c) continue;
  if (needsWarm(c)) uncached.add(c);
}
console.log(`tickers to warm (uncached + empty-shell): ${uncached.size}`);

// Rebuild FIFO positions (same rule as performance.buildPositions) for uncached tickers only.
const open = new Map();
const positions = [];
for (const t of trades) {
  if (!uncached.has(canonicalTicker(t.ticker))) continue;
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
console.log(`positions in uncached tickers: ${positions.length}`);

const byTicker = new Map();
for (const p of positions) {
  if (!byTicker.has(p.ticker)) byTicker.set(p.ticker, []);
  byTicker.get(p.ticker).push(p);
}
const boundaries = semiAnnualBoundaries();
const today = new Date().toISOString().slice(0, 10);
let priced = 0, unresolved = 0, processed = 0;
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
    console.log(`  …${processed}/${byTicker.size} tickers | ${fetchesUsed()} Yahoo fetches, ${tiingoUsed()} Tiingo recoveries`);
  }
  if (fetchesUsed() >= BUDGET) {
    console.log(`  reached fetch budget (${BUDGET}) — stopping, re-run to resume.`);
    break;
  }
}
await savePriceCache();
console.log(`warmed: ${priced} priced, ${unresolved} still unresolved | Yahoo fetches ${fetchesUsed()}, Tiingo recoveries ${tiingoUsed()}`);
