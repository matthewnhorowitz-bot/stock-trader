// Scrapes the official House Clerk disclosures for Periodic Transaction Reports.
//
//   1. Download /public_disc/financial-pdfs/<YEAR>FD.ZIP  -> contains <YEAR>FD.xml
//      (an index of every filing; FilingType "P" == Periodic Transaction Report)
//   2. For each PTR: GET /public_disc/ptr-pdfs/<YEAR>/<DocID>.pdf
//   3. Extract the PDF text (e-filed PTRs are real text) and parse the transactions.
//
// Scanned/paper PTRs yield no parseable text and are skipped (counted).

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const pdf = require('pdf-parse');

const BASE = 'https://disclosures-clerk.house.gov/public_disc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) congress-trade-notifier';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- OCR for scanned (pre-2020) House PTRs ------------------------------------
// Older House PTRs are scanned image PDFs with no text layer, so pdf-parse returns
// nothing. When OCR is enabled we rasterize with poppler (pdftoppm) and OCR each
// page with tesseract — both standard CLI tools we install in the CI runner. On a
// box without them (e.g. local Windows dev) ocrAvailable() is false and we skip.
let _ocrAvail = null;
function ocrAvailable() {
  if (_ocrAvail != null) return _ocrAvail;
  // If the binary exists, spawnSync sets no `.error` (ENOENT) regardless of exit code.
  const has = (cmd) => !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;
  _ocrAvail = has('pdftoppm') && has('tesseract');
  return _ocrAvail;
}

// Rasterize a PDF and OCR every page; returns concatenated text ('' on failure).
function ocrPdfToText(buffer) {
  if (!ocrAvailable()) return '';
  const dir = mkdtempSync(join(tmpdir(), 'ptr-ocr-'));
  try {
    const pdfPath = join(dir, 'in.pdf');
    writeFileSync(pdfPath, buffer);
    const r = spawnSync('pdftoppm', ['-png', '-r', '300', pdfPath, join(dir, 'pg')], { stdio: 'ignore' });
    if (r.status !== 0) return '';
    const pages = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    let text = '';
    for (const p of pages) {
      const o = spawnSync('tesseract', [join(dir, p), 'stdout', '--psm', '6'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (o.status === 0 && o.stdout) text += o.stdout + '\n';
    }
    return text;
  } catch {
    return '';
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

// Tolerant parser for OCR'd paper PTRs (the form layout differs from the e-filed
// PDFs parsePdfText handles, and OCR is noisy). Pulls transaction records by the
// type + date + $low-$high shape and attaches the nearest preceding ticker; rows
// with no recoverable ticker are dropped (they can't be priced).
export function parseOcrText(text, member, filed) {
  const trades = [];
  const tickerRe = /\(([A-Z][A-Z.\-]{0,5})\)/g;
  const tickers = [];
  let tm;
  while ((tm = tickerRe.exec(text))) tickers.push({ sym: tm[1], idx: tm.index });
  // e.g. "P 03/14/2017 04/02/2017 $1,001 - $15,000" with OCR slop in the gaps.
  const txnRe =
    /\b(Purchase|Sale|Exchange|[PSE])\b[^$\n]{0,60}?(\d{1,2}\/\d{1,2}\/\d{4})[^$\n]{0,60}?\$\s?([\d,]+)\s*[-–—]\s*\$\s?([\d,]+)/gi;
  let xm;
  let prevEnd = 0; // a ticker only belongs to this txn if it sits AFTER the previous txn
  while ((xm = txnRe.exec(text))) {
    // nearest ticker in the window (prevEnd, xm.index) — avoids a ticker-less asset
    // wrongly inheriting the previous transaction's ticker.
    let sym = '';
    for (const t of tickers) {
      if (t.idx > prevEnd && t.idx < xm.index) sym = t.sym;
      else if (t.idx >= xm.index) break;
    }
    prevEnd = xm.index + xm[0].length;
    if (!sym) continue;
    const tRaw = xm[1].toUpperCase();
    const type = tRaw[0] === 'P' ? 'Purchase' : tRaw[0] === 'S' ? 'Sale' : 'Exchange';
    trades.push({
      chamber: 'house',
      politician: member,
      bioguide: '',
      ticker: sym,
      asset: '',
      type,
      amount: `$${xm[3]} - $${xm[4]}`,
      transactionDate: toISO(xm[2]),
      disclosureDate: toISO(filed),
      source: 'House Clerk OCR',
    });
  }
  return trades;
}

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

// Returns { trades, ocrUsed, needsOcr }. needsOcr=true means the text layer was empty
// and we did NOT OCR (budget not allowed this call) — the caller should leave the PTR
// un-marked so a later run can OCR it instead of permanently skipping it.
async function fetchPtrPdf(entry, { allowOcr = false } = {}) {
  const res = await fetch(`${BASE}/ptr-pdfs/${entry.year}/${entry.docId}.pdf`, { headers: { 'User-Agent': UA } });
  if (!res.ok) return { trades: [], ocrUsed: false, needsOcr: false };
  const buf = Buffer.from(await res.arrayBuffer());
  const member = `${entry.first} ${entry.last}`.trim();
  let trades = [];
  try {
    const data = await pdf(buf);
    trades = parsePdfText(data.text, member); // e-filed PDFs have a real text layer
  } catch {
    trades = []; // scanned/unparseable text layer
  }
  let ocrUsed = false;
  if (trades.length === 0) {
    if (allowOcr && ocrAvailable()) {
      ocrUsed = true;
      const otext = ocrPdfToText(buf);
      if (otext) trades = parseOcrText(otext, member, entry.filed);
    } else if (allowOcr === false) {
      // text layer empty and OCR not attempted (budget) — needs a future OCR pass
      return { trades: [], ocrUsed: false, needsOcr: true };
    }
  }
  // tag disclosure date from the index if a PDF/OCR parse missed it
  for (const t of trades) if (!t.disclosureDate) t.disclosureDate = toISO(entry.filed);
  return { trades, ocrUsed, needsOcr: false };
}

// "Latest" mode for the live alert poll: parse the most-recently-FILED House PTRs
// (current year, plus prior year during the January rollover), newest first.
export async function fetchHouseLatest({ maxDocs = 20, throttleMs = 250 } = {}) {
  const now = new Date();
  const years = [now.getUTCFullYear()];
  if (now.getUTCMonth() === 0) years.push(now.getUTCFullYear() - 1);
  let index = [];
  for (const y of years) {
    try {
      index.push(...(await fetchYearIndex(y)));
    } catch (e) {
      console.error(`[house] ${e.message}`);
    }
  }
  index.sort((a, b) => toISO(b.filed).localeCompare(toISO(a.filed))); // newest filed first
  const out = [];
  for (const entry of index.slice(0, maxDocs)) {
    const { trades } = await fetchPtrPdf(entry);
    out.push(...trades);
    if (throttleMs) await sleep(throttleMs);
  }
  return out;
}

// Yields normalized trades for the given years. Resumable via isDone(docId).
// `ocrMax` bounds how many scanned PDFs we OCR per run (OCR is slow, ~5-15s each);
// when the budget is hit we STOP the run rather than marking remaining scanned PTRs
// done, so a later run resumes OCR'ing them instead of skipping them forever.
export async function fetchHouseClerkTrades({
  years = [2023, 2024, 2025, 2026],
  maxDocs = Infinity,
  isDone = () => false,
  throttleMs = 300,
  ocrMax = 0,
} = {}) {
  const out = [];
  const processedDocIds = [];
  let processed = 0;
  let skipped = 0;
  let ocrUsed = 0;
  let ocrTxns = 0;
  let budgetHit = false;
  for (const year of years) {
    if (budgetHit) break;
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
      const allowOcr = ocrUsed < ocrMax;
      const { trades, ocrUsed: usedOcr, needsOcr } = await fetchPtrPdf(entry, { allowOcr });
      if (needsOcr) {
        budgetHit = true; // out of OCR budget — leave this PTR un-marked and stop
        break;
      }
      if (usedOcr) {
        ocrUsed++;
        ocrTxns += trades.length;
      }
      if (!trades.length) skipped++;
      out.push(...trades);
      processedDocIds.push(entry.docId); // mark done (parsed, OCR'd, or genuinely empty)
      processed++;
      if (throttleMs) await sleep(throttleMs);
    }
    if (processed >= maxDocs) break;
  }
  out.meta = { processed, skipped, ocrUsed, ocrTxns };
  out.processedDocIds = processedDocIds;
  return out;
}
