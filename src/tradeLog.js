import { readState, writeState, stateMissing } from './stateStore.js';

const SEEN = 'seen.json'; // ids we've already alerted on
const HISTORY = 'alert_history.json'; // full alert records

// Set of trade ids we've already alerted on.
export async function loadSeen() {
  const arr = await readState(SEEN, []);
  return new Set(arr);
}

export async function saveSeen(seenSet) {
  await writeState(SEEN, [...seenSet]);
}

// Given filtered trades, return only the ones we haven't alerted on before.
export async function selectNew(trades) {
  const seen = await loadSeen();
  return trades.filter((t) => !seen.has(t.id));
}

// Mark trades as alerted and append them to the human-readable history log.
export async function recordAlerts(trades) {
  if (trades.length === 0) return;

  const seen = await loadSeen();
  for (const t of trades) seen.add(t.id);
  await saveSeen(seen);

  const history = await readState(HISTORY, []);
  const now = new Date().toISOString();
  for (const t of trades) {
    history.push({
      alertedAt: now,
      politician: t.politician,
      chamber: t.chamber,
      type: t.type,
      ticker: t.ticker,
      asset: t.asset,
      amount: t.amount.raw,
      transactionDate: t.transactionDate,
      disclosureDate: t.disclosureDate,
      source: t.source,
    });
  }
  await writeState(HISTORY, history);
}

// One-time seeding so the FIRST run doesn't blast you with the entire backlog.
// Marks every currently-matching trade as "seen" without alerting.
export async function seedSeen(trades) {
  const seen = await loadSeen();
  for (const t of trades) seen.add(t.id);
  await saveSeen(seen);
  return seen.size;
}

export async function isSeedNeeded() {
  return stateMissing(SEEN); // no seen state yet => first ever run
}

// Detects a one-time data-source switch so we can re-seed (avoid alerting on
// pre-existing trades that get a slightly different id under the new source).
export async function isSourceSeedNeeded(provider) {
  const m = await readState('source_marker.json', null);
  return !m || m.provider !== provider;
}
export async function markSourceSeeded(provider) {
  await writeState('source_marker.json', { provider, at: new Date().toISOString() });
}
