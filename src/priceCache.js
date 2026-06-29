// EOD price lookups for the performance index, cached compactly.
//
// Prices come from Yahoo Finance's chart API — free, no key, no daily quota
// (FMP's free tier capped us at ~250/day, which starved Senate/recent tickers).
// One call returns a ticker's whole daily history; we fetch it once per ticker
// per run (into memory) but PERSIST only the dates a position actually needs
// (entry/exit/latest), keeping data/price_cache.json small + stable.
//
// Persisted shape: { [TICKER]: { d: { 'YYYY-MM-DD': close }, latest, latestDate, miss? } }
//
// Throttling: Yahoo rate-limits (HTTP 429) after a few thousand requests per IP.
// Two design choices keep a run productive under that limit:
//   1. A 429/5xx is retried with backoff and does NOT count against maxFetches —
//      only a resolved fetch (real data or a genuine empty 200) spends the budget.
//      A run of sustained throttling trips a circuit breaker and stops fetching
//      (rather than burning the whole budget on 429s or hanging for hours).
//   2. priceLatest reuses a recently-persisted `latest` instead of re-fetching every
//      open position's series each run — that re-fetch was eating the budget before
//      it ever reached the old uncached backlog.

import { readState, writeState } from './stateStore.js';

const CACHE = 'price_cache.json';
const FROM = process.env.PRICE_FROM || '2012-01-01'; // STOCK Act era; override to limit history
const P1 = Math.floor(Date.parse(FROM + 'T00:00:00Z') / 1000);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How many calendar days a persisted `latest` may be before we refresh it. Open
// positions are marked to `latest`; a few days' staleness is immaterial for the
// index and saves thousands of redundant fetches per run.
const LATEST_FRESH_DAYS = Number(process.env.PRICE_LATEST_FRESH_DAYS || 4);
// Consecutive fully-throttled tickers after which we assume Yahoo has blocked this
// IP for the run and stop trying (so the job ends instead of hanging on 429s).
const THROTTLE_LIMIT = Number(process.env.PRICE_THROTTLE_LIMIT || 40);

let mem = null; // persisted cache (loaded once)
const series = new Map(); // ticker -> full {date:close} for THIS run (not persisted)
let fetched = 0;
let throttleStreak = 0;
let blocked = false; // circuit breaker: Yahoo is hard-throttling this run

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

function freshEnough(dateStr) {
  if (!dateStr) return false;
  const age = (Date.now() - Date.parse(dateStr + 'T00:00:00Z')) / 86400000;
  return age >= 0 && age <= LATEST_FRESH_DAYS;
}

// Fetch + parse a ticker's series from Yahoo. Returns one of:
//   { ok:true, map, latest, latestDate } | { miss:true } | { throttled:true }
// 429/5xx are retried with exponential backoff before giving up as throttled.
async function fetchSeries(ticker) {
  const p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?period1=${P1}&period2=${p2}&interval=1d`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429 || r.status >= 500) {
        await sleep(700 * Math.pow(3, attempt) + Math.floor(Math.random() * 400)); // 0.7s,2.1s,6.3s,19s
        continue;
      }
      await sleep(90); // be polite to Yahoo on success
      if (!r.ok) return { miss: false }; // other 4xx — transient-ish, don't tombstone
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      const ts = res && res.timestamp;
      const ind = res && res.indicators;
      const closes =
        (ind && ind.adjclose && ind.adjclose[0] && ind.adjclose[0].adjclose) ||
        (ind && ind.quote && ind.quote[0] && ind.quote[0].close);
      if (!ts || !closes || !ts.length) return { miss: true }; // genuine no-data (bad/delisted)
      const map = {};
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (c == null) continue;
        map[new Date(ts[i] * 1000).toISOString().slice(0, 10)] = Math.round(c * 100) / 100;
      }
      const dates = Object.keys(map).sort();
      if (!dates.length) return { miss: true };
      const latestDate = dates[dates.length - 1];
      return { ok: true, map, latest: map[latestDate], latestDate };
    } catch {
      await sleep(500 * (attempt + 1)); // network error — brief backoff, retry
    }
  }
  return { throttled: true }; // exhausted retries on 429/5xx/network
}

// Load a ticker's full daily history into memory (once per run). A 429-throttled
// ticker returns null WITHOUT spending the budget or being tombstoned, so it can
// retry on a later run; sustained throttling trips the circuit breaker.
async function ensureSeries(ticker, maxFetches) {
  if (series.has(ticker)) return series.get(ticker);
  const e = entry(ticker);
  if (e.miss) return null;
  if (blocked) return null;
  if (fetched >= maxFetches) return null;

  const res = await fetchSeries(ticker);
  if (res.throttled) {
    if (++throttleStreak >= THROTTLE_LIMIT) {
      blocked = true;
      console.warn(`[priceCache] Yahoo throttling persistently — stopping fetches for this run after ${fetched} priced`);
    }
    return null; // transient: don't count, don't tombstone
  }
  throttleStreak = 0;
  fetched++; // a real resolved attempt — counts against the budget
  if (res.miss) {
    e.miss = true;
    return null;
  }
  if (!res.ok) return null;
  series.set(ticker, res.map);
  e.latest = res.latest;
  e.latestDate = res.latestDate;
  return res.map;
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

// Latest close (for marking open positions to market). Reuses a recently-persisted
// `latest` without a fetch so open positions don't re-fetch their series every run —
// that frees the fetch budget for uncached/old tickers.
export async function priceLatest(ticker, maxFetches = Infinity) {
  if (!ticker) return null;
  await load();
  const e = entry(ticker);
  if (series.has(ticker)) return e.latest ?? null; // already fetched this run
  if (e.latest != null && freshEnough(e.latestDate)) return e.latest; // recent enough — skip fetch
  const map = await ensureSeries(ticker, maxFetches);
  if (!map) return e.latest ?? null; // throttled/miss — fall back to last known
  return e.latest ?? null;
}
