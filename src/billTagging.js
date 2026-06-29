// Rules-based bill tagger: maps a bill's text (title + policy area + summary) to
//   - sector:    an FMP sector string (the SAME vocabulary trades carry in
//                data/sectors.json, e.g. "Energy", "Technology"), so a bill and a
//                holding can be matched without a separate taxonomy; and
//   - billStance: +1 if the bill SUPPORTS/subsidizes/protects that sector,
//                 -1 if it TAXES/restricts/bans it.
//
// Deterministic and offline — no API. Sample votes ship pre-tagged; this fills the
// tags for any record (e.g. a future live Congress.gov feed) that omits them.

// FMP sector -> keyword substrings that imply the bill touches that sector.
// Order matters: the first sector with a keyword hit wins, so list the more
// specific sectors before broad ones.
const SECTOR_KEYWORDS = [
  ['Energy', ['oil', 'gas', 'petroleum', 'fossil', 'drilling', 'pipeline', 'coal', 'refinery', 'offshore lease', 'fracking', 'clean energy', 'renewable energy', 'energy']],
  ['Utilities', ['utility', 'utilities', 'power grid', 'electric grid', 'renewable', 'solar', 'wind power', 'nuclear power', 'clean power']],
  ['Healthcare', ['drug', 'pharma', 'prescription', 'medicare', 'medicaid', 'biotech', 'hospital', 'medical device', 'health insurance', 'vaccine']],
  ['Financial Services', ['bank', 'wall street', 'securities', 'capital market', 'credit card', 'mortgage', 'insurance', 'crypto', 'fintech', 'dodd-frank']],
  ['Industrials', ['defense', 'aerospace', 'weapon', 'military', 'shipbuild', 'infrastructure', 'railroad', 'freight', 'aviation']],
  ['Consumer Cyclical', ['electric vehicle', 'ev mandate', 'automobile', 'auto manufactur', 'retail', 'restaurant', 'gambling', 'casino', 'homebuild']],
  ['Consumer Defensive', ['agricult', 'farm', 'food', 'beverage', 'tobacco', 'grocery']],
  ['Basic Materials', ['mining', 'chemical', 'lithium', 'rare earth', 'steel', 'copper', 'fertilizer']],
  ['Real Estate', ['real estate', 'reit', 'housing development', 'zoning']],
  ['Communication Services', ['internet', 'telecom', 'broadband', 'net neutrality', 'social media', 'streaming', 'media', '5g']],
  ['Technology', ['semiconductor', 'chip', 'software', 'artificial intelligence', ' ai ', 'cloud computing', 'cybersecurity', 'data privacy', 'technology']],
];

// CRS policy-area term (Congress.gov `policyArea.name`) -> FMP sector. CRS assigns
// exactly one policy area per bill, so this is a reliable sector signal when present.
// Areas with no clean single-sector mapping (e.g. "Taxation", "Government Operations")
// are omitted -> fall through to the title-keyword scan.
const POLICY_AREA_SECTOR = {
  'energy': 'Energy',
  'health': 'Healthcare',
  'finance and financial sector': 'Financial Services',
  'science, technology, communications': 'Technology',
  'transportation and public works': 'Industrials',
  'armed forces and national security': 'Industrials',
  'agriculture and food': 'Consumer Defensive',
  'environmental protection': 'Energy',
  'public lands and natural resources': 'Energy',
  'housing and community development': 'Real Estate',
  'commerce': 'Consumer Cyclical',
};

// Phrases that mean the bill HELPS the sector. Multi-word phrases are checked
// before the single-word "restrict" terms so "tax credit" isn't read as a tax.
const SUPPORT_TERMS = [
  'tax credit', 'tax break', 'tax incentive', 'subsidize', 'subsidy', 'subsidies',
  'grant', 'incentive', 'promote', 'boost', 'invest in', 'investment in', 'fund ',
  'funding for', 'protect', 'support', 'expand', 'modernization', 'deregulate',
];
const RESTRICT_TERMS = [
  'windfall tax', 'excise tax', 'carbon tax', 'phase out', 'phaseout', 'moratorium',
  'ban ', 'prohibit', 'restrict', 'crack down', 'crackdown', 'price cap', 'cap on',
  'penalty', 'penalize', 'repeal', 'mandate', 'regulate', 'limit', 'tax', 'tariff',
];

function hit(text, terms) {
  return terms.find((t) => text.includes(t)) || null;
}

// Returns { sector, billStance, why } or null when nothing matched.
export function tagBill(title, policyArea = '', summary = '') {
  const text = ` ${[title, policyArea, summary].join(' ').toLowerCase()} `;
  // Prefer the CRS policy area (authoritative single sector) when it maps cleanly,
  // otherwise scan title/summary keywords.
  let sector = POLICY_AREA_SECTOR[String(policyArea || '').toLowerCase().trim()] || null;
  if (!sector) {
    for (const [name, kws] of SECTOR_KEYWORDS) {
      if (kws.some((k) => text.includes(k))) {
        sector = name;
        break;
      }
    }
  }
  if (!sector) return null;
  const sup = hit(text, SUPPORT_TERMS);
  const res = hit(text, RESTRICT_TERMS);
  // Support phrases win ties (they're more specific, e.g. "tax credit" vs "tax").
  const billStance = sup ? 1 : res ? -1 : 1;
  return { sector, billStance, why: sup || res || 'supportive (default)' };
}

// Ensure a vote/sponsorship record has { sector, billStance }; derive via tagBill
// when either is missing. Returns the record (mutated) or null if untaggable.
export function ensureTagged(rec) {
  if (rec.sector && (rec.billStance === 1 || rec.billStance === -1)) return rec;
  const t = tagBill(rec.title || '', rec.policyArea || '', rec.summary || '');
  if (!t) return rec.sector ? rec : null; // keep a pre-set sector even if stance unknown
  rec.sector = rec.sector || t.sector;
  rec.billStance = rec.billStance === 1 || rec.billStance === -1 ? rec.billStance : t.billStance;
  return rec;
}
