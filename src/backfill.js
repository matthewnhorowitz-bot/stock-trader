// One-time (resumable) historical backfill of congressional trades since ~2020,
// merged into data/tracked_trades.json for the performance index. Sources:
//   - Senate eFD            (2022+, complete)         src/sources/senateEfd.js
//   - House Clerk PDFs       (2023+, e-filed)          src/sources/houseClerk.js
//   - House mirror CSV       (2020-2022, one-time)     GitHub snapshot
//
// Processes a bounded batch per run and records progress in data/backfill_state.json
// so it can be run repeatedly (locally or in CI) until coverage is complete, without
// re-doing finished work or blowing past polite/rate limits.

import { readState, writeState } from './stateStore.js';
import { fetchSenateTrades } from './sources/senateEfd.js';
import { fetchHouseClerkTrades } from './sources/houseClerk.js';

const MIRROR_CSV =
  'https://raw.githubusercontent.com/noodleslove/House-of-Representative-Analysis-I/master/data/all_transactions.csv';

const SENATE_BATCH = Number(process.env.BACKFILL_SENATE_BATCH || 150);
const HOUSE_BATCH = Number(process.env.BACKFILL_HOUSE_BATCH || 150);
// Senate eFD has structured PTRs back to ~2012 (STOCK Act); paper filings are skipped.
const SENATE_SINCE = process.env.BACKFILL_SENATE_SINCE || '01/01/2012';
// House Clerk e-filed PTRs: 2014-2019 are mostly scanned (unparseable, skipped) but we try;
// 2020-2022 come from the mirror CSV below; 2023+ are e-filed text.
const HOUSE_YEARS = (process.env.BACKFILL_HOUSE_YEARS || '2014,2015,2016,2017,2018,2019,2023,2024,2025,2026')
  .split(',')
  .map((y) => Number(y.trim()));

const tkey = (t) =>
  [t.politician, t.type, t.ticker, t.transactionDate, t.disclosureDate, t.amount].join('|').toLowerCase();

// Minimal quote-aware CSV row splitter.
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
const toISO = (s) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || ''));
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};

async function importMirror() {
  const res = await fetch(MIRROR_CSV, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`mirror CSV HTTP ${res.status}`);
  const lines = (await res.text()).split('\n');
  const trades = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = splitCsv(lines[i]);
    // disclosure_year,disclosure_date,transaction_date,owner,ticker,asset_description,type,amount,representative,...
    const txn = toISO(c[2]);
    if (!txn || !/^20(2[0-2])/.test(txn)) continue; // keep 2020-2022, drop garbage dates
    const ticker = c[4] && c[4] !== '--' ? c[4].toUpperCase() : '';
    if (!ticker) continue;
    trades.push({
      chamber: 'house',
      politician: (c[8] || '').replace(/^Hon\.\s*/i, '').trim(),
      ticker,
      asset: c[5] || '',
      type: c[6] || '',
      amount: (c[7] || '').replace(/"/g, '').trim(),
      transactionDate: txn,
      disclosureDate: toISO(c[1]),
      source: 'House mirror',
    });
  }
  return trades;
}

async function main() {
  const tracked = await readState('tracked_trades.json', []);
  const state = await readState('backfill_state.json', { senateUuids: [], houseDocIds: [], mirrorDone: false });
  const seen = new Set(tracked.map(tkey));
  const senateDone = new Set(state.senateUuids);
  const houseDone = new Set(state.houseDocIds);
  const before = tracked.length;

  const add = (arr) => {
    for (const t of arr) {
      if (!t.ticker || !t.disclosureDate) continue;
      const k = tkey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      tracked.push(t);
    }
  };

  // 1) House mirror (one-time)
  if (!state.mirrorDone) {
    try {
      const m = await importMirror();
      add(m);
      state.mirrorDone = true;
      console.log(`[backfill] mirror: imported ${m.length} House 2020-22 trades`);
    } catch (e) {
      console.error(`[backfill] mirror failed: ${e.message}`);
    }
  }

  // 2) Senate eFD batch
  try {
    const sen = await fetchSenateTrades({
      sinceMMDDYYYY: SENATE_SINCE,
      maxPtrs: SENATE_BATCH,
      isDone: (uuid) => senateDone.has(uuid),
      throttleMs: 400,
    });
    add(sen);
    // mark the processed PTRs done (we walked them in order; record every uuid we touched)
    for (const t of sen) {
      /* uuids aren't on trades; we approximate by recording via meta below */
    }
    console.log(`[backfill] senate: +${sen.length} txns from ${sen.meta.processed} PTR(s) (of ${sen.meta.total})`);
    // NOTE: senate progress is tracked by the source walking from the top each run and
    // skipping isDone; to advance, record all uuids seen this run:
    if (sen.processedUuids) sen.processedUuids.forEach((u) => senateDone.add(u));
  } catch (e) {
    console.error(`[backfill] senate failed: ${e.message}`);
  }

  // 3) House Clerk batch
  try {
    const hc = await fetchHouseClerkTrades({
      years: HOUSE_YEARS,
      maxDocs: HOUSE_BATCH,
      isDone: (docId) => houseDone.has(docId),
      throttleMs: 300,
    });
    add(hc);
    if (hc.processedDocIds) hc.processedDocIds.forEach((d) => houseDone.add(d));
    console.log(`[backfill] house: +${hc.length} txns from ${hc.meta.processed} PTR(s), ${hc.meta.skipped} unparseable`);
  } catch (e) {
    console.error(`[backfill] house failed: ${e.message}`);
  }

  state.senateUuids = [...senateDone];
  state.houseDocIds = [...houseDone];
  await writeState('tracked_trades.json', tracked);
  await writeState('backfill_state.json', state);
  console.log(`[backfill] tracked_trades.json: ${before} -> ${tracked.length} (+${tracked.length - before})`);
}

main().catch((e) => {
  console.error('backfill failed:', e.message);
  process.exit(1);
});
