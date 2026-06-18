// ══════════════════════════════════════════════════════════════
// Orchestrator: schedules every agent, wraps each run with scan_runs
// bookkeeping, maintains a live status registry for /health, and
// implements error recovery (interval backoff + down-time SMS alert).
// ══════════════════════════════════════════════════════════════
import config from '../config/index.js';
import db from '../db/index.js';
import { logger, notifyAll } from '../utils/index.js';

// Agent modules (each default-exports { name, run }).
import odds from '../agents/odds/index.js';
import injury from '../agents/injury/index.js';
import weather from '../agents/weather/index.js';
import sharp from '../agents/sharp/index.js';
import power from '../agents/power/index.js';
import publicSplits from '../agents/public-splits/index.js';
import scheduleSpot from '../agents/schedule-spot/index.js';
import mlbContext from '../agents/mlb-context/index.js';
import signal from '../agents/signal-engine/index.js';
import propEngine from '../agents/prop-engine/index.js';
import clv from '../agents/clv-tracker/index.js';
import grading from '../agents/grading/index.js';
import tennisIngest from '../agents/tennis-ingest/index.js';
import tennisSignal from '../agents/tennis-signal/index.js';
import tennisFatigue from '../agents/tennis-fatigue/index.js';
import tennisSurface from '../agents/tennis-surface/index.js';
import evScanner from '../agents/ev-scanner/index.js';

// Run order matters within a tick: ingest → intel → score. The timers are
// independent, but listing odds/intel before signal keeps cold-start sane.
const AGENTS = [
  odds, injury, weather, sharp, power, publicSplits, scheduleSpot,
  mlbContext, signal, propEngine, clv, grading,
  tennisIngest, tennisFatigue, tennisSurface, tennisSignal,
  evScanner,
];

// name -> live status (the /health payload reads from here).
const registry = {};

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// Current weekday (0-6) and minutes-of-day in a timezone.
function nowParts(tz) {
  let wd = new Date().getUTCDay(), min = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
    let h = 0, m = 0;
    for (const p of parts) {
      if (p.type === 'weekday') wd = WD[p.value] ?? wd;
      else if (p.type === 'hour') h = parseInt(p.value, 10) % 24;
      else if (p.type === 'minute') m = parseInt(p.value, 10);
    }
    min = h * 60 + m;
  } catch (_) { min = new Date().getUTCHours() * 60 + new Date().getUTCMinutes(); }
  return { wd, min };
}

// ms until the next scheduled HH:MM (in tz), optionally restricted to days-of-week.
function nextClockDelay(times, tz, days) {
  const { wd, min: nowMin } = nowParts(tz);
  const mins = times
    .map((t) => { const [a, b] = String(t).split(':').map(Number); return a * 60 + (b || 0); })
    .filter((n) => Number.isFinite(n))
    .sort((x, y) => x - y);
  if (!mins.length) return 6 * 3600_000;
  let best = Infinity;
  for (let off = 0; off <= 7; off++) {
    const day = (wd + off) % 7;
    if (days && days.length && !days.includes(day)) continue;
    for (const t of mins) {
      const total = off * 1440 + (t - nowMin);
      if (total > 0 && total < best) best = total;
    }
  }
  if (!Number.isFinite(best)) best = 24 * 60;
  return best * 60_000;
}

function initRegistry() {
  for (const agent of AGENTS) {
    const meta = config.AGENTS[agent.name] || {};
    registry[agent.name] = {
      name: agent.name,
      label: meta.label || agent.name,
      emoji: meta.emoji || '🤖',
      status: 'idle',            // running | idle | error
      lastRunAt: null,
      lastDurationMs: null,
      lastResult: null,
      error: null,
      cron: meta.cron || null,
      baseEveryMs: meta.everyMs || 30 * 60_000,
      everyMs: meta.everyMs || 30 * 60_000,
      times: meta.times || null,        // clock-scheduled agents (e.g. power)
      days: meta.days || null,          // optional day-of-week restriction (0-6)
      tz: meta.tz || 'UTC',
      consecutiveFailures: 0,
      downSince: null,
      alertedDown: false,
      gamesMonitored: 0,
      runs: 0,
    };
  }
}

export function getHealth() {
  return Object.values(registry).map((r) => ({
    name: r.name, label: r.label, emoji: r.emoji, status: r.status,
    lastRunAt: r.lastRunAt, lastDurationMs: r.lastDurationMs,
    lastResult: r.lastResult, error: r.error,
    intervalMs: r.times ? null : r.everyMs,
    schedule: r.times ? `${r.times.join(', ')}${r.days ? ' · ' + r.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join('/') : ''} ${r.tz}` : null,
    consecutiveFailures: r.consecutiveFailures, runs: r.runs,
  }));
}

// Run a single agent once, with full bookkeeping + error recovery.
async function runAgent(agent) {
  const r = registry[agent.name];
  r.status = 'running';
  const started = Date.now();
  let scanRow = null;

  // Open a scan_runs row (best-effort; never block the agent on DB).
  try {
    const res = await db.insert('scan_runs', {
      agent: agent.name, status: 'running', started_at: new Date(started).toISOString(),
    });
    scanRow = res?.data?.[0] || null;
  } catch (e) { /* DB optional */ }

  try {
    const out = (await agent.run()) || {};
    const duration = Date.now() - started;
    const summary = out.summary || 'done';

    r.status = 'idle';
    r.lastRunAt = new Date().toISOString();
    r.lastDurationMs = duration;
    r.lastResult = summary;
    r.error = null;
    r.runs++;
    if (typeof out.gamesMonitored === 'number') r.gamesMonitored = out.gamesMonitored;

    // Recovery: clear failure state, restore base interval.
    if (r.consecutiveFailures > 0 || r.everyMs !== r.baseEveryMs) {
      logger.info(agent.name, `Recovered — interval restored to ${Math.round(r.baseEveryMs / 1000)}s`);
    }
    r.consecutiveFailures = 0;
    r.downSince = null;
    r.alertedDown = false;
    r.everyMs = r.baseEveryMs;

    logger.info(agent.name, summary);
    if (scanRow) {
      try {
        await db.update('scan_runs', {
          status: 'ok', finished_at: new Date().toISOString(), duration_ms: duration,
          result: summary, result_data: out.data || null, games_monitored: out.gamesMonitored || 0,
        }, { id: scanRow.id });
      } catch (e) { /* ignore */ }
    }
  } catch (err) {
    const duration = Date.now() - started;
    r.status = 'error';
    r.lastRunAt = new Date().toISOString();
    r.lastDurationMs = duration;
    r.error = err.message;
    r.consecutiveFailures++;
    if (!r.downSince) r.downSince = started;

    logger.error(agent.name, `Failed (${r.consecutiveFailures}x): ${err.message}`);
    if (scanRow) {
      try {
        await db.update('scan_runs', {
          status: 'error', finished_at: new Date().toISOString(), duration_ms: duration, error: err.message,
        }, { id: scanRow.id });
      } catch (e) { /* ignore */ }
    }

    // Backoff after N consecutive failures to avoid hammering APIs.
    if (r.consecutiveFailures >= config.rules.maxConsecutiveFailures) {
      const capped = Math.min(r.everyMs * config.rules.backoffMultiplier, 60 * 60_000);
      if (capped !== r.everyMs) {
        r.everyMs = capped;
        logger.warn(agent.name, `Backing off interval to ${Math.round(r.everyMs / 1000)}s after repeated failures`);
      }
    }

    // Down for 30+ minutes → SMS alert (once per outage).
    const downMs = Date.now() - r.downSince;
    if (downMs >= config.rules.downAlertMs && !r.alertedDown) {
      r.alertedDown = true;
      const mins = Math.round(downMs / 60_000);
      try {
        const body = `⚠️ Edge Tracker: agent "${r.label}" has been down ${mins} min. Last error: ${err.message}`;
        const res = await notifyAll('Edge Tracker: agent down', body);
        await db.insert('alert_log', {
          type: 'system', channel: 'alert', recipients: res.total,
          body: `Agent ${r.name} down ${mins}m: ${err.message}`, status: 'sent',
        });
      } catch (e) { /* best effort */ }
    }
  }

  // Self-reschedule: clock-scheduled agents go to their next clock time;
  // interval agents use their (possibly backed-off) interval.
  const delay = r.times ? nextClockDelay(r.times, r.tz, r.days) : r.everyMs;
  r.timer = setTimeout(() => runAgent(agent), delay);
}

// Kick off every agent on a small stagger so they don't all fire at once.
export async function start() {
  initRegistry();
  logger.info('orchestrator', `Starting ${AGENTS.length} agents`);
  // Run odds FIRST and wait for it to finish, so the slate is published to the
  // store before the intel agents (injury/weather/power/etc.) read it. Avoids the
  // cold-start race where an intel agent fires before any games are loaded.
  const odds = AGENTS.find((a) => a.name === 'odds');
  if (odds) await runAgent(odds); // runAgent never throws; it self-reschedules at the end
  const rest = AGENTS.filter((a) => a.name !== 'odds');
  rest.forEach((agent, i) => {
    const r = registry[agent.name];
    r.timer = setTimeout(() => runAgent(agent), i * 1500); // staggered cold start
  });
}

export function stop() {
  for (const r of Object.values(registry)) if (r.timer) clearTimeout(r.timer);
}

export default { start, stop, getHealth };
