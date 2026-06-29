// One-shot (re-runnable) importer for the pre-2020 House gap.
//
// The House Clerk only published pre-2016 PTRs as scanned image PDFs, so our OCR
// backfill could recover almost nothing before 2016 (we had 4 trades in 2014, 76
// in 2015). The community project `TattooedHead/house-stock-watcher-data` already
// did the hard parsing and publishes a clean, structured JSON of House trades back
// to 2012. Its README states "Free public House of Representatives stock trade
// disclosures" and the underlying data is public-domain U.S. government disclosure
// records, so it's safe to reuse with attribution (source: "House Stock Watcher").
//
// This script fetches that dataset, maps it to our tracked_trades.json schema, and
// appends ONLY rows we don't already have. Dedup is intentionally stricter than the
// index's own (politician + buy/sell + ticker + transaction date, ignoring the
// disclosure date and amount, which differ in format between sources) so a row that
// merely restates a trade we already tracked can't slip in and double-count.
//
// Idempotent: re-running adds nothing once everything is imported. No paid APIs.

import { readState, writeState } from './stateStore.js';

const HSW_URL =
  process.env.HSW_URL ||
  'https://raw.githubusercontent.com/TattooedHead/house-stock-watcher-data/main/data/all_transactions.json';

const normName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b(hon|honorable|jr|sr|ii|iii|iv|dr|mr|mrs|ms|rep|representative)\b/g, '')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Collapse to the three coarse actions; "Sale (Full)"/"Sale (Partial)"/"Sale" all
// match, since HSW only records "Sale".
const action = (t) => {
  const s = String(t || '').toLowerCase();
  if (s.startsWith('purchase') || s === 'buy') return 'buy';
  if (s.startsWith('sale') || s.startsWith('sell')) return 'sell';
  if (s.startsWith('exchange')) return 'exchange';
  return s;
};

const isoDate = (d) => {
  const m = String(d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return String(d || '');
};

// HSW asset_description often carries embedded NUL/control bytes — strip them.
const cleanAsset = (s) =>
  String(s || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const dedupKey = (politician, type, ticker, transactionDate) =>
  [normName(politician), action(type), String(ticker || '').toUpperCase().trim(), transactionDate].join('|');

async function main() {
  console.log(`[importHsw] fetching ${HSW_URL}`);
  const res = await fetch(HSW_URL);
  if (!res.ok) throw new Error(`HSW fetch failed: ${res.status}`);
  const hsw = await res.json();
  console.log(`[importHsw] fetched ${hsw.length} House rows`);

  const tracked = await readState('tracked_trades.json', []);
  const hist = await readState('alert_history.json', []);

  // Existing keys from BOTH sources the index reads, so we never re-add a known trade.
  const seen = new Set();
  for (const t of [...tracked, ...hist]) {
    seen.add(dedupKey(t.politician, t.type, t.ticker, t.transactionDate));
  }

  const before = tracked.length;
  let added = 0;
  const addedByYear = {};
  for (const r of hsw) {
    const ticker = String(r.ticker || '').trim();
    if (!ticker || ticker === '--') continue; // unpriceable without a symbol
    const transactionDate = isoDate(r.transaction_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) continue;
    const k = dedupKey(r.representative, r.type, ticker, transactionDate);
    if (seen.has(k)) continue;
    seen.add(k); // also dedup within the HSW file itself
    tracked.push({
      chamber: 'house',
      politician: String(r.representative || '').trim(),
      bioguide: '',
      ticker: ticker.toUpperCase(),
      asset: cleanAsset(r.asset_description),
      type: r.type,
      amount: r.amount || '',
      transactionDate,
      disclosureDate: isoDate(r.disclosure_date),
      source: 'House Stock Watcher',
    });
    added++;
    const y = transactionDate.slice(0, 4);
    addedByYear[y] = (addedByYear[y] || 0) + 1;
  }

  await writeState('tracked_trades.json', tracked);
  console.log(`[importHsw] tracked_trades.json: ${before} -> ${tracked.length} (+${added})`);
  console.log(`[importHsw] added by year: ${JSON.stringify(Object.fromEntries(Object.entries(addedByYear).sort()))}`);
}

main().catch((e) => {
  console.error(`[importHsw] failed: ${e.message}`);
  process.exit(1);
});
