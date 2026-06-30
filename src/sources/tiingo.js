// Tiingo EOD price source — the fallback for tickers Yahoo has purged (delisted /
// acquired companies like WFM, LNKD, PCP). Free key, returns a ticker's full daily
// history in one call, so one fetch prices every date a position needs (entry, exit,
// boundary marks). Used only when Yahoo returns no data; see priceCache.ensureSeries.
//
// Returns the same shape as priceCache's Yahoo fetcher:
//   { ok:true, map:{date:close}, latest, latestDate } | { miss:true } | { throttled:true }

import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tiingoEnabled() {
  return !!config.providers.tiingoKey;
}

export async function fetchTiingoSeries(ticker, fromDate) {
  const token = config.providers.tiingoKey;
  if (!token) return { miss: false }; // no key -> behave as transient (don't tombstone)
  const url =
    `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices` +
    `?startDate=${fromDate}&token=${token}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
      // 429 = hit the free-tier hourly cap. Don't block the run with long backoff —
      // bail immediately and let a later run resume (the ticker isn't tombstoned).
      if (r.status === 429) return { throttled: true };
      if (r.status >= 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      await sleep(60); // be polite
      if (r.status === 404) return { miss: true }; // Tiingo has no such symbol
      if (!r.ok) return { miss: false }; // other 4xx — transient, don't tombstone
      const j = await r.json();
      if (!Array.isArray(j) || !j.length) return { miss: true };
      const map = {};
      for (const row of j) {
        // adjClose matches Yahoo's adjusted series; fall back to close if absent.
        const c = row.adjClose ?? row.close;
        if (c == null || !row.date) continue;
        map[String(row.date).slice(0, 10)] = Math.round(c * 100) / 100;
      }
      const dates = Object.keys(map).sort();
      if (!dates.length) return { miss: true };
      const latestDate = dates[dates.length - 1];
      return { ok: true, map, latest: map[latestDate], latestDate };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return { throttled: true };
}
