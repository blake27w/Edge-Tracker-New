// ══════════════════════════════════════════════════════════════
// Shared utilities: logger (+ in-memory feed buffer), Claude API
// wrapper with startup model detection and web search, SMS sender.
// ══════════════════════════════════════════════════════════════
import Anthropic from '@anthropic-ai/sdk';
import config from '../config/index.js';

// ── Live feed ring buffer (last 100 entries, newest first) ──────
const FEED_MAX = 100;
const feed = [];

export const logger = {
  _push(level, agent, message) {
    const entry = { ts: new Date().toISOString(), level, agent, message };
    feed.unshift(entry);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    const tag = `[${entry.ts}] ${level.toUpperCase()} ${agent ? '(' + agent + ')' : ''}`;
    if (level === 'error') console.error(tag, message);
    else if (level === 'warn') console.warn(tag, message);
    else console.log(tag, message);
    return entry;
  },
  info(agent, message) { return this._push('info', agent, message); },
  warn(agent, message) { return this._push('warn', agent, message); },
  error(agent, message) { return this._push('error', agent, message); },
};

export function getFeed() { return feed.slice(0, FEED_MAX); }

// ── Daily metrics (for the dashboard system-health bar) ─────────
const metrics = { day: new Date().toISOString().slice(0, 10), anthropicCalls: 0, smsSent: 0, emailsSent: 0 };
function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== metrics.day) { metrics.day = today; metrics.anthropicCalls = 0; metrics.smsSent = 0; metrics.emailsSent = 0; }
}
export function getMetrics() { rollDay(); return { ...metrics }; }

// ── Anthropic client ────────────────────────────────────────────
let anthropic = null;
if (config.anthropic.apiKey) {
  anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
}

export const hasClaude = () => !!anthropic && !!config.anthropic.model;

// Modern models accept adaptive thinking + the web_search server tool.
// The legacy fallback chain (claude-3-*) does not — detect and degrade.
function isModern(model) {
  return /opus-4|sonnet-4-6|haiku-4-5|fable-5|mythos-5/.test(model || '');
}

// Probe the configured model chain; use the first the API key can call.
export async function detectModel() {
  if (!anthropic) {
    logger.warn('startup', 'No ANTHROPIC_API_KEY — Claude-backed agents will be skipped.');
    return null;
  }
  for (const model of config.anthropic.models) {
    try {
      await anthropic.messages.create({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      });
      config.anthropic.model = model;
      logger.info('startup', `Anthropic model detected: ${model}${isModern(model) ? ' (web search enabled)' : ' (legacy — no web search)'}`);
      return model;
    } catch (e) {
      logger.warn('startup', `Model ${model} unavailable: ${e.status || ''} ${e.message}`);
    }
  }
  logger.error('startup', 'No usable Anthropic model found in the configured chain.');
  return null;
}

function extractText(msg) {
  return (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Parse a JSON object/array out of a model response (tolerates code fences/prose).
export function parseJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const m = t.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* ignore */ } }
  return null;
}

// Core Claude call. opts: { system, maxTokens, web (use web search) }
export async function claude(prompt, opts = {}) {
  if (!hasClaude()) throw new Error('Claude not available');
  const model = config.anthropic.model;
  const useWeb = opts.web && isModern(model);
  const req = {
    model,
    max_tokens: opts.maxTokens || 2048,
    messages: [{ role: 'user', content: prompt }],
  };
  if (opts.system) req.system = opts.system;
  // allowed_callers:['direct'] disables the programmatic-tool-calling (dynamic
  // filtering) path, which Haiku doesn't support — lets web search run on every model.
  if (useWeb) req.tools = [{ type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] }];

  rollDay();
  metrics.anthropicCalls++;
  let msg = await anthropic.messages.create(req);
  // Server tools may pause after the 10-iteration cap — resume a few times.
  let guard = 0;
  while (msg.stop_reason === 'pause_turn' && guard++ < 4) {
    req.messages = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: msg.content },
    ];
    msg = await anthropic.messages.create(req);
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude refused the request');
  return extractText(msg);
}

// Convenience: ask Claude (with web search when available) and parse JSON.
export async function claudeJson(prompt, opts = {}) {
  const text = await claude(prompt, { web: true, maxTokens: 3000, ...opts });
  return parseJson(text);
}

// ── SMS via Twilio (optional) ───────────────────────────────────
let twilioClient = null;
async function getTwilio() {
  if (!config.twilio.enabled) return null;
  if (twilioClient) return twilioClient;
  const { default: twilio } = await import('twilio');
  twilioClient = twilio(config.twilio.sid, config.twilio.token);
  return twilioClient;
}

// Send an SMS to all `numbers` (defaults to configured fallback list).
// Returns count actually sent. No-ops cleanly when Twilio isn't configured.
export async function sendSms(body, numbers) {
  const to = (numbers && numbers.length ? numbers : config.twilio.fallbackNumbers).filter(Boolean);
  if (!to.length) { logger.warn('sms', 'No recipients for SMS'); return 0; }
  if (config.dryRun) { logger.info('sms', `[dry-run] would SMS ${to.length}: ${body.slice(0, 60)}…`); return 0; }
  const tw = await getTwilio();
  if (!tw) { logger.warn('sms', 'Twilio not configured — SMS skipped'); return 0; }
  let sent = 0;
  for (const num of to) {
    try {
      await tw.messages.create({ body, from: config.twilio.from, to: num });
      rollDay();
      metrics.smsSent++;
      sent++;
    } catch (e) {
      logger.error('sms', `Failed to ${num}: ${e.message}`);
    }
  }
  return sent;
}

// ── Email via SMTP (optional; free with Gmail app password or any SMTP) ──
let mailer = null;
async function getMailer() {
  if (!config.email.enabled) return null;
  if (mailer) return mailer;
  const { default: nodemailer } = await import('nodemailer');
  mailer = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port === 465,
    auth: { user: config.email.user, pass: config.email.pass },
  });
  return mailer;
}

// Send an email alert to all configured recipients. No-ops cleanly when SMTP
// isn't configured. Returns the recipient count.
export async function sendEmail(subject, body, to) {
  const recips = (to && to.length ? to : config.email.to).filter(Boolean);
  if (!recips.length) return 0;
  if (config.dryRun) { logger.info('email', `[dry-run] would email ${recips.length}: ${subject}`); return 0; }
  const tx = await getMailer();
  if (!tx) { return 0; }
  try {
    await tx.sendMail({ from: config.email.from, to: recips.join(','), subject, text: body });
    rollDay();
    metrics.emailsSent += recips.length;
    return recips.length;
  } catch (e) {
    logger.error('email', e.message);
    return 0;
  }
}

// Unified alert: fire SMS and/or Email (whichever is configured). Returns counts.
export async function notifyAll(subject, body) {
  let sms = 0, email = 0;
  try { sms = await sendSms(body); } catch (e) { logger.error('alert', `sms: ${e.message}`); }
  try { email = await sendEmail(subject, body); } catch (e) { logger.error('alert', `email: ${e.message}`); }
  if (!sms && !email) logger.warn('alert', 'No alert channel configured (SMS or email) — alert not delivered');
  return { sms, email, total: sms + email };
}

export default { logger, getFeed, getMetrics, detectModel, claude, claudeJson, parseJson, hasClaude, sendSms, sendEmail, notifyAll };
