// ══════════════════════════════════════════════════════════════
// Self-Watchdog — reliability insurance. Reads the orchestrator's
// health snapshot and flags agents that are erroring or stale, data
// gaps (games loaded but no odds attached), and cost tripwires (odds
// credits on pace to exceed the tier, Claude spend over a threshold).
// Sends ONE deduped alert per issue per day. $0 — pure internal data.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger, notifyAll, getClaudeUsage } from '../../utils/index.js';
import { getHealth, getGames, setWatchdog } from '../../store/index.js';
import { getOddsBudget } from '../odds/index.js';

const STALE_FACTOR = Number(process.env.WATCHDOG_STALE_FACTOR) || 3; // late by Nx cadence
const STALE_FLOOR_MS = 15 * 60_000;                                  // never flag under 15 min
const FAIL_MIN = Number(process.env.WATCHDOG_FAIL_MIN) || 2;          // consecutive failures
const COST_ALERT = Number(process.env.COST_ALERT_USD) || 0;          // monthly $ threshold (0=off)
const SELF = ['watchdog', 'digest'];

const alerted = new Set();
let alertDay = '';

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== alertDay) { alertDay = today; alerted.clear(); }

  const health = getHealth() || [];
  const now = Date.now();
  const issues = [];

  for (const h of health) {
    if (SELF.includes(h.name)) continue;
    if (h.status === 'error' && (h.consecutiveFailures || 0) >= FAIL_MIN) {
      issues.push({ key: `err|${h.name}`, type: 'error', agent: h.name, label: h.label, detail: `erroring (${h.consecutiveFailures}×): ${h.error || 'unknown'}` });
      continue; // an erroring agent is also "stale" — report once
    }
    // Staleness only for interval agents that have run at least once.
    if (h.intervalMs && h.lastRunAt) {
      const age = now - new Date(h.lastRunAt).getTime();
      const limit = Math.max(h.intervalMs * STALE_FACTOR, STALE_FLOOR_MS);
      if (age > limit) issues.push({ key: `stale|${h.name}`, type: 'stale', agent: h.name, label: h.label, detail: `stale — last ran ${Math.round(age / 60000)} min ago (cadence ${Math.round(h.intervalMs / 60000)} min)` });
    }
  }

  // Data gap: games loaded but none carry book prices.
  const games = getGames();
  if (games.length && games.every((g) => !g.books || !Object.keys(g.books).length)) {
    issues.push({ key: 'gap|odds', type: 'gap', agent: 'odds', label: 'Odds', detail: `${games.length} games loaded but no book prices attached` });
  }

  // Cost tripwires.
  try {
    const ob = getOddsBudget();
    if (ob.budget && ob.projectedMonthly > ob.budget) {
      issues.push({ key: 'cost|odds', type: 'cost', agent: 'odds', label: 'Odds API', detail: `on pace for ${ob.projectedMonthly}/${ob.budget} credits this month` });
    }
  } catch (_) { /* ignore */ }
  if (COST_ALERT > 0) {
    try {
      const cu = await getClaudeUsage();
      if ((cu.projectedMonthly || 0) > COST_ALERT) {
        issues.push({ key: 'cost|claude', type: 'cost', agent: 'claude', label: 'Claude', detail: `projected $${cu.projectedMonthly}/mo exceeds $${COST_ALERT} cap` });
      }
    } catch (_) { /* ignore */ }
  }

  setWatchdog({ updated: new Date().toISOString(), issues });

  // Alert only NEW issues (deduped per day).
  const fresh = issues.filter((i) => !alerted.has(i.key));
  if (fresh.length) {
    fresh.forEach((i) => alerted.add(i.key));
    const body = `🛡️ Edge Tracker watchdog — ${fresh.length} issue${fresh.length > 1 ? 's' : ''}:\n` +
      fresh.map((i) => `• ${i.label}: ${i.detail}`).join('\n');
    try {
      const res = await notifyAll('Edge Tracker: system alert', body);
      await db.insert('alert_log', { type: 'system', channel: 'watchdog', recipients: res.total, body, status: 'sent' });
    } catch (e) { logger.warn('watchdog', `alert: ${e.message}`); }
  }

  return { summary: issues.length ? `${issues.length} issue(s), ${fresh.length} new` : 'all systems healthy', data: { issues: issues.length, new: fresh.length } };
}

export default { name: 'watchdog', run };
