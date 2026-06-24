import { config, describeConfig } from './config.js';
import { fetchAllTrades } from './fetcher.js';
import { applyFilters } from './filter.js';
import { notify } from './notifier.js';
import { enrich } from './enrich.js';
import {
  selectNew,
  recordAlerts,
  seedSeen,
  isSeedNeeded,
  isSourceSeedNeeded,
  markSourceSeeded,
} from './tradeLog.js';
import { maybeSendMonthlyReport } from './monthlyReport.js';

const RUN_ONCE = process.argv.includes('--once');

// One unit of work: poll for new trades, then check if a monthly report is due.
async function tick() {
  await pollOnce();
  try {
    await maybeSendMonthlyReport();
  } catch (err) {
    console.error(`[monthly] report check failed: ${err.message}`);
  }
}

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

    // One-time re-seed when the data source changes (the new source can produce
    // slightly different trade ids; seed current trades so we don't alert on them).
    if (await isSourceSeedNeeded(config.dataProvider)) {
      const n = await seedSeen(matching);
      await markSourceSeeded(config.dataProvider);
      console.log(
        `[${stamp}] Data source = "${config.dataProvider}" (new) — seeded ${n} current trade(s); no alerts this run.`
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

    await enrich(fresh); // add sector + overlap (best-effort)
    const results = await notify(fresh);

    const sent = results
      .filter((r) => r && (r.id || r.count))
      .map((r) => r.channel)
      .join(', ');
    const channelsOn = config.email.enabled || config.sms.enabled || config.smsEmail.enabled;

    // If channels are configured but every one failed, do NOT mark these seen —
    // leave them so the next run retries. Otherwise the alert is lost forever.
    if (channelsOn && !sent) {
      const errs = results.filter((r) => r && r.error).map((r) => r.error).join('; ');
      console.error(
        `[${stamp}] Delivery FAILED for ${fresh.length} trade(s) — NOT marking seen; will retry next run. (${errs})`
      );
      return;
    }

    await recordAlerts(fresh);
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

  await tick();

  if (RUN_ONCE) return;

  const ms = Math.max(1, config.pollIntervalMinutes) * 60 * 1000;
  console.log(`\n⏳ Polling every ${config.pollIntervalMinutes} min. Press Ctrl+C to stop.`);
  setInterval(tick, ms);
}

main();
