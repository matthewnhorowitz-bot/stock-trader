// Enriches trades with: the stock's sector/industry, the member's committee
// assignments, and a "possible conflict" flag when a committee's jurisdiction
// matches what the stock does.
//
// Data sources (both free):
//   - Committees: unitedstates/congress-legislators (public JSON, no key)
//   - Sector + industry: FMP /profile (cached in data/sectors.json)
//
// Overlap mapping is the user-provided committee->sector table below. Some
// committees ("super-committees": Appropriations, Ways and Means, Finance,
// Oversight, Joint Taxation) control all federal spending/taxes and so overlap
// ANY sector; that's toggleable via OVERLAP_SUPERCOMMITTEES.
//
// All enrichment is best-effort and failure-safe: a lookup failure never blocks
// the alert, it just omits the extra fields.

import { config } from './config.js';
import { readState, writeState } from './stateStore.js';

const SECTOR_CACHE = 'sectors.json';

// Each rule: committee-name substrings (matched against the short committee
// name, lowercased) -> either 'ALL' (super-committee) or industry/sector tokens
// that are matched as substrings against the stock's "sector + industry" text.
const COMMITTEE_RULES = [
  // Super-committees: jurisdiction over everything.
  [['appropriations', 'ways and means', 'finance', 'oversight', 'taxation'], 'ALL'],
  // Defense / security / intelligence
  [['armed services'], ['defense', 'aerospace', 'weapon', 'shipbuild', 'marine', 'military']],
  [['intelligence'], ['defense', 'aerospace', 'satellite', 'communication equipment', 'cyber', 'security']],
  [['homeland security'], ['cyber', 'security software', 'prison', 'correction', 'defense', 'infrastructure']],
  // Finance / housing
  [['financial services', 'banking'], ['bank', 'financial', 'asset manage', 'capital market', 'credit', 'fintech', 'insurance', 'real estate', 'reit', 'crypto', 'mortgage']],
  // Agriculture / food
  [['agriculture'], ['agricult', 'farm', 'food', 'beverage', 'packaged', 'fertiliz', 'tobacco', 'consumer defensive']],
  // Energy / resources / environment
  [['energy and natural resources'], ['oil', 'gas', 'solar', 'wind', 'nuclear', 'energy', 'renewable', 'utilit']],
  [['natural resources'], ['oil', 'gas', 'mining', 'metal', 'copper', 'gold', 'silver', 'uranium', 'lithium', 'water', 'coal']],
  [['environment and public works'], ['engineering', 'construction', 'steel', 'concrete', 'waste', 'water', 'building material', 'utilit']],
  // Broad commerce / tech / telecom / health
  [['energy and commerce'], ['technology', 'semiconductor', 'telecom', 'communication', 'health', 'pharma', 'drug', 'biotech', 'utilit', 'renewable', 'solar', 'auto', 'oil', 'gas', 'energy']],
  [['commerce, science', 'commerce'], ['technology', 'software', 'internet', 'telecom', 'communication', 'auto', 'space', 'aerospace', 'airline', 'freight', 'semiconductor']],
  [['science, space', 'science'], ['semiconductor', 'aerospace', 'space', 'technology', 'software', 'internet', 'quantum']],
  // Transportation / infrastructure
  [['transportation', 'infrastructure'], ['railroad', 'airline', 'freight', 'trucking', 'marine', 'engineering', 'construction', 'infrastructure', 'auto manufact']],
  // Judiciary (antitrust on big tech / media / entertainment)
  [['judiciary'], ['internet content', 'entertainment', 'media', 'software', 'communication', 'technology', 'telecom']],
  // Health
  [['health, education', 'health,'], ['pharma', 'drug', 'biotech', 'hospital', 'health', 'medical']],
  [['veterans'], ['health', 'medical', 'hospital', 'housing', 'medical device']],
  [['aging'], ['senior', 'long-term care', 'pharma', 'health', 'housing']],
  // Foreign / trade / logistics
  [['foreign affairs', 'foreign relations'], ['shipping', 'logistics', 'freight', 'marine', 'airline', 'defense', 'aerospace']],
  // Niche
  [['indian affairs'], ['casino', 'gaming', 'resort', 'gambling']],
  [['education and the workforce', 'education and workforce'], ['education', 'staffing', 'employment']],
  [['small business'], ['regional bank']],
  [['budget'], ['etf', 'index']],
  [['economic'], ['etf', 'index']],
];

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|dr|mr|mrs|ms)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortCommittee(name) {
  return String(name || '')
    .replace(/^(house|senate|joint)\s+(permanent\s+select\s+|select\s+|special\s+)?committee\s+on\s+(the\s+)?/i, '')
    .trim();
}

let committeePromise = null;
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
    const lastSeen = new Map();
    for (const [committeeId, members] of Object.entries(membership)) {
      if (!idToName.has(committeeId)) continue; // skip subcommittee codes
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
  if (trade.chamber === 'senate' && trade.bioguide && idx.byBioguide.has(trade.bioguide)) {
    return [...idx.byBioguide.get(trade.bioguide)];
  }
  const nn = normName(trade.politician);
  if (idx.byName.has(nn)) return [...idx.byName.get(nn)];
  const last = nn.split(' ').slice(-1)[0];
  const cands = idx.lastSeen.get(last);
  if (cands && cands.size === 1) {
    const only = [...cands][0];
    if (idx.byName.has(only)) return [...idx.byName.get(only)];
  }
  return [];
}

// Returns the committees that overlap the stock, each with a reason.
// Exported for testing.
export function overlapsFor(committees, sectorIndustryLower) {
  const hits = [];
  for (const c of committees) {
    const cl = c.toLowerCase();
    for (const [matchers, tokens] of COMMITTEE_RULES) {
      if (!matchers.some((m) => cl.includes(m))) continue;
      if (tokens === 'ALL') {
        if (config.overlapSuperCommittees) hits.push({ committee: c, all: true });
        break;
      }
      if (sectorIndustryLower && tokens.some((tok) => sectorIndustryLower.includes(tok))) {
        hits.push({ committee: c, all: false });
        break;
      }
    }
  }
  return hits;
}

async function getProfiles(tickers) {
  const cache = await readState(SECTOR_CACHE, {});
  const unknown = [...new Set(tickers.filter((t) => t && !(t in cache)))];
  let changed = false;
  for (const sym of unknown) {
    try {
      const r = await fetch(
        `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(sym)}&apikey=${config.providers.fmpKey}`
      );
      if (!r.ok) {
        cache[sym] = { s: '', i: '' };
        changed = true;
        continue;
      }
      const j = await r.json();
      const row = Array.isArray(j) ? j[0] : j;
      cache[sym] = { s: (row && row.sector) || '', i: (row && row.industry) || '' };
      changed = true;
    } catch {
      cache[sym] = { s: '', i: '' };
      changed = true;
    }
  }
  if (changed) await writeState(SECTOR_CACHE, cache);
  return cache;
}

// Normalize a cache entry (older caches stored a plain sector string).
function profile(entry) {
  if (!entry) return { s: '', i: '' };
  return typeof entry === 'string' ? { s: entry, i: '' } : entry;
}

// Adds .sector, .industry, .committees (internal), .overlaps (array) to trades.
export async function enrich(trades) {
  if (!config.enrich) return trades;
  try {
    const [idx, cache] = await Promise.all([
      getCommitteeIndex(),
      getProfiles(trades.map((t) => t.ticker)),
    ]);
    for (const t of trades) {
      const p = profile(cache[t.ticker]);
      t.sector = p.s;
      t.industry = p.i;
      t.committees = committeesFor(idx, t);
      const si = `${p.s} ${p.i}`.toLowerCase();
      t.overlaps = overlapsFor(t.committees, si);
    }
  } catch (err) {
    console.error(`[enrich] skipped: ${err.message}`);
  }
  return trades;
}
