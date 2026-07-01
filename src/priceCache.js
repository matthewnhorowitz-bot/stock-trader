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
import { canonicalTicker, isRemapped } from './tickerAliases.js';
import { manualClose, manualLatest } from './manualPrices.js';
import { fetchTiingoSeries, tiingoEnabled } from './sources/tiingo.js';

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
// Backlog-drain mode: reuse ANY cached `latest` (no refresh fetch) so the whole
// fetch budget targets genuinely-uncached tickers. Used by the one-off reprice to
// reach the old 2012-2019 tail before Yahoo throttles the IP; the hourly notifier
// leaves this off so open positions keep marking to a current price.
const SKIP_LATEST_REFRESH = process.env.PRICE_SKIP_LATEST_REFRESH === '1';

let mem = null; // persisted cache (loaded once)
const series = new Map(); // ticker -> full {date:close} for THIS run (not persisted)
const notThisRun = new Set(); // tickers that failed to resolve this run (don't re-fetch)
let fetched = 0;
let tiingoHits = 0; // tickers recovered from Tiingo after a Yahoo miss
let throttleStreak = 0;
let blocked = false; // circuit breaker: Yahoo is hard-throttling this run

async function load() {
  if (!mem) {
    mem = await readState(CACHE, {});
    // One-time: retire "miss" tombstones for tickers that now canonicalize to a
    // different symbol (BF.B->BF-B, KORS->CPRI, ...). They were tombstoned as dead
    // before symbol normalization existed; dropping the tombstone lets them re-fetch
    // (or resolve from the successor's already-cached series). Self-canonical dead
    // tickers (WFM, LNKD, ...) keep their tombstone, so no wasted re-fetch.
    let retired = 0;
    for (const k of Object.keys(mem)) {
      const e = mem[k];
      if (!e || !e.miss) continue;
      if (isRemapped(k)) {
        delete mem[k]; // resolves under the canonical/successor symbol instead
        retired++;
      }
      // Other "miss" tickers keep their tombstone: it's the permanent record that Yahoo
      // has no data. ensureSeries still tries the Tiingo fallback on each miss ticker
      // (until e.tnf marks Tiingo empty too), so they recover without losing the marker.
    }
    if (retired) console.log(`[priceCache] retired ${retired} stale tombstone(s) for remappable tickers`);
  }
  return mem;
}
export async function savePriceCache() {
  if (mem) await writeState(CACHE, mem);
}
export function fetchesUsed() {
  return fetched;
}
export function tiingoUsed() {
  return tiingoHits;
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
      // A 404 ("No data found, symbol may be delisted") is Yahoo's definitive "no data"
      // for this symbol — treat it exactly like an empty 200 so we tombstone once and fall
      // through to Tiingo. Yahoo now 404s many valid-but-not-"hot" symbols (MMC, WBA, K,
      // ...) that it used to serve; mapping that to a non-tombstone made every date lookup
      // re-fetch the same ticker (budget amplification) AND skipped the Tiingo fallback.
      if (r.status === 404) return { miss: true };
      if (!r.ok) return { transient: true }; // other 4xx (401/403) — skip this run, don't tombstone
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

// Tiingo fallback for a ticker Yahoo can't price (delisted/acquired). On success it
// caches the series like Yahoo and returns the map; on a hard miss it sets e.tnf so we
// don't retry forever; on a rate-limit it parks the ticker for this run only. Returns
// the series map or null.
async function tiingoFallback(ticker, e) {
  const t = await fetchTiingoSeries(ticker, FROM);
  if (t.ok) {
    series.set(ticker, t.map);
    e.latest = t.latest;
    e.latestDate = t.latestDate;
    e.src = 'tiingo';
    tiingoHits++;
    return t.map;
  }
  if (t.throttled) notThisRun.add(ticker); // rate-limited — skip this run, retry next (keep tombstone)
  else if (t.miss) e.tnf = true; // Tiingo has nothing either -> stop retrying
  return null;
}

// Load a ticker's full daily history into memory (once per run). A 429-throttled
// ticker returns null WITHOUT spending the budget or being tombstoned, so it can
// retry on a later run; sustained throttling trips the circuit breaker.
async function ensureSeries(ticker, maxFetches) {
  if (series.has(ticker)) return series.get(ticker);
  if (notThisRun.has(ticker)) return null; // already failed this run — don't re-fetch every date
  const e = entry(ticker);
  // Known Yahoo-dead: skip Yahoo entirely and go straight to Tiingo (until it's also
  // confirmed empty). The tombstone stays put — it's the permanent "no Yahoo data" record.
  if (e.miss) {
    if (tiingoEnabled() && !e.tnf) return await tiingoFallback(ticker, e);
    return null;
  }
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
  if (res.transient) {
    notThisRun.add(ticker); // non-404 4xx (401/403): skip for this run so we don't re-fetch
    return null; // it on every date lookup; retry on a later run without a permanent tombstone
  }
  throttleStreak = 0;
  fetched++; // a real resolved attempt — counts against the budget
  if (res.miss) {
    e.miss = true; // record Yahoo has no data, then try Tiingo (delisted/acquired history)
    if (tiingoEnabled()) return await tiingoFallback(ticker, e);
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
  ticker = canonicalTicker(ticker); // BF.B->BF-B, KORS->CPRI, etc. (cache keyed by canonical)
  await load();
  const e = entry(ticker);
  if (e.d[date] != null) return e.d[date];
  const man = await manualClose(ticker, date); // delisted/purged tickers (no Yahoo data)
  if (man != null) {
    e.d[date] = man;
    return man;
  }
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
  ticker = canonicalTicker(ticker);
  await load();
  const e = entry(ticker);
  if (series.has(ticker)) return e.latest ?? null; // already fetched this run
  // A delisted ticker's last price never changes — a Tiingo-sourced latest is final,
  // so reuse it forever instead of re-fetching every run.
  if (e.src === 'tiingo' && e.latest != null) return e.latest;
  // Reuse a cached latest without a fetch: always in backlog-drain mode, otherwise
  // only when recent. Frees the budget for genuinely-uncached tickers.
  if (e.latest != null && (SKIP_LATEST_REFRESH || freshEnough(e.latestDate))) return e.latest;
  const map = await ensureSeries(ticker, maxFetches);
  // throttled/miss — fall back to last known, then to a manual deal/delisting price
  // (so a still-open position in a bought-out company closes at the buyout value).
  if (!map) return e.latest ?? (await manualLatest(ticker)) ?? null;
  return e.latest ?? null;
}
