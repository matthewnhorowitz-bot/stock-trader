// Determines when a member of Congress left office, so the performance index can
// "force-close" their still-open positions at their last day in office (you stop
// copying a member once they leave — otherwise an unsold trade is marked to market
// forever). Data: unitedstates/congress-legislators (public JSON, no key).
//
// Matching is by normalized name (positions carry no bioguide); falls back to a
// unique last name. Unmatched members are treated as still serving (no change).

import { readState, writeState } from './stateStore.js';
import { normName } from './enrich.js';

const CACHE = 'legislators.json';
const BASE = 'https://unitedstates.github.io/congress-legislators';
const REFRESH_DAYS = 14;

let _idxPromise = null;

// Build { normName -> { end: 'YYYY-MM-DD', serving: bool } } from current+historical.
async function fetchAll() {
  const [cur, hist] = await Promise.all([
    fetch(`${BASE}/legislators-current.json`).then((r) => r.json()),
    fetch(`${BASE}/legislators-historical.json`).then((r) => r.json()),
  ]);
  const byName = {};
  const add = (leg, serving) => {
    const terms = leg.terms || [];
    const end = terms.map((t) => t.end).filter(Boolean).sort().slice(-1)[0] || '';
    const nm = leg.name || {};
    const keys = new Set();
    if (nm.official_full) keys.add(normName(nm.official_full));
    if (nm.first && nm.last) keys.add(normName(`${nm.first} ${nm.last}`));
    if (nm.last) keys.add(normName(`${nm.first || ''} ${nm.last}`));
    for (const key of keys) {
      const prev = byName[key];
      // prefer a serving record; otherwise keep the one with the latest term end
      if (!prev || (serving && !prev.serving) || (serving === prev.serving && end > prev.end)) {
        byName[key] = { end, serving };
      }
    }
  };
  for (const leg of cur) add(leg, true);
  for (const leg of hist) add(leg, false);
  return byName;
}

async function getIndex() {
  if (_idxPromise) return _idxPromise;
  _idxPromise = (async () => {
    const cached = await readState(CACHE, null);
    const fresh = cached && cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < REFRESH_DAYS * 864e5;
    let byName;
    if (fresh) {
      byName = cached.byName;
    } else {
      try {
        byName = await fetchAll();
        await writeState(CACHE, { fetchedAt: new Date().toISOString(), byName });
      } catch (e) {
        console.error(`[legislators] fetch failed: ${e.message}`);
        byName = (cached && cached.byName) || {};
      }
    }
    const byLast = new Map();
    for (const k of Object.keys(byName)) {
      const last = k.split(' ').slice(-1)[0];
      if (!byLast.has(last)) byLast.set(last, new Set());
      byLast.get(last).add(k);
    }
    return { byName, byLast };
  })();
  return _idxPromise;
}

// Returns { departureDate(memberName) -> 'YYYY-MM-DD' | null }.
// null = still serving, unknown, or future-dated.
export async function getDepartures() {
  const { byName, byLast } = await getIndex();
  const today = new Date().toISOString().slice(0, 10);
  const departureDate = (member) => {
    const nn = normName(member);
    let rec = byName[nn];
    if (!rec) {
      const last = nn.split(' ').slice(-1)[0];
      const cands = byLast.get(last);
      if (cands && cands.size === 1) rec = byName[[...cands][0]];
    }
    if (!rec || rec.serving) return null;
    return rec.end && rec.end < today ? rec.end : null;
  };
  return { departureDate };
}
