import nodemailer from 'nodemailer';
import twilio from 'twilio';
import { config } from './config.js';

let mailer = null;
function getMailer() {
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.port === 465,
      auth: { user: config.email.user, pass: config.email.pass },
      // Fail fast instead of hanging ~2 min (which would burn Actions minutes).
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return mailer;
}

let smsClient = null;
function getSmsClient() {
  if (!smsClient) smsClient = twilio(config.sms.sid, config.sms.token);
  return smsClient;
}

// Send mail with one retry on transient failure (e.g. a flaky SMTP connection).
async function sendMailRetry(opts) {
  try {
    return await getMailer().sendMail(opts);
  } catch (err) {
    console.error(`[notifier] send failed (${err.code || err.message}); retrying once…`);
    await new Promise((r) => setTimeout(r, 4000));
    return getMailer().sendMail(opts);
  }
}

const icon = (type) => (type === 'buy' ? '🟢' : type === 'sell' ? '🔴' : '•');
const verb = (type) => (type === 'buy' ? 'bought' : type === 'sell' ? 'sold' : type);

// Short phrase naming the overlapping committee(s); '' when there's no overlap.
function overlapStr(t) {
  if (!t.overlaps || !t.overlaps.length) return '';
  const names = t.overlaps.map((o) => o.committee).slice(0, 2).join(', ');
  return names;
}

// Console line (emoji OK here).
function oneLine(t) {
  const sym = t.ticker || t.asset;
  const sector = t.sector ? ` (${t.sector})` : '';
  const flag = overlapStr(t) ? ' ⚠️OVERLAP' : '';
  return `${icon(t.type)} ${t.politician} ${verb(t.type)} ${sym}${sector} — traded ${t.transactionDate}${flag} (${t.amount.raw || 'n/a'})`;
}

// Multi-line ASCII block for the carrier (MMS) gateway — no emoji. Shows the
// actual trade date vs. disclosure date and sector. Committees are NOT listed;
// only a conflict line appears, and only when there's an overlap.
function smsBlock(t) {
  const sym = t.ticker || t.asset;
  const action = t.type === 'buy' ? 'BUY' : t.type === 'sell' ? 'SELL' : String(t.type).toUpperCase();
  const sector = t.sector ? ` (${t.sector})` : '';
  const lines = [
    `${t.politician} ${action} ${sym}${sector}`,
    ` traded ${t.transactionDate}${t.disclosureDate ? `, disclosed ${t.disclosureDate}` : ''}, ${t.amount.raw || 'n/a'}`,
  ];
  const overlap = overlapStr(t);
  if (overlap) lines.push(` ** POSSIBLE CONFLICT: sits on ${overlap} committee`);
  return lines.join('\n');
}

function smsBody(trades) {
  const head = `📈 ${trades.length} new congressional trade${trades.length > 1 ? 's' : ''}:`;
  const lines = trades.slice(0, 8).map(oneLine);
  if (trades.length > 8) lines.push(`…and ${trades.length - 8} more (see email)`);
  return [head, ...lines].join('\n');
}

function emailHtml(trades) {
  const rows = trades
    .map(
      (t) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;font-weight:600;">${
          t.type === 'buy' ? '🟢 BUY' : t.type === 'sell' ? '🔴 SELL' : t.type
        }</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${t.ticker || '—'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${t.politician}<br><span style="color:#888;font-size:12px;">${t.chamber}</span></td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${t.amount.raw || 'n/a'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;">${t.transactionDate}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;color:#888;">${t.disclosureDate}</td>
      </tr>`
    )
    .join('');

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:760px;">
    <h2 style="margin:0 0 4px;">📈 ${trades.length} new congressional trade${trades.length > 1 ? 's' : ''}</h2>
    <p style="color:#888;margin:0 0 16px;">From official STOCK Act disclosures · Reported in dollar ranges, up to 45 days after the trade.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead>
        <tr style="text-align:left;background:#f6f6f6;">
          <th style="padding:8px;">Action</th>
          <th style="padding:8px;">Ticker</th>
          <th style="padding:8px;">Legislator</th>
          <th style="padding:8px;">Amount</th>
          <th style="padding:8px;">Traded</th>
          <th style="padding:8px;">Disclosed</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#aaa;font-size:12px;margin-top:16px;">Not financial advice. Verify against the primary disclosure before acting.</p>
  </div>`;
}

async function sendEmail(trades) {
  if (!config.email.enabled) return { channel: 'email', skipped: true };
  const info = await sendMailRetry({
    from: config.email.from,
    to: config.email.to,
    subject: `📈 ${trades.length} new congressional trade${trades.length > 1 ? 's' : ''}`,
    text: trades.map(oneLine).join('\n'),
    html: emailHtml(trades),
  });
  return { channel: 'email', id: info.messageId };
}

async function sendSms(trades) {
  if (!config.sms.enabled) return { channel: 'sms', skipped: true };
  const msg = await getSmsClient().messages.create({
    body: smsBody(trades),
    from: config.sms.from,
    to: config.sms.to,
  });
  return { channel: 'sms', id: msg.sid };
}

// Free "text": email the short SMS body to the carrier's email-to-SMS gateway
// (e.g. 8564440212@vtext.com), which delivers it to the phone as a real text.
// Reuses the SMTP transport, so it needs SMTP_USER/SMTP_PASS configured.
async function sendSmsViaEmail(trades) {
  if (!config.smsEmail.enabled) return { channel: 'text', skipped: true };
  // ONE message per run — carrier gateways drop rapid back-to-back messages and
  // split multi-segment SMS. Sending a single message (ideally to an MMS gateway
  // like vzwpix.com, which accepts long text) is the most reliable. ASCII only;
  // emoji would force short Unicode SMS segments.
  const CAP = 15;
  const blocks = trades.slice(0, CAP).map(smsBlock);
  if (trades.length > CAP) blocks.push(`+${trades.length - CAP} more (see GitHub log)`);
  const info = await sendMailRetry({
    from: config.email.from,
    to: config.smsEmail.address,
    subject: `${trades.length} congressional trade${trades.length > 1 ? 's' : ''}`,
    text: blocks.join('\n\n'),
  });
  return { channel: 'text', id: info.messageId };
}

// Sends one batched alert across all enabled channels. Console output always
// happens so the tool is useful even with no credentials configured.
export async function notify(trades) {
  if (trades.length === 0) return [];

  console.log(`\n🔔 ALERT — ${trades.length} new matching trade(s):`);
  for (const t of trades) console.log('   ' + oneLine(t));

  const results = await Promise.allSettled([
    sendEmail(trades),
    sendSms(trades),
    sendSmsViaEmail(trades),
  ]);
  return results.map((r) =>
    r.status === 'fulfilled' ? r.value : { error: r.reason.message }
  );
}

// Sends a free-form digest (subject + plain text body) over the same channels.
// Used for the end-of-month report. Always prints to the console too.
export async function sendDigest(subject, text) {
  console.log(`\n${subject}\n${text}`);
  const jobs = [];
  if (config.smsEmail.enabled) {
    jobs.push(
      sendMailRetry({ from: config.email.from, to: config.smsEmail.address, subject, text }).then((i) => ({
        channel: 'text',
        id: i.messageId,
      }))
    );
  }
  if (config.email.enabled) {
    jobs.push(
      sendMailRetry({ from: config.email.from, to: config.email.to, subject, text }).then((i) => ({
        channel: 'email',
        id: i.messageId,
      }))
    );
  }
  const results = await Promise.allSettled(jobs);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason.message }));
}

// Used by `npm test` to verify credentials without waiting for a real trade.
export async function sendTestAlert() {
  const sample = [
    {
      chamber: 'house',
      politician: 'Test Representative',
      ticker: 'AAPL',
      asset: 'Apple Inc.',
      type: 'buy',
      amount: { low: 1001, high: 15000, raw: '$1,001 - $15,000' },
      transactionDate: new Date().toISOString().slice(0, 10),
      disclosureDate: new Date().toISOString().slice(0, 10),
      source: 'TEST',
    },
  ];
  return notify(sample);
}
