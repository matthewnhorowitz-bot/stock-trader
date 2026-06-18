// Verifies your notification setup by sending a single mock alert through every
// enabled channel. Run with: npm test
import { config, describeConfig } from './config.js';
import { sendTestAlert } from './notifier.js';

console.log('🧪 Sending a mock alert with your current config:\n');
console.log(describeConfig());
console.log();

if (!config.email.enabled && !config.sms.enabled) {
  console.log(
    '⚠️  No channels enabled — the mock alert will only print to the console.\n' +
      '   Set EMAIL_TO (and/or SMS_ENABLED=true) in your .env to test real delivery.\n'
  );
}

const results = await sendTestAlert();
for (const r of results) {
  if (r.skipped) console.log(`   • ${r.channel}: skipped (disabled)`);
  else if (r.error) console.log(`   ✗ ${r.channel || 'channel'} failed: ${r.error}`);
  else console.log(`   ✓ ${r.channel} sent (id: ${r.id})`);
}
console.log('\nDone.');
