// Enriches trades with: the stock's sector, the member's committee assignments,
// and a heuristic "possible overlap" flag (member sits on a committee whose
// jurisdiction matches the stock's sector — a potential conflict of interest).
//
// Data sources (both free):
//   - Committees: unitedstates/congress-legislators (public JSON, no key)
//   - Sector: FMP /profile (cached in data/sectors.json so we don't burn quota)
//
// All enrichment is best-effort and failure-safe: if a lookup fails, the trade
// still alerts, just without the extra fields. Never let enrichment block alerts.

import { config } from './config.js';
import { readState, writeState } from './stateStore.js';

const SECTOR_CACHE = 'sectors.json';

// Map a GICS-ish sector (as FMP labels it) to committee-name keywords whose
// jurisdiction plausibly covers it. Heuristic on purpose.
const SECTOR_COMMITTEE_KEYWORDS = {
  Energy: ['energy', 'natural resources', 'environment'],
  Utilities: ['energy', 'natural resources', 'environment'],
  'Financial Services': ['financial', 'banking', 'finance'],
  'Real Estate': ['financial', 'banking'],
  Healthcare: ['health', 'energy and commerce'],
  Technology: ['commerce', 'science', 'energy and commerce', 'communications', 'judiciary'],
  'Communication Services': ['commerce', 'communications', 'energy and commerce'],
  Industrials: ['armed services', 'defense', 'homeland security', 'transportation', 'infrastructure'],
  'Consumer Defensive': ['agriculture'],
  'Consumer Cyclical': ['commerce'],
  'Basic Materials': ['natural resources', 'energy'],
};

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|dr|mr|mrs|ms)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Trim "Senate/House (Permanent Select) Committee on (the)" down to the core name.
function shortCommittee(name) {
  return String(name || '')
    .replace(/^(house|senate|joint)\s+(permanent\s+select\s+|select\s+|special\s+)?committee\s+on\s+(the\s+)?/i, '')
    .trim();
}

let committeePromise = null;
// Build { byBioguide: Map<id,Set>, byName: Map<normname,Set>, byLast: Map<last,Set|null> }
async function getCommitteeIndex() {
  if (committeePromise) return committeePromise;
  committeePromise = (async () => {
    const base = 'https://unitedstates.github.io/congress-legislators';
    const [committees, membership] = await Promise.all([
      fetch(`${base}/committees-current.json`).then((r) => r.json()),
      fetch(`${base}/committee-membership-current.json`).then((r) => r.json()),
    ]);
    const idToName = new Map(committees.map((c) => [c.thomas_id, shortCommittee(c.name)]));

    const byBioguide = new Map();
    const byName = new Map();
    const lastSeen = new Map(); // last name -> Set of normalized full names (to detect ambiguity)

    for (const [committeeId, members] of Object.entries(membership)) {
      // Keep only full committees; subcommittee ids (e.g. SSAF13) aren't in
      // committees-current and would otherwise show as raw codes. The member's
      // parent committee already covers them.
      if (!idToName.has(committeeId)) continue;
      const cname = idToName.get(committeeId);
      for (const m of members) {
        const add = (map, key) => {
          if (!key) return;
          if (!map.has(key)) map.set(key, new Set());
          map.get(key).add(cname);
        };
        add(byBioguide, m.bioguide);
        const nn = normName(m.name);
        add(byName, nn);
        const last = nn.split(' ').slice(-1)[0];
        if (!lastSeen.has(last)) lastSeen.set(last, new Set());
        lastSeen.get(last).add(nn);
      }
    }
    return { byBioguide, byName, lastSeen };
  })().catch((err) => {
    console.error(`[enrich] committee data failed: ${err.message}`);
    return null;
  });
  return committeePromise;
}

function committeesFor(idx, trade) {
  if (!idx) return [];
  // Senate: match by bioguide (FMP puts it in senateID) — reliable.
  if (trade.chamber === 'senate' && trade.bioguide && idx.byBioguide.has(trade.bioguide)) {
    return [...idx.byBioguide.get(trade.bioguide)];
  }
  const nn = normName(trade.politician);
  if (idx.byName.has(nn)) return [...idx.byName.get(nn)];
  // Fallback: unique last-name match (handles nickname/middle-name differences).
  const last = nn.split(' ').slice(-1)[0];
  const cands = idx.lastSeen.get(last);
  if (cands && cands.size === 1) {
    const only = [...cands][0];
    if (idx.byName.has(only)) return [...idx.byName.get(only)];
  }
  return [];
}

async function getSectors(tickers) {
  const cache = await readState(SECTOR_CACHE, {});
  const unknown = [...new Set(tickers.filter((t) => t && !(t in cache)))];
  let changed = false;
  for (const sym of unknown) {
    try {
      const r = await fetch(
        `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(sym)}&apikey=${config.providers.fmpKey}`
      );
      if (!r.ok) {
        cache[sym] = ''; // remember the miss so we don't retry every run
        changed = true;
        continue;
      }
      const j = await r.json();
      const row = Array.isArray(j) ? j[0] : j;
      cache[sym] = (row && row.sector) || '';
      changed = true;
    } catch {
      cache[sym] = '';
      changed = true;
    }
  }
  if (changed) await writeState(SECTOR_CACHE, cache);
  return cache;
}

function overlapFor(sector, committees) {
  if (!sector || !committees.length) return null;
  const keywords = SECTOR_COMMITTEE_KEYWORDS[sector];
  if (!keywords) return null;
  for (const c of committees) {
    const lc = c.toLowerCase();
    if (keywords.some((k) => lc.includes(k))) return c; // the matching committee
  }
  return null;
}

// Adds .sector, .committees (array), .overlapCommittee (string|null) to each trade.
export async function enrich(trades) {
  if (!config.enrich) return trades;
  try {
    const [idx, sectors] = await Promise.all([
      getCommitteeIndex(),
      getSectors(trades.map((t) => t.ticker)),
    ]);
    for (const t of trades) {
      t.sector = sectors[t.ticker] || '';
      t.committees = committeesFor(idx, t);
      t.overlapCommittee = overlapFor(t.sector, t.committees);
    }
  } catch (err) {
    console.error(`[enrich] skipped: ${err.message}`);
  }
  return trades;
}
