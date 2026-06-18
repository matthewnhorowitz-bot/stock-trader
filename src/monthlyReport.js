// End-of-month digest of the "major" trades seen during the month.
//
// Triggered off the normal hourly run (no separate scheduler): each run checks
// whether the calendar month has changed since the last run. The first run of a
// new month sends one report covering the month that just ended, then records
// the new month so it fires only once. This is robust to GitHub dropping the
// exact midnight run — whenever the next run lands, the report still goes out.

import { config } from './config.js';
import { readState, writeState } from './stateStore.js';
import { sendDigest } from './notifier.js';

const STATE = 'report_state.json';

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthName(key) {
  const [y, m] = key.split('-');
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// "$1,001 - $15,000" -> { low: 1001, high: 15000 }
function parseRange(raw) {
  const nums = String(raw || '').match(/[\d,]+/g);
  if (!nums) return { low: 0, high: 0 };
  const v = nums.map((n) => Number(n.replace(/,/g, '')));
  return { low: v[0] || 0, high: v[1] || v[0] || 0 };
}

function buildReport(reportMonth, history, minValue) {
  const major = history
    .filter((h) => (h.alertedAt || '').startsWith(reportMonth))
    .map((h) => ({ ...h, _amt: parseRange(h.amount) }))
    .filter((h) => h._amt.high >= minValue) // major = high end of the range >= threshold
    .sort((a, b) => b._amt.high - a._amt.high);

  const title = `📊 ${monthName(reportMonth)} — notable congressional trades`;
  const pretty = `$${minValue.toLocaleString()}`;

  if (major.length === 0) {
    return { title, body: `No trades of ${pretty}+ were disclosed in ${monthName(reportMonth)}.`, count: 0 };
  }

  const CAP = 25;
  const lines = major.slice(0, CAP).map((h) => {
    const act = h.type === 'buy' ? 'BUY' : h.type === 'sell' ? 'SELL' : String(h.type).toUpperCase();
    return `${h.politician} ${act} ${h.ticker || h.asset} ${h.amount} (${h.transactionDate})`;
  });
  if (major.length > CAP) lines.push(`+${major.length - CAP} more`);
  return {
    title,
    body: `${major.length} notable trade(s) of ${pretty}+:\n` + lines.join('\n'),
    count: major.length,
  };
}

// Call once per poll. Sends a report the first time a new month is observed.
export async function maybeSendMonthlyReport() {
  const cur = monthKey(new Date());
  const state = await readState(STATE, null);

  // Bootstrap: first run ever — just remember the month, don't send a partial report.
  if (state === null || !state.lastMonth) {
    await writeState(STATE, { lastMonth: cur });
    return;
  }
  if (state.lastMonth === cur) return; // still the same month; nothing to do

  const reportMonth = state.lastMonth; // the month that just ended
  const history = await readState('alert_history.json', []);
  const { title, body, count } = buildReport(reportMonth, history, config.monthlyReportMinValue);

  await sendDigest(title, body);
  await writeState(STATE, { lastMonth: cur });
  console.log(`[monthly] Sent ${monthName(reportMonth)} report (${count} notable trade(s)).`);
}

// Exposed so we can preview/test the formatting without waiting for month-end.
export { buildReport };
