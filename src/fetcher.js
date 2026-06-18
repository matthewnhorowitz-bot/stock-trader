// Pulls congressional stock-trade disclosures (filed under the STOCK Act) and
// normalizes every provider into one shape the rest of the app consumes:
//
//   { chamber, politician, ticker, asset, type, amount:{low,high,raw},
//     transactionDate, disclosureDate, source, id }
//
// The data source is pluggable via DATA_PROVIDER in .env:
//
//   sample       (default) — bundled offline dataset; zero setup, always works.
//   fmp          — Financial Modeling Prep (needs a free FMP_API_KEY).
//   finnhub      — Finnhub (needs a free FINNHUB_API_KEY).
//   stockwatcher — legacy House/Senate Stock Watcher S3 (no key; may be offline).
//
// Why pluggable: the old free, no-key Stock Watcher JSON buckets that this kind
// of tool used to rely on are now access-locked (HTTP 403). Rather than break on
// first run, we default to bundled sample data and let you point at a live feed
// with one env var + a free API key.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────────

// "$1,001 - $15,000" -> { low: 1001, high: 15000, raw }
function parseAmount(raw) {
  if (raw == null) return { low: 0, high: 0, raw: '' };
  if (typeof raw === 'number') return { low: raw, high: raw, raw: `$${raw.toLocaleString()}` };
  const nums = String(raw).match(/[\d,]+/g);
  if (!nums) return { low: 0, high: 0, raw: String(raw) };
  const vals = nums.map((n) => Number(n.replace(/,/g, '')));
  return { low: vals[0] ?? 0, high: vals[1] ?? vals[0] ?? 0, raw: String(raw) };
}

// Map the many disclosed transaction-type strings to buy | sell | exchange.
function normalizeType(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('purchase') || s === 'buy' || s === 'p') return 'buy';
  if (s.includes('sale') || s.includes('sell') || s === 's') return 'sell';
  if (s.includes('exchange') || s === 'e') return 'exchange';
  return s || 'unknown';
}

function clean(t) {
  return {
    chamber: t.chamber || 'unknown',
    politician: t.politician || 'Unknown',
    ticker: (t.ticker && t.ticker !== '--' ? t.ticker : '').toUpperCase(),
    asset: t.asset || '',
    type: normalizeType(t.type),
    amount: t.amount && typeof t.amount === 'object' ? t.amount : parseAmount(t.amount),
    transactionDate: t.transactionDate || '',
    disclosureDate: t.disclosureDate || '',
    source: t.source || 'unknown',
  };
}

// Stable id so we can dedupe across polls regardless of source ordering.
export function tradeId(t) {
  return [t.chamber, t.politician, t.ticker || t.asset, t.type, t.transactionDate, t.amount.raw, t.disclosureDate]
    .join('|')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'congress-trade-notifier/1.0', Accept: 'application/json', ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// ── providers ────────────────────────────────────────────────────────────────

async function fromSample() {
  const raw = await readFile(join(__dirname, '..', 'data', 'sample_trades.json'), 'utf8');
  return JSON.parse(raw);
}

// Financial Modeling Prep — https://site.financialmodelingprep.com/developer/docs
async function fromFmp() {
  const key = config.providers.fmpKey;
  if (!key) throw new Error('DATA_PROVIDER=fmp but FMP_API_KEY is not set.');
  const base = 'https://financialmodelingprep.com/stable';
  const [senate, house] = await Promise.all([
    fetchJson(`${base}/senate-latest?page=0&limit=100&apikey=${key}`),
    fetchJson(`${base}/house-latest?page=0&limit=100&apikey=${key}`),
  ]);
  const map = (rows, chamber) =>
    (Array.isArray(rows) ? rows : []).map((r) => ({
      chamber,
      politician: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.office || 'Unknown',
      ticker: r.symbol,
      asset: r.assetDescription || r.symbol,
      type: r.type,
      amount: parseAmount(r.amount),
      transactionDate: r.transactionDate || r.date,
      disclosureDate: r.disclosureDate || r.dateRecieved || '',
      source: 'Financial Modeling Prep',
    }));
  return [...map(senate, 'senate'), ...map(house, 'house')];
}

// Finnhub — https://finnhub.io/docs/api/congressional-trading
async function fromFinnhub() {
  const key = config.providers.finnhubKey;
  if (!key) throw new Error('DATA_PROVIDER=finnhub but FINNHUB_API_KEY is not set.');
  const symbols = config.providers.finnhubSymbols;
  if (!symbols.length) throw new Error('DATA_PROVIDER=finnhub requires FINNHUB_SYMBOLS (Finnhub queries per ticker).');
  const out = [];
  for (const sym of symbols) {
    const json = await fetchJson(`https://finnhub.io/api/v1/stock/congressional-trading?symbol=${sym}&token=${key}`);
    for (const r of json.data || []) {
      out.push({
        chamber: /sen/i.test(r.position || '') ? 'senate' : 'house',
        politician: r.name,
        ticker: json.symbol || sym,
        asset: json.symbol || sym,
        type: r.transactionType,
        amount: { low: r.amountFrom || 0, high: r.amountTo || 0, raw: r.amountFrom ? `$${r.amountFrom} - $${r.amountTo}` : '' },
        transactionDate: r.transactionDate,
        disclosureDate: r.filingDate || '',
        source: 'Finnhub',
      });
    }
  }
  return out;
}

// Legacy Stock Watcher S3 buckets (kept as best-effort; may return 403).
async function fromStockWatcher() {
  const urls = {
    house: 'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
    senate: 'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json',
  };
  const results = await Promise.allSettled([
    fetchJson(urls.house).then((rows) =>
      rows.map((r) => ({ ...r, chamber: 'house', politician: r.representative, source: 'House Stock Watcher' }))
    ),
    fetchJson(urls.senate).then((rows) =>
      rows.map((r) => ({ ...r, chamber: 'senate', politician: r.senator, source: 'Senate Stock Watcher' }))
    ),
  ]);
  const trades = [];
  ['House', 'Senate'].forEach((label, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') trades.push(...r.value);
    else console.error(`[fetcher] ${label} Stock Watcher failed: ${r.reason.message}`);
  });
  if (!trades.length) throw new Error('Stock Watcher buckets returned no data (they are often access-locked).');
  return trades;
}

const PROVIDERS = {
  sample: fromSample,
  fmp: fromFmp,
  finnhub: fromFinnhub,
  stockwatcher: fromStockWatcher,
};

// ── public API ───────────────────────────────────────────────────────────────

export async function fetchAllTrades() {
  const name = config.dataProvider;
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown DATA_PROVIDER "${name}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const raw = await provider();
  return raw.map(clean).map((t) => ({ ...t, id: tradeId(t) }));
}
