// EOD price lookups for the performance index, cached compactly.
//
// Prices come from Yahoo Finance's chart API — free, no key, no daily quota
// (FMP's free tier capped us at ~250/day, which starved Senate/recent tickers).
// One call returns a ticker's whole daily history; we fetch it once per ticker
// per run (into memory) but PERSIST only the dates a position actually needs
// (entry/exit/latest), keeping data/price_cache.json small + stable.
//
// Persisted shape: { [TICKER]: { d: { 'YYYY-MM-DD': close }, latest, miss? } }

import { readState, writeState } from './stateStore.js';

const CACHE = 'price_cache.json';
const FROM = process.env.PRICE_FROM || '2012-01-01'; // STOCK Act era; override to limit history
const P1 = Math.floor(Date.parse(FROM + 'T00:00:00Z') / 1000);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Load a ticker's full daily history from Yahoo into memory (once per run).
async function ensureSeries(ticker, maxFetches) {
  if (series.has(ticker)) return series.get(ticker);
  const e = entry(ticker);
  if (e.miss) return null;
  if (fetched >= maxFetches) return null;
  fetched++;
  try {
    const p2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?period1=${P1}&period2=${p2}&interval=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    await sleep(90); // be polite to Yahoo
    if (!r.ok) return null; // transient (429/5xx) — don't tombstone, retry later
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    const ts = res && res.timestamp;
    const ind = res && res.indicators;
    const closes =
      (ind && ind.adjclose && ind.adjclose[0] && ind.adjclose[0].adjclose) ||
      (ind && ind.quote && ind.quote[0] && ind.quote[0].close);
    if (!ts || !closes || !ts.length) {
      e.miss = true; // genuine no-data (bad/delisted symbol)
      return null;
    }
    const map = {};
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      map[new Date(ts[i] * 1000).toISOString().slice(0, 10)] = Math.round(c * 100) / 100;
    }
    if (!Object.keys(map).length) {
      e.miss = true;
      return null;
    }
    series.set(ticker, map);
    const dates = Object.keys(map).sort();
    e.latest = map[dates[dates.length - 1]];
    return map;
  } catch {
    return null; // network error — transient, don't tombstone
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
  if (e.d[date] != null) return e.d[date];
  const map = await ensureSeries(ticker, maxFetches);
  if (!map) return null;
  const px = nearestOnOrAfter(map, date);
  if (px != null) e.d[date] = px;
  return px;
}

// Latest close (for marking open positions to market).
export async function priceLatest(ticker, maxFetches = Infinity) {
  if (!ticker) return null;
  await load();
  const e = entry(ticker);
  if (e.latest != null && series.has(ticker)) return e.latest;
  const map = await ensureSeries(ticker, maxFetches);
  if (!map) return e.latest ?? null;
  return e.latest ?? null;
}
