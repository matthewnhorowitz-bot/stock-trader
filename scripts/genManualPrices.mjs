// One-off: generate data/manual_prices.csv — the list of (ticker, date) closing
// prices the index can't auto-fetch (delisted/acquired companies Yahoo has purged).
// Fill the `close` column from any source; src/manualPrices.js reads it back in.
// Re-run any time to refresh the list as the dead set changes.  node scripts/genManualPrices.mjs
import { loadTrades } from '../src/performance.js';
import { readState } from '../src/stateStore.js';
import { canonicalTicker } from '../src/tickerAliases.js';
import { writeFile } from 'node:fs/promises';

const trades = await loadTrades();
const cache = await readState('price_cache.json', {});
// "dead" = tombstoned as a price miss AND not auto-remappable (so it stays unpriced).
const dead = new Set(
  Object.entries(cache).filter(([tk, e]) => e && e.miss && canonicalTicker(tk) === tk).map(([tk]) => tk)
);

// [company, event/note, confident ALL-CASH deal price | null]. Deal price only where
// the buyout was all-cash (used to close still-open positions); cash+stock/MLP/foreign
// are left null because mapping them to one number would invent a return.
const INFO = {
  WFM: ['Whole Foods Market', 'Amazon all-cash Aug 2017', 42.0],
  QLIK: ['Qlik Technologies', 'Thoma Bravo all-cash Aug 2016', 30.5],
  AXLL: ['Axiall', 'Westlake Chemical all-cash Aug 2016', 33.0],
  MJN: ['Mead Johnson Nutrition', 'Reckitt all-cash Jun 2017', 90.0],
  PCP: ['Precision Castparts', 'Berkshire all-cash Jan 2016', 235.0],
  LNKD: ['LinkedIn', 'Microsoft all-cash Dec 2016', 196.0],
  CTRX: ['Catamaran', 'UnitedHealth all-cash Jul 2015', 61.5],
  PETM: ['PetSmart', 'BC Partners all-cash Mar 2015', 83.0],
  ATML: ['Atmel', 'Microchip all-cash Apr 2016', 8.15],
  MDVN: ['Medivation', 'Pfizer all-cash Sep 2016', 81.5],
  RCPT: ['Receptos', 'Celgene all-cash Aug 2015', 232.0],
  AMRI: ['Albany Molecular Research', 'Carlyle/GTCR all-cash Aug 2017', 21.75],
  TFM: ['The Fresh Market', 'Apollo all-cash Apr 2016', 28.5],
  KKD: ['Krispy Kreme', 'JAB all-cash Jul 2016', 21.0],
  GIMO: ['Gigamon', 'Elliott all-cash 2017', 38.5],
  CST: ['CST Brands', 'Couche-Tard all-cash 2017', 48.53],
  CPPL: ['Columbia Pipeline Partners LP', 'TransCanada all-cash 2016', 15.75],
  CPGX: ['Columbia Pipeline Group', 'TransCanada all-cash Jul 2016', 25.5],
  GAS: ['AGL Resources', 'WEC Energy all-cash Jul 2016', 66.0],
  AIRM: ['Air Methods', 'American Securities all-cash 2017', 43.0],
  // cash+stock / merger ratios — historical close preferred, no single deal price:
  RAI: ['Reynolds American', 'BAT cash+stock Jul 2017 (~$59)', null],
  LLTC: ['Linear Technology', 'Analog Devices cash+stock Mar 2017 (~$60)', null],
  BEAV: ['BE Aerospace', 'Rockwell Collins cash+stock Apr 2017 (~$62)', null],
  BCR: ['C.R. Bard', 'Becton Dickinson cash+stock Dec 2017 (~$317)', null],
  COV: ['Covidien', 'Medtronic cash+stock Jan 2015', null],
  SNI: ['Scripps Networks Interactive', 'Discovery cash+stock Mar 2018 (~$90)', null],
  LO: ['Lorillard', 'Reynolds American cash+stock Jun 2015', null],
  LVLT: ['Level 3 Communications', 'CenturyLink cash+stock Nov 2017', null],
  XLS: ['Exelis', 'Harris cash+stock 2015 (~$23.75)', null],
  TYC: ['Tyco International', 'Johnson Controls stock merger Sep 2016', null],
  KRFT: ['Kraft Foods Group', 'Heinz merger -> KHC Jul 2015 (stock)', null],
  DPS: ['Dr Pepper Snapple', 'Keurig -> KDP 2018 + $103.75 special div', null],
  MRKT: ['Markit', 'IHS Markit (INFO) stock merger 2016', null],
  SYRG: ['Synergy Resources', 'renamed SRC Energy (SRCI) 2017', null],
  ACXM: ['Acxiom', 'renamed LiveRamp (RAMP) 2018', null],
  RYL: ['Ryland Group', 'merged -> CalAtlantic (CAA) 2015', null],
  WSH: ['Willis Group', 'merged -> Willis Towers Watson (WTW) 2016', null],
  // MLPs / unit conversions (optional — messy ratios):
  TLLP: ['Tesoro Logistics LP', 'MLP unit ratio (Andeavor)', null],
  TEGP: ['Tallgrass Energy GP', 'MLP reorg', null],
  EVEP: ['EV Energy Partners LP', 'MLP/restructuring', null],
  MWE: ['MarkWest Energy Partners LP', 'MPLX merger 2015 (unit ratio)', null],
  ACMP: ['Access Midstream Partners LP', 'Williams roll-up 2014', null],
  RIGP: ['Transocean Partners LP', 'folded into RIG 2016', null],
  NTI: ['Northern Tier Energy LP', 'Western Refining 2016', null],
  OKS: ['ONEOK Partners', 'ONEOK (OKE) 0.985/unit 2017', null],
  KMP: ['Kinder Morgan Energy Partners', 'rolled into KMI 2014', null],
  AGU: ['Agrium', 'Nutrien (NTR) merger 2018 (2.23 ratio)', null],
  CCP: ['Care Capital Properties', 'Sabra (SBRA) 1.123 ratio 2017', null],
  ARCP: ['American Realty Capital Properties', '-> VEREIT -> Realty Income (gone)', null],
  NYLD: ['NRG Yield', 'renamed Clearway (CWEN-A) 2018', null],
  CLNS: ['Colony NorthStar', '-> Colony Capital / DigitalBridge', null],
  // bankruptcies (~$0):
  FNBC: ['First NBC Bank Holding', 'failed Apr 2017 (~$0)', 0.1],
  SZYM: ['Solazyme / TerraVia', 'bankrupt 2017 (~$0)', 0.2],
  EXXI: ['Energy XXI', 'bankrupt 2016 (~$0)', 0.1],
  // likely OCR / foreign / ambiguous — SKIP unless you can confirm:
  NYSE: ['(OCR garble?)', 'SKIP', null], BOA: ['(OCR garble?)', 'SKIP', null],
  CHV: ['old Chevron ticker', 'SKIP (likely CVX)', null], CTECBX: ['mutual fund', 'SKIP', null],
  FTTGLX: ['mutual fund', 'SKIP', null], DAWC: ['?', 'SKIP', null], MBD: ['?', 'SKIP', null],
  NGF: ['?', 'SKIP', null], FS: ['?', 'SKIP', null], KRR: ['?', 'SKIP', null],
  VMN: ['?', 'SKIP', null], HS: ['?', 'SKIP', null], DNSKY: ['Danske Bank ADR', 'SKIP', null],
  BRGYY: ['foreign ADR', 'SKIP', null], FCGYF: ['foreign ADR', 'SKIP', null],
  VOLVY: ['Volvo ADR', 'SKIP', null], NTT: ['NTT ADR', 'SKIP', null],
  DCM: ['NTT Docomo ADR', 'SKIP', null], NRBAY: ['foreign ADR', 'SKIP', null],
  WPPGY: ['WPP ADR', 'optional', null], NPSND: ['NPS Pharma', 'optional', null],
  EMG: ['?', 'SKIP', null], DXTR: ['Dex Media', 'SKIP', null], LGP: ['?', 'verify', null],
  IACI: ['old IAC/InterActiveCorp', 'multiple spinoffs - complex', null],
  LMCA: ['Liberty Media Class A', 'tracking-stock reshuffle - complex', null],
  LTD: ['"LTD" 2021 filing - ambiguous', 'verify (LB / BBWI?)', null],
  QTM: ['Quantum Corp', 'check QMCO', null], SGBK: ['small-cap bank', 'verify acquirer', null],
  IXYS: ['IXYS Corp', 'Littelfuse 2018 cash-or-stock', null],
  NEOT: ['Neos Therapeutics?', 'optional', null],
};

const open = new Map();
const cells = new Map(); // 'TK|DATE' -> { tk, date, roles:Set }
const mark = (tk, date, role) => {
  if (!dead.has(tk) || !date) return;
  const k = `${tk}|${date}`;
  if (!cells.has(k)) cells.set(k, { tk, date, roles: new Set() });
  cells.get(k).roles.add(role);
};
for (const t of trades) {
  const gk = `${t.politician.toLowerCase()}|${t.ticker}`;
  if (t.type === 'buy') {
    if (!open.has(gk)) open.set(gk, []);
    open.get(gk).push(t);
  } else {
    const q = open.get(gk);
    if (q && q.length) {
      const b = q.shift();
      mark(b.ticker, b.disclosureDate, 'entry');
      mark(t.ticker, t.disclosureDate, 'exit');
    }
  }
}
for (const [, q] of open) for (const b of q) mark(b.ticker, b.disclosureDate, 'entry-open');

const cnt = new Map();
for (const c of cells.values()) cnt.set(c.tk, (cnt.get(c.tk) || 0) + 1);
const esc = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const rows = [['ticker', 'date', 'close', 'role', 'company', 'event_or_note']];
const sorted = [...cells.values()].sort(
  (a, b) => cnt.get(b.tk) - cnt.get(a.tk) || a.tk.localeCompare(b.tk) || a.date.localeCompare(b.date)
);
for (const c of sorted) {
  const info = INFO[c.tk] || ['', ''];
  rows.push([c.tk, c.date, '', [...c.roles].join('+'), info[0] || '', info[1] || 'look up historical close']);
}
// One deal-price row per ticker that still has OPEN positions, so they close at the
// buyout price instead of being dropped. Pre-filled where the deal was all-cash.
const hasOpen = new Set([...cells.values()].filter((c) => c.roles.has('entry-open')).map((c) => c.tk));
for (const tk of [...hasOpen].sort((a, b) => cnt.get(b) - cnt.get(a))) {
  const info = INFO[tk] || ['', ''];
  const deal = info[2];
  rows.push([tk, 'DELIST', deal == null ? '' : String(deal), 'deal-price', info[0] || '', `deal/delisting price for still-open positions; ${info[1] || ''}`]);
}
const csv = rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
await writeFile('data/manual_prices.csv', csv);
console.log(`wrote data/manual_prices.csv: ${sorted.length} date-cells + ${hasOpen.size} deal-price rows across ${cnt.size} tickers`);
