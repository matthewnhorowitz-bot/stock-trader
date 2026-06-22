// EOD price lookups for the performance index, cached compactly.
//
// FMP's light endpoint returns a ticker's whole history in ONE call, so we fetch
// that once per ticker per run (into memory) but PERSIST only the specific dates a
// position actually needs (entry/exit/latest). That keeps data/price_cache.json
// small and stable (it would be tens of MB if we stored full histories) while still
// costing ~one FMP call per new ticker. New-ticker fetches are bounded per run to
// stay under the free daily cap; the cache is resumable so coverage fills over runs.
//
// Persisted shape: { [TICKER]: { d: { 'YYYY-MM-DD': close }, latest: close, miss: true? } }

import { config } from './config.js';
import { readState, writeState } from './stateStore.js';

const CACHE = 'price_cache.json';
const FROM = '2019-06-01';

let mem = null; // persisted cache (loaded once)
const series = new Map(); // ticker -> full {date:close} for THIS run (not persisted)
let fetched = 0;

async function load() {
  if (!mem) mem = await readState(CACHE, {});
  return mem;
}
export async function savePriceCache() {
  if (mem) await writeState(CACHE, mem);
}
export function fetchesUsed() {
  return fetched;
}

function entry(ticker) {
  if (!mem[ticker]) mem[ticker] = { d: {} };
  return mem[ticker];
}

// Load a ticker's full history into memory (once per run), respecting the budget.
// Returns the series map or null (miss / out of budget).
async function ensureSeries(ticker, maxFetches) {
  if (series.has(ticker)) return series.get(ticker);
  const e = entry(ticker);
  if (e.miss) return null;
  if (fetched >= maxFetches) return null;
  fetched++;
  try {
    const url = `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${encodeURIComponent(
      ticker
    )}&from=${FROM}&apikey=${config.providers.fmpKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      e.miss = true;
      return null;
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) {
      e.miss = true;
      return null;
    }
    const map = {};
    for (const row of rows) if (row && row.date && row.price != null) map[row.date] = row.price;
    series.set(ticker, map);
    // record latest close now (cheap, useful for open positions)
    const dates = Object.keys(map).sort();
    e.latest = map[dates[dates.length - 1]];
    return map;
  } catch {
    e.miss = true;
    return null;
  }
}

function nearestOnOrAfter(map, date) {
  if (map[date] != null) return map[date];
  const start = new Date(date + 'T00:00:00Z');
  for (let i = 1; i <= 10; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    if (map[d] != null) return map[d];
  }
  return null;
}

// Closing price on/after `date`; persists just that resolved point. null if unavailable.
export async function priceClose(ticker, date, maxFetches = Infinity) {
  if (!ticker || !date) return null;
  await load();
  const e = entry(ticker);
  if (e.d[date] != null) return e.d[date]; // already resolved & persisted
  const map = await ensureSeries(ticker, maxFetches);
  if (!map) return null;
  const px = nearestOnOrAfter(map, date);
  if (px != null) e.d[date] = px; // persist only what we needed
  return px;
}

// Latest close (for marking open positions to market).
export async function priceLatest(ticker, maxFetches = Infinity) {
  if (!ticker) return null;
  await load();
  const e = entry(ticker);
  if (e.latest != null && series.has(ticker)) return e.latest;
  const map = await ensureSeries(ticker, maxFetches);
  if (!map) return e.latest ?? null; // fall back to a previously stored latest
  return e.latest ?? null;
}
