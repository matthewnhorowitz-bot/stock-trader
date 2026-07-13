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

// Each rule: [committee-name substrings, tokens, tier]. Name substrings are matched
// against the short committee name (lowercased). `tokens` is either 'ALL' (super-
// committee) or industry/sector tokens matched as substrings against the stock's
// "sector + industry" text. `tier` grades how TIGHT the committee's jurisdiction is
// over the matched sector, which sets the base conflict score:
//   3 = narrow, near-exclusive jurisdiction (Financial Services -> banks)
//   2 = clear but broader jurisdiction
//   1 = giant/tangential committee (Energy & Commerce spans half the economy)
//   0 = super-committee (broad spending/tax power — weakest; never a genuine conflict)
const COMMITTEE_RULES = [
  // Super-committees: broad spending/tax jurisdiction. Weakest tier — they touch
  // everything, so a match here scores low and is NEVER a genuine sector conflict
  // on its own (see conflictScore's `ov`).
  [['appropriations', 'ways and means', 'finance', 'oversight', 'taxation'], 'ALL', 0],
  // Defense / security / intelligence
  [['armed services'], ['defense', 'aerospace', 'weapon', 'shipbuild', 'marine', 'military'], 3],
  [['intelligence'], ['defense', 'aerospace', 'satellite', 'communication equipment', 'cyber', 'security'], 3],
  [['homeland security'], ['cyber', 'security software', 'prison', 'correction', 'defense', 'infrastructure'], 2],
  // Finance / housing
  [['financial services', 'banking'], ['bank', 'financial', 'asset manage', 'capital market', 'credit', 'fintech', 'insurance', 'real estate', 'reit', 'crypto', 'mortgage'], 3],
  // Agriculture / food
  [['agriculture'], ['agricult', 'farm', 'food', 'beverage', 'packaged', 'fertiliz', 'tobacco', 'consumer defensive'], 3],
  // Energy / resources / environment
  [['energy and natural resources'], ['oil', 'gas', 'solar', 'wind', 'nuclear', 'energy', 'renewable', 'utilit'], 3],
  [['natural resources'], ['oil', 'gas', 'mining', 'metal', 'copper', 'gold', 'silver', 'uranium', 'lithium', 'water', 'coal'], 3],
  [['environment and public works'], ['engineering', 'construction', 'steel', 'concrete', 'waste', 'water', 'building material', 'utilit'], 2],
  // Broad commerce / tech / telecom / health — giant committees, so loose matches
  [['energy and commerce'], ['technology', 'semiconductor', 'telecom', 'communication', 'health', 'pharma', 'drug', 'biotech', 'utilit', 'renewable', 'solar', 'auto', 'oil', 'gas', 'energy'], 1],
  [['commerce, science', 'commerce'], ['technology', 'software', 'internet', 'telecom', 'communication', 'auto', 'space', 'aerospace', 'airline', 'freight', 'semiconductor'], 1],
  [['science, space', 'science'], ['semiconductor', 'aerospace', 'space', 'technology', 'software', 'internet', 'quantum'], 2],
  // Transportation / infrastructure
  [['transportation', 'infrastructure'], ['railroad', 'airline', 'freight', 'trucking', 'marine', 'engineering', 'construction', 'infrastructure', 'auto manufact'], 2],
  // Judiciary (antitrust on big tech / media / entertainment) — loose
  [['judiciary'], ['internet content', 'entertainment', 'media', 'software', 'communication', 'technology', 'telecom'], 1],
  // Health
  [['health, education', 'health,'], ['pharma', 'drug', 'biotech', 'hospital', 'health', 'medical'], 3],
  [['veterans'], ['health', 'medical', 'hospital', 'housing', 'medical device'], 3],
  [['aging'], ['senior', 'long-term care', 'pharma', 'health', 'housing'], 2],
  // Foreign / trade / logistics — loose
  [['foreign affairs', 'foreign relations'], ['shipping', 'logistics', 'freight', 'marine', 'airline', 'defense', 'aerospace'], 1],
  // Niche
  [['indian affairs'], ['casino', 'gaming', 'resort', 'gambling'], 3],
  [['education and the workforce', 'education and workforce'], ['education', 'staffing', 'employment'], 2],
  [['small business'], ['regional bank'], 2],
  [['budget'], ['etf', 'index'], 1],
  [['economic'], ['etf', 'index'], 1],
];

export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|dr|mr|mrs|ms)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shortCommittee(name) {
  return String(name || '')
    .replace(/^(house|senate|joint)\s+(permanent\s+select\s+|select\s+|special\s+)?committee\s+on\s+(the\s+)?/i, '')
    .trim();
}

// Build the lookup index { byBioguide, byName, lastSeen } from a committees list
// (array, like committees-current) + a membership map (committeeId -> members[]).
// Shared by the current (JSON) and historical (YAML-per-Congress) paths.
export function buildCommitteeIndex(committees, membership) {
  const idToName = new Map((committees || []).map((c) => [c.thomas_id, shortCommittee(c.name)]));
  const byBioguide = new Map();
  const byName = new Map();
  const lastSeen = new Map();
  for (const [committeeId, members] of Object.entries(membership || {})) {
    if (!idToName.has(committeeId)) continue; // skip subcommittee codes
    const cname = idToName.get(committeeId);
    for (const m of members || []) {
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
}

let committeePromise = null;
export async function getCommitteeIndex() {
  if (committeePromise) return committeePromise;
  committeePromise = (async () => {
    const base = 'https://unitedstates.github.io/congress-legislators';
    const [committees, membership] = await Promise.all([
      fetch(`${base}/committees-current.json`).then((r) => r.json()),
      fetch(`${base}/committee-membership-current.json`).then((r) => r.json()),
    ]);
    return buildCommitteeIndex(committees, membership);
  })().catch((err) => {
    console.error(`[enrich] committee data failed: ${err.message}`);
    return null;
  });
  return committeePromise;
}

export function committeesFor(idx, trade) {
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

// Returns the committees that overlap the stock, each with a reason and a
// tightness `tier` (0 = super-committee, 1-3 = direct match, higher = tighter).
// Exported for testing.
export function overlapsFor(committees, sectorIndustryLower) {
  const hits = [];
  for (const c of committees) {
    const cl = c.toLowerCase();
    for (const [matchers, tokens, tier] of COMMITTEE_RULES) {
      if (!matchers.some((m) => cl.includes(m))) continue;
      if (tokens === 'ALL') {
        if (config.overlapSuperCommittees) hits.push({ committee: c, all: true, tier: 0 });
        break;
      }
      if (sectorIndustryLower && tokens.some((tok) => sectorIndustryLower.includes(tok))) {
        hits.push({ committee: c, all: false, tier });
        break;
      }
    }
  }
  return hits;
}

// Diversified, whole-market index funds. A bet on the entire market (or a broad
// slice of it) is NOT a bet on any one committee's sector, so it never counts as a
// conflict — even when a data provider mislabels its "sector" (e.g. FMP tags SPY
// "Financial Services"). Concentrated sector ETFs (XLE, XLF, ...) are deliberately
// absent: those ARE a directional sector bet and should still score.
const BROAD_ETFS = new Set([
  'SPY', 'VOO', 'IVV', 'SPLG', 'ITOT', 'VTI', 'VT', 'SCHB', 'SCHX', 'RSP',
  'QQQ', 'QQQM', 'ONEQ', 'DIA',
  'IWM', 'IWB', 'IWD', 'IWF', 'IWV', 'VB', 'VO', 'VUG', 'VTV', 'MDY', 'IJH', 'IJR', 'SLY',
  'TNA', 'TQQQ', 'SQQQ', 'SPXL', 'UPRO', 'SSO', 'SPXU', 'SDS',
  'EFA', 'IEFA', 'VEA', 'VXUS', 'VWO', 'IEMG', 'ACWI', 'ACWX', 'VEU', 'SCHF', 'SPDW', 'SPEM', 'EEM',
  'AGG', 'BND', 'BNDX', 'SCHZ', 'VCIT', 'VCSH', 'LQD', 'TLT', 'IEF', 'SHY', 'GOVT',
  'VIG', 'VYM', 'SDY', 'DVY', 'NOBL', 'SCHD', 'HDV',
]);
// A broad index fund OR an open-end mutual fund (5-letter ticker ending in X, the
// standard convention: SMCWX, VFIAX, ...). Both are diversified/pooled baskets, so
// buying one is not a bet on any single committee's sector — even when a provider
// tags the fund itself "Financial Services" (asset management).
export function isBroadEtf(ticker) {
  const t = String(ticker || '').toUpperCase();
  return BROAD_ETFS.has(t) || /^[A-Z]{4}X$/.test(t);
}

// A few concentrated funds that data providers routinely mislabel by sector.
// Correcting them keeps false conflicts out of the headline (e.g. FMP tags the
// AMLP energy-pipeline ETF "Financial Services", which otherwise reads as a
// Banking-committee conflict). Values are matched the same way as sector+industry.
const SECTOR_OVERRIDE = {
  AMLP: 'energy oil gas pipeline', AMJ: 'energy oil gas pipeline',
  MLPA: 'energy oil gas pipeline', MLPX: 'energy oil gas pipeline',
  GDX: 'basic materials mining gold', GDXJ: 'basic materials mining gold',
};

// Base conflict score by committee-tightness tier.
const TIER_BASE = { 0: 8, 1: 25, 2: 45, 3: 70 };
// Bigger disclosed trade -> stronger conviction/impact.
function sizeMult(amountHigh) {
  const a = Number(amountHigh) || 0;
  if (a >= 1e6) return 1.3;
  if (a >= 5e5) return 1.2;
  if (a >= 25e4) return 1.1;
  if (a >= 1e5) return 1.0;
  if (a >= 5e4) return 0.9;
  if (a >= 15e3) return 0.75;
  return 0.6;
}
// Accumulating exposure in a sector you regulate is a stronger signal than divesting.
function dirMult(type) {
  return type === 'sell' ? 0.7 : type === 'buy' ? 1.0 : 0.85;
}
// Upper dollar bound from a trade's disclosed range (e.g. "$1,001 - $15,000").
export function amountHighOf(t) {
  if (t && t.amountHigh != null) return t.amountHigh;
  const raw = t && t.amount && (t.amount.raw || (typeof t.amount === 'string' ? t.amount : ''));
  const nums = String(raw || '').match(/[\d,]+/g);
  return nums && nums.length ? Number(nums[nums.length - 1].replace(/,/g, '')) : 0;
}

// Graded committee<->trade conflict score (0-100) for a single trade/position, plus
// a binary `ov` = a GENUINE sector-jurisdiction overlap (a direct, non-super match on
// a non-diversified holding). The score = tier base x size x direction. Super-committee
// -only matches score low and are never ov=1; broad index funds score 0. This is the
// improved definition described in [[congress-overlap-redefinition]].
export function conflictScore({ committees, sectorIndustryLower, ticker, amountHigh, type }) {
  if (isBroadEtf(ticker)) return { score: 0, ov: 0, tier: null, committee: null, reason: 'diversified index fund' };
  const si = SECTOR_OVERRIDE[String(ticker || '').toUpperCase()] || sectorIndustryLower || '';
  const hits = overlapsFor(committees || [], si);
  if (!hits.length) return { score: 0, ov: 0, tier: null, committee: null, reason: '' };
  const best = hits.slice().sort((a, b) => b.tier - a.tier)[0];
  const direct = hits.some((h) => !h.all);
  const score = Math.max(0, Math.min(100, Math.round(TIER_BASE[best.tier] * sizeMult(amountHigh) * dirMult(type))));
  return {
    score,
    ov: direct ? 1 : 0,
    tier: best.tier,
    committee: best.committee,
    reason: best.all ? 'broad spending/tax jurisdiction' : 'sector jurisdiction',
  };
}

export async function getProfiles(tickers) {
  const cache = await readState(SECTOR_CACHE, {});
  const unknown = [...new Set(tickers.filter((t) => t && !(t in cache)))];
  let changed = false;
  for (const sym of unknown) {
    try {
      const r = await fetch(
        `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(sym)}&apikey=${config.providers.fmpKey}`
      );
      if (!r.ok) continue; // transient (429 over the daily cap / 5xx) — DON'T tombstone, retry next run
      const j = await r.json();
      const row = Array.isArray(j) ? j[0] : j;
      // Only cache on a real 200 response (empty sector = genuine no-data, e.g. an ETF).
      cache[sym] = { s: (row && row.sector) || '', i: (row && row.industry) || '' };
      changed = true;
    } catch {
      // network error — transient, leave unknown so it retries next run
    }
  }
  if (changed) await writeState(SECTOR_CACHE, cache);
  return cache;
}

// Normalize a cache entry (older caches stored a plain sector string).
export function profile(entry) {
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
      t.conflict = conflictScore({
        committees: t.committees,
        sectorIndustryLower: si,
        ticker: t.ticker,
        amountHigh: amountHighOf(t),
        type: t.type,
      });
    }
  } catch (err) {
    console.error(`[enrich] skipped: ${err.message}`);
  }
  return trades;
}
