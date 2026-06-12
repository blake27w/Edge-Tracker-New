// ══════════════════════════════════════════════════════════════
// Send a test SMS through the configured Twilio account.
//   node scripts/test-alerts.js "+15557654321"
// With no number, uses ALERT_NUMBERS from .env.
// ══════════════════════════════════════════════════════════════
import config from '../src/config/index.js';
import { sendSms } from '../src/utils/index.js';

async function main() {
  if (!config.twilio.enabled) {
    console.error('✗ Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM). SMS is optional — the system runs without it.');
    process.exit(1);
  }
  const num = process.argv[2];
  const to = num ? [num] : config.twilio.fallbackNumbers;
  if (!to.length) { console.error('No recipient. Pass a number or set ALERT_NUMBERS.'); process.exit(1); }
  const body = `✅ Edge Tracker test alert — ${new Date().toLocaleString()}`;
  const sent = await sendSms(body, to);
  console.log(sent ? `✓ Sent to ${sent} number(s)` : '✗ Nothing sent (check logs)');
  process.exit(sent ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
