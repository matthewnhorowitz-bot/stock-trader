// Bloomberg fallback prices for tickers Yahoo/Tiingo can't serve — the survivorship gap
// (delisted/acquired names like ATVI/SIVB/PXD, and live-but-Yahoo-404 names like WBA/K).
//
// Reads data/bloomberg_prices.json (built locally by bloomberg/fetch_prices.py and
// committed — CI has no Terminal). priceCache consults this overlay before falling back
// to Tiingo/tombstoning, so these positions get priced instead of dropped.
//
// Shape: { series: { TICKER: { d:{date:close}, first, last, latest, latestDate, name, security } } }
// keyed by the SAME canonical ticker priceCache uses (BF-B, KORS→CPRI already applied
// upstream — dead tickers were read straight from price_cache.json's keys).
//
// The overlay is stored COMPRESSED to value-change points (carried-forward calendar-fill
// days dropped by fetch_prices.py's post-process). bbClose reconstructs any date by taking
// the last kept price on/before it — i.e. the previous settled value — which exactly
// reproduces Bloomberg's PREVIOUS_VALUE fill, so the compression is lossless.
//
// Fail-soft: missing/empty file -> hasBBPrices() false -> existing behavior unchanged.

import { readState } from '../stateStore.js';

let loaded = false;
let series = null; // { ticker: { d, first, last, latest, latestDate } }
const keysIdx = new Map(); // ticker -> sorted date keys (built lazily for binary search)

export async function ensureBBPrices() {
  if (loaded) return hasBBPrices();
  loaded = true;
  try {
    const j = await readState('bloomberg_prices.json', null);
    if (j && j.series && Object.keys(j.series).length) series = j.series;
  } catch {
    // fail-soft
  }
  return hasBBPrices();
}

export function hasBBPrices() {
  return !!(series && Object.keys(series).length);
}

function sortedKeys(ticker, e) {
  let ks = keysIdx.get(ticker);
  if (!ks) {
    ks = Object.keys(e.d).sort();
    keysIdx.set(ticker, ks);
  }
  return ks;
}

// Total-return close as of `date` = the last kept price on/before it (carried-forward /
// previous settled value). Returns null for a date BEFORE the security's first point: a
// series that starts after a trade's entry (a recycled/reassigned ticker) must NOT price
// that earlier trade — leave it unpriced rather than mispriced.
export function bbClose(ticker, date) {
  const e = series && series[ticker];
  if (!e || !date || date < e.first) return null;
  const d = e.d;
  if (d[date] != null) return d[date];
  // binary search: largest kept key <= date
  const ks = sortedKeys(ticker, e);
  let lo = 0, hi = ks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ks[mid] <= date) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans >= 0 ? d[ks[ans]] : null;
}

export function bbLatest(ticker) {
  const e = series && series[ticker];
  return e ? (e.latest ?? null) : null;
}
