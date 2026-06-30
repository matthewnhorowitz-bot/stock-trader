// Canonical Yahoo symbol for a raw filing ticker.
//
// The performance index silently DROPS any position whose ticker won't price, and a
// large share of those drops were not "dead" companies at all — they were tickers
// Yahoo simply lists under a different string. Two deterministic fixes recover them:
//
//   1. Class-share punctuation. Filings (and our OCR) write "BRK.B" / "BF.B"; Yahoo's
//      chart API uses a hyphen ("BRK-B", "BF-B"), and a bare class root needs its
//      class letter ("BRK" -> "BRK-B"). A dotted symbol returns EMPTY on Yahoo, so
//      without this it looks like a delisting.
//
//   2. Renames / symbol changes where the SAME shares keep trading under a new ticker
//      with continuous price history (Coach -> Tapestry, ISIS -> IONS, FB -> META...).
//      Yahoo carries the full series under the new symbol, so the whole holding window
//      prices correctly.
//
// DELIBERATELY EXCLUDED: cash buyouts (WFM, LNKD, PCP — Yahoo has purged them) and
// merger exchange-ratio deals (RTN->RTX at 2.3348, AGU->NTR at 2.23, GAS->WEC for
// cash, DPS->KDP with a $103.75 special dividend, LTD->BBWI after the VSCO spinoff).
// Mapping those to a successor would INVENT a return the trade never earned — worse
// than leaving the position unpriced. Only true 1:1 same-security continuations are
// listed here; when in doubt, leave it out.

const ALIASES = {
  APPL: 'AAPL', // common filing typo for Apple
  ISIS: 'IONS', // Isis Pharmaceuticals -> Ionis (2015)
  KORS: 'CPRI', // Michael Kors -> Capri Holdings (2019)
  CBG: 'CBRE', // CBRE Group ticker change (2016)
  CMCSK: 'CMCSA', // Comcast special class K eliminated -> CMCSA (2015)
  HYH: 'AVNS', // Halyard Health -> Avanos (2018)
  COH: 'TPR', // Coach -> Tapestry (2017)
  ACE: 'CB', // ACE Ltd renamed Chubb, kept the listing (2016)
  VRX: 'BHC', // Valeant -> Bausch Health (2018)
  HCN: 'WELL', // Health Care REIT -> Welltower
  ETE: 'ET', // Energy Transfer Equity -> Energy Transfer (2018)
  ANTM: 'ELV', // Anthem -> Elevance Health (2022)
  FB: 'META', // Facebook -> Meta (2022)
  WLTW: 'WTW', // Willis Towers Watson ticker change (2022)
  HFC: 'DINO', // HollyFrontier -> HF Sinclair (2022)
  PX: 'LIN', // Praxair -> Linde plc, 1:1 (2018)
  ZMH: 'ZBH', // Zimmer Holdings -> Zimmer Biomet (2015)
  WLP: 'ELV', // WellPoint -> Anthem -> Elevance Health
  UTX: 'RTX', // United Technologies -> Raytheon Technologies, continuing entity (2020)
  SQ: 'XYZ', // Square -> Block, ticker change (2024)
  BLL: 'BALL', // Ball Corp ticker change (2022)
  DISCA: 'WBD', // Discovery -> Warner Bros. Discovery, continuing listing (2022)
  ORCC: 'OBDC', // Owl Rock Capital -> Blue Owl Capital, ticker change (2024)
  HHC: 'HHH', // Howard Hughes -> Howard Hughes Holdings, ticker change (2023)
  BRK: 'BRK-B', // bare Berkshire root -> Class B
  'RDS.A': 'SHEL', // Royal Dutch Shell ADR -> single Shell line (2022)
  'RDS.B': 'SHEL',
};

// Map a raw ticker to the symbol Yahoo actually serves. Order matters: alias lookup
// runs before AND after the dot->dash rewrite so both "RDS.B" (dotted alias key) and
// "BF.B" (pure punctuation) resolve.
export function canonicalTicker(raw) {
  let s = String(raw || '').toUpperCase().trim().replace(/\s+/g, '');
  if (!s) return s;
  // strip a when-issued / when-distributed temporary suffix (e.g. "XLS-WI")
  s = s.replace(/[.\-](WI|WD)$/, '');
  if (ALIASES[s]) return ALIASES[s];
  if (s.includes('.')) s = s.replace(/\./g, '-'); // Yahoo class shares use '-'
  if (ALIASES[s]) return ALIASES[s];
  return s;
}

// True when canonicalization would change the symbol — used to retire stale "miss"
// tombstones in the price cache so they get re-fetched under the right symbol.
export function isRemapped(raw) {
  return canonicalTicker(raw) !== String(raw || '').toUpperCase().trim().replace(/\s+/g, '');
}

// CLI self-check: `node src/tickerAliases.js`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('tickerAliases.js')) {
  const cases = [
    ['BF.B', 'BF-B'], ['BRK', 'BRK-B'], ['BRK.B', 'BRK-B'], ['APPL', 'AAPL'],
    ['KORS', 'CPRI'], ['RDS.B', 'SHEL'], ['ISIS', 'IONS'], ['XLS-WI', 'XLS'],
    ['AAPL', 'AAPL'], ['WFM', 'WFM'], ['  fb ', 'META'],
  ];
  let ok = 0;
  for (const [inp, want] of cases) {
    const got = canonicalTicker(inp);
    const pass = got === want;
    if (pass) ok++;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${JSON.stringify(inp).padEnd(10)} -> ${got}${pass ? '' : ` (want ${want})`}`);
  }
  console.log(`\n${ok}/${cases.length} passed`);
  process.exit(ok === cases.length ? 0 : 1);
}
