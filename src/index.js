import { config, describeConfig } from './config.js';
import { fetchAllTrades } from './fetcher.js';
import { applyFilters } from './filter.js';
import { notify } from './notifier.js';
import { selectNew, recordAlerts, seedSeen, isSeedNeeded } from './tradeLog.js';

const RUN_ONCE = process.argv.includes('--once');

async function pollOnce() {
  const stamp = new Date().toLocaleString();
  try {
    const all = await fetchAllTrades();
    const matching = applyFilters(all);

    // First ever run: seed the backlog as "seen" so we don't alert on years
    // of history. After that, only genuinely new disclosures alert.
    if (await isSeedNeeded()) {
      const n = await seedSeen(matching);
      console.log(
        `[${stamp}] First run — seeded ${n} existing trade(s) as seen. ` +
          `Future polls will only alert on NEW disclosures.`
      );
      return;
    }

    const fresh = await selectNew(matching);
    if (fresh.length === 0) {
      console.log(
        `[${stamp}] Checked ${all.length} trades, ${matching.length} match your filters, nothing new.`
      );
      return;
    }

    const results = await notify(fresh);
    await recordAlerts(fresh);

    const sent = results
      .filter((r) => r && r.id)
      .map((r) => r.channel)
      .join(', ');
    console.log(
      `[${stamp}] Alerted on ${fresh.length} new trade(s)` +
        (sent ? ` via ${sent}.` : ' (console only).')
    );
  } catch (err) {
    console.error(`[${stamp}] Poll failed: ${err.message}`);
  }
}

async function main() {
  console.log('📡 Congress Trade Notifier');
  console.log('──────────────────────────');
  console.log(describeConfig());
  console.log('──────────────────────────\n');

  await pollOnce();

  if (RUN_ONCE) return;

  const ms = Math.max(1, config.pollIntervalMinutes) * 60 * 1000;
  console.log(`\n⏳ Polling every ${config.pollIntervalMinutes} min. Press Ctrl+C to stop.`);
  setInterval(pollOnce, ms);
}

main();
