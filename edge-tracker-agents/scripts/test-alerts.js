// ══════════════════════════════════════════════════════════════
// Send a test alert through whatever channels are configured
// (SMS via Twilio and/or email via SMTP).
//   node scripts/test-alerts.js
//   node scripts/test-alerts.js "+15557654321"   # override SMS recipient
// ══════════════════════════════════════════════════════════════
import config from '../src/config/index.js';
import { notifyAll, sendSms } from '../src/utils/index.js';

async function main() {
  if (!config.twilio.enabled && !config.email.enabled) {
    console.error('✗ No alert channel configured. Set Twilio (TWILIO_*) and/or SMTP (SMTP_* + ALERT_EMAILS).');
    process.exit(1);
  }
  const body = `✅ Edge Tracker test alert — ${new Date().toLocaleString()}`;
  const num = process.argv[2];
  let res;
  if (num) {
    const sms = await sendSms(body, [num]);
    res = { sms, email: 0, total: sms };
  } else {
    res = await notifyAll('Edge Tracker test alert', body);
  }
  console.log(`SMS sent: ${res.sms} · Emails sent: ${res.email}`);
  console.log(res.total ? '✓ Delivered' : '✗ Nothing sent (check config/logs)');
  process.exit(res.total ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
