import 'dotenv/config';
import { stateBackend } from './stateStore.js';

function bool(v, fallback = false) {
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function list(v) {
  if (!v) return [];
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const tradeTypes = (process.env.TRADE_TYPES || 'both').toLowerCase().trim();

export const config = {
  // When set (e.g. on Cloud Run), dedup state is stored in this GCS bucket
  // instead of the local ./data directory.
  stateBucket: (process.env.STATE_BUCKET || '').trim(),
  dataProvider: (process.env.DATA_PROVIDER || 'sample').toLowerCase().trim(),
  providers: {
    fmpKey: process.env.FMP_API_KEY,
    fmpLimit: Number(process.env.FMP_LIMIT || 25), // free tier caps this at 25

    finnhubKey: process.env.FINNHUB_API_KEY,
    finnhubSymbols: list(process.env.FINNHUB_SYMBOLS),
  },
  watch: list(process.env.WATCH_POLITICIANS).map((s) => s.toLowerCase()),
  tradeTypes, // 'buy' | 'sell' | 'both'
  minTradeValue: Number(process.env.MIN_TRADE_VALUE || 0),
  pollIntervalMinutes: Number(process.env.POLL_INTERVAL_MINUTES || 30),
  // End-of-month report includes trades whose disclosed range tops out at or
  // above this value ("major" investments). Default $100,000.
  monthlyReportMinValue: Number(process.env.MONTHLY_REPORT_MIN_VALUE || 100000),
  // Add sector + committee assignments + conflict-overlap flag to alerts.
  enrich: bool(process.env.ENRICH, true),

  email: {
    enabled: bool(process.env.EMAIL_ENABLED, true) && !!process.env.EMAIL_TO,
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: process.env.EMAIL_TO,
  },

  sms: {
    enabled: bool(process.env.SMS_ENABLED, false),
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM,
    to: process.env.SMS_TO,
  },

  // Free "SMS" via your carrier's email-to-SMS gateway. Reuses the SMTP
  // transport above, so it needs SMTP_USER/SMTP_PASS set (a Gmail App Password).
  smsEmail: {
    enabled: bool(process.env.SMS_VIA_EMAIL, false) && !!process.env.SMS_EMAIL_ADDRESS,
    address: process.env.SMS_EMAIL_ADDRESS, // e.g. 8564440212@vtext.com
  },
};

export function describeConfig() {
  const who = config.watch.length ? config.watch.join(', ') : 'ALL members';
  const channels = [
    config.email.enabled ? 'email' : null,
    config.sms.enabled ? 'SMS (Twilio)' : null,
    config.smsEmail.enabled ? 'text (carrier gateway)' : null,
  ]
    .filter(Boolean)
    .join(' + ') || 'NONE (alerts will only print to console)';
  return [
    `Data source: ${config.dataProvider}`,
    `State store: ${stateBackend}`,
    `Watching:    ${who}`,
    `Trade types: ${config.tradeTypes}`,
    `Min value:   $${config.minTradeValue.toLocaleString()}`,
    `Poll every:  ${config.pollIntervalMinutes} min`,
    `Notify via:  ${channels}`,
  ].join('\n');
}
