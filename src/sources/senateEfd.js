// Scrapes the official Senate eFD (efdsearch.senate.gov) for Periodic Transaction
// Reports (PTRs) and parses each report's transactions table.
//
// Flow (verified):
//   1. GET  /search/home/            -> sets csrftoken cookie
//   2. POST /search/home/            prohibition_agreement=1  (accept the notice)
//   3. POST /search/report/data/     -> paginated JSON list of PTRs (each links a uuid)
//   4. GET  /search/view/ptr/<uuid>/ -> HTML page with a transactions table
//
// Cookies/CSRF are handled manually (no cookie jar in Node fetch).

const BASE = 'https://efdsearch.senate.gov';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 congress-trade-notifier';

function parseSetCookie(res, jar) {
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of cookies) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startSession() {
  const jar = {};
  const home = await fetch(`${BASE}/search/home/`, { headers: { 'User-Agent': UA } });
  parseSetCookie(home, jar);
  const agree = await fetch(`${BASE}/search/home/`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${BASE}/search/home/`,
      'X-CSRFToken': jar.csrftoken,
      Cookie: cookieHeader(jar),
    },
    body: `csrfmiddlewaretoken=${jar.csrftoken}&prohibition_agreement=1`,
  });
  parseSetCookie(agree, jar);
  return jar;
}

// One page of the PTR list. Returns [{ first, last, uuid, filed }].
async function fetchPtrPage(jar, start, length, sinceMMDDYYYY) {
  const body = new URLSearchParams();
  body.set('draw', '1');
  body.set('start', String(start));
  body.set('length', String(length));
  body.append('report_types', '[11]'); // Periodic Transaction Report
  body.set('submitted_start_date', `${sinceMMDDYYYY} 00:00:00`);
  body.set('submitted_end_date', '');
  body.set('search[value]', '');
  body.set('search[regex]', 'false');
  const res = await fetch(`${BASE}/search/report/data/`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${BASE}/search/`,
      'X-CSRFToken': jar.csrftoken,
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieHeader(jar),
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`report/data HTTP ${res.status}`);
  const json = await res.json();
  const rows = json.data || [];
  return {
    total: json.recordsTotal || 0,
    items: rows
      .map((r) => {
        const m = /\/search\/view\/ptr\/([0-9a-f-]+)\//.exec(r[3] || '');
        return m ? { first: r[0], last: r[1], uuid: m[1], filed: r[4] } : null;
      })
      .filter(Boolean),
  };
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#35;/g, '#').replace(/\s+/g, ' ').trim();

// Parse the transactions table on a PTR page into normalized trades.
function parsePtrHtml(html, member, filed) {
  const trades = [];
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/i.exec(html);
  if (!tbody) return trades;
  const rows = tbody[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((c) => stripTags(c));
    // columns: # | Transaction Date | Owner | Ticker | Asset Name | Asset Type | Type | Amount | Comment
    if (cells.length < 8) continue;
    const ticker = cells[3] === '--' ? '' : cells[3];
    trades.push({
      chamber: 'senate',
      politician: member,
      bioguide: '',
      ticker: ticker.toUpperCase(),
      asset: cells[4] || '',
      type: cells[6] || '',
      amount: cells[7] || '',
      transactionDate: toISO(cells[1]),
      disclosureDate: toISO(filed),
      source: 'Senate eFD',
    });
  }
  return trades;
}

// "06/16/2026" -> "2026-06-16"
function toISO(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || ''));
  return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
}

async function fetchPtr(jar, uuid, member, filed) {
  const res = await fetch(`${BASE}/search/view/ptr/${uuid}/`, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader(jar), Referer: `${BASE}/search/` },
  });
  if (!res.ok) return [];
  return parsePtrHtml(await res.text(), member, filed);
}

// Yields normalized trades. `isDone(uuid)` lets the caller skip already-parsed PTRs
// (resumability). `onProgress(uuid)` is called after each PTR so the caller can persist.
export async function fetchSenateTrades({ sinceMMDDYYYY = '01/01/2022', maxPtrs = Infinity, isDone = () => false, throttleMs = 400 } = {}) {
  const jar = await startSession();
  const out = [];
  const processedUuids = [];
  const first = await fetchPtrPage(jar, 0, 100, sinceMMDDYYYY);
  const total = first.total;
  let processed = 0;
  for (let start = 0; start < total && processed < maxPtrs; start += 100) {
    const page = start === 0 ? first : await fetchPtrPage(jar, start, 100, sinceMMDDYYYY);
    for (const it of page.items) {
      if (processed >= maxPtrs) break;
      if (isDone(it.uuid)) continue;
      const member = `${it.first} ${it.last}`.trim();
      try {
        out.push(...(await fetchPtr(jar, it.uuid, member, it.filed)));
      } catch {
        /* skip a bad PTR */
      }
      processedUuids.push(it.uuid); // mark done even if parse was empty, so we don't retry
      processed++;
      if (throttleMs) await sleep(throttleMs);
    }
  }
  out.meta = { total, processed };
  out.processedUuids = processedUuids;
  return out;
}
