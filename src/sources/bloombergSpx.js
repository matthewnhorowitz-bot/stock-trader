// Bloomberg S&P 500 total-return benchmark for the Congress Index.
//
// Reads data/bloomberg_spx.json (a DAILY SPX Index / TOT_RETURN_INDEX_GROSS_DVDS
// series, generated locally by bloomberg/fetch_spx.py and committed to the repo —
// CI has no Bloomberg Terminal). priceCache serves the BENCH symbol from this series
// when it's present, so both the Congress Index spy[] array and every position's
// spyRet use the authoritative Bloomberg S&P instead of the Yahoo SPY proxy.
//
// Fail-soft: if the file is missing/empty, hasBench() stays false and priceCache
// transparently falls back to Yahoo SPY (keeps local dev / pre-commit state working).
//
// The Bloomberg pull uses ALL_CALENDAR_DAYS + PREVIOUS_VALUE fill, so every calendar
// day (incl. weekend Jan-1/Jul-1 boundaries) has a value — lookups are normally exact.

import { readState } from '../stateStore.js';

let loaded = false;
let map = null; // { 'YYYY-MM-DD': value }
let dates = null; // sorted keys of map
let latestVal = null;

// Load the series once (lazy). Returns whether a usable series is available.
export async function ensureBench() {
  if (loaded) return hasBench();
  loaded = true;
  try {
    const j = await readState('bloomberg_spx.json', null);
    if (j && j.series && Object.keys(j.series).length) {
      map = j.series;
      dates = Object.keys(map).sort();
      latestVal = map[dates[dates.length - 1]];
    }
  } catch {
    // fail-soft: leave map null -> Yahoo SPY fallback in priceCache
  }
  return hasBench();
}

export function hasBench() {
  return !!(map && dates && dates.length);
}

// Benchmark level on/after `date` (nearest within ~10 days), mirroring priceCache's
// nearestOnOrAfter. With full calendar-day fill this is normally an exact hit; the
// window only matters at the very start/end of the series.
export function benchAt(date) {
  if (!hasBench() || !date) return null;
  if (map[date] != null) return map[date];
  const start = new Date(date + 'T00:00:00Z');
  for (let i = 1; i <= 10; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    if (map[d] != null) return map[d];
  }
  return null;
}

// Latest benchmark level (for marking open positions to market).
export function benchLatest() {
  return hasBench() ? latestVal : null;
}
