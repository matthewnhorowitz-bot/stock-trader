// Scrapes the official House Clerk disclosures for Periodic Transaction Reports.
//
//   1. Download /public_disc/financial-pdfs/<YEAR>FD.ZIP  -> contains <YEAR>FD.xml
//      (an index of every filing; FilingType "P" == Periodic Transaction Report)
//   2. For each PTR: GET /public_disc/ptr-pdfs/<YEAR>/<DocID>.pdf
//   3. Extract the PDF text (e-filed PTRs are real text) and parse the transactions.
//
// Scanned/paper PTRs yield no parseable text and are skipped (counted).

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const pdf = require('pdf-parse');

const BASE = 'https://disclosures-clerk.house.gov/public_disc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) congress-trade-notifier';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : '';
};

// Returns PTR index entries for a year: [{ docId, year, first, last, filed }].
async function fetchYearIndex(year) {
  const res = await fetch(`${BASE}/financial-pdfs/${year}FD.ZIP`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${year}FD.ZIP HTTP ${res.status}`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const xmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.xml'));
  if (!xmlEntry) return [];
  const xml = xmlEntry.getData().toString('utf8');
  const members = xml.match(/<Member>([\s\S]*?)<\/Member>/g) || [];
  const out = [];
  for (const m of members) {
    if (tag(m, 'FilingType') !== 'P') continue; // P = Periodic Transaction Report
    const docId = tag(m, 'DocID');
    if (!docId) continue;
    out.push({
      docId,
      year: tag(m, 'Year') || String(year),
      first: tag(m, 'First'),
      last: tag(m, 'Last'),
      filed: tag(m, 'FilingDate'), // MM/DD/YYYY
    });
  }
  return out;
}

const toISO = (s) => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || ''));
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};

// Parse one PTR PDF's text into normalized trades.
function parsePdfText(text, member) {
  const trades = [];
  // Tickers: "... (GOOGL) [ST]" — capture ticker + position in the text.
  const tickerRe = /\(([A-Z][A-Z.\-]{0,6})\)\s*\[[A-Z]{1,3}\]/g;
  const tickers = [];
  let tm;
  while ((tm = tickerRe.exec(text))) tickers.push({ sym: tm[1], idx: tm.index });
  // Transaction lines: type S|P|E, txn date, notification date, amount range.
  const txnRe = /([SPE])\s?(\d{2}\/\d{2}\/\d{4})\s?(\d{2}\/\d{2}\/\d{4})\s?(\$[\d,]+\s*-\s*\$[\d,]+)/g;
  let xm;
  while ((xm = txnRe.exec(text))) {
    const idx = xm.index;
    // nearest preceding ticker
    let sym = '';
    for (const t of tickers) {
      if (t.idx <= idx) sym = t.sym;
      else break;
    }
    const type = xm[1] === 'P' ? 'Purchase' : xm[1] === 'S' ? 'Sale' : 'Exchange';
    trades.push({
      chamber: 'house',
      politician: member,
      bioguide: '',
      ticker: sym,
      asset: '',
      type,
      amount: xm[4].replace(/\s+/g, ' ').trim(),
      transactionDate: toISO(xm[2]),
      disclosureDate: toISO(xm[3]),
      source: 'House Clerk',
    });
  }
  return trades;
}

async function fetchPtrPdf(entry) {
  const res = await fetch(`${BASE}/ptr-pdfs/${entry.year}/${entry.docId}.pdf`, { headers: { 'User-Agent': UA } });
  if (!res.ok) return { trades: [], ok: false };
  try {
    const data = await pdf(Buffer.from(await res.arrayBuffer()));
    const member = `${entry.first} ${entry.last}`.trim();
    const trades = parsePdfText(data.text, member);
    // tag disclosure date from the index if the PDF parse missed it
    for (const t of trades) if (!t.disclosureDate) t.disclosureDate = toISO(entry.filed);
    return { trades, ok: true };
  } catch {
    return { trades: [], ok: false }; // scanned/unparseable
  }
}

// Yields normalized trades for the given years. Resumable via isDone(docId).
export async function fetchHouseClerkTrades({ years = [2023, 2024, 2025, 2026], maxDocs = Infinity, isDone = () => false, throttleMs = 300 } = {}) {
  const out = [];
  const processedDocIds = [];
  let processed = 0;
  let skipped = 0;
  for (const year of years) {
    let index;
    try {
      index = await fetchYearIndex(year);
    } catch (e) {
      console.error(`[house] ${e.message}`);
      continue;
    }
    for (const entry of index) {
      if (processed >= maxDocs) break;
      if (isDone(entry.docId)) continue;
      const { trades, ok } = await fetchPtrPdf(entry);
      if (!ok) skipped++;
      out.push(...trades);
      processedDocIds.push(entry.docId); // mark done even if scanned/empty
      processed++;
      if (throttleMs) await sleep(throttleMs);
    }
    if (processed >= maxDocs) break;
  }
  out.meta = { processed, skipped };
  out.processedDocIds = processedDocIds;
  return out;
}
