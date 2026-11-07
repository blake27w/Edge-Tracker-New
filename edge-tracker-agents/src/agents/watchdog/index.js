// ══════════════════════════════════════════════════════════════
// Self-Watchdog — reliability insurance. Reads the orchestrator's
// health snapshot and flags agents that are erroring or stale, data
// gaps (games loaded but no odds attached), and cost tripwires (odds
// credits on pace to exceed the tier, Claude spend over a threshold).
// Sends ONE deduped alert per issue per day. $0 — pure internal data.
//
// Also folds in the store's degradation channel (see reportDegraded), which is
// how agents that "succeed" while producing garbage get noticed at all: the
// orchestrator marks a run failed only when it throws, so until this existed a
// swallowed query error or an unmatchable work queue read as 0 errors / 0
// consecutive failures indefinitely.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger, notifyAll, getClaudeUsage } from '../../utils/index.js';
import { getHealth, getGames, setWatchdog, getDegraded } from '../../store/index.js';
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
    // NOT projectedMonthly. That is a straight-line extrapolation of per-day
    // spend with no knowledge of the per-sport ceilings, which bound the month
    // near budget x 0.85 by construction (capOf, agents/odds). It reads "on
    // pace to overrun" through most of a normal football month — 15146 on day
    // 17 projects ~27617/20000 — and it also fired all through September when
    // the overrun was real. Firing in both cases, it separates nothing.
    // Alert on what has actually happened instead.
    if (ob.budget && ob.pctUsed >= 90 && ob.monthPct <= 75) {
      issues.push({
        key: 'cost|odds', type: 'cost', agent: 'odds', label: 'Odds API',
        detail: `${ob.used}/${ob.budget} credits (${ob.pctUsed}%) with ${Math.round(100 - ob.monthPct)}% of the month left`,
      });
    }
    // The September failure in one line: credits below the reserve, so the
    // discretionary scanners cut out and ~30 agents report "no games on the
    // slate" while every one of them looks healthy. Nothing alerted on it.
    if (ob.budget && ob.discretionaryActive === false) {
      issues.push({
        key: 'cost|odds-reserve', type: 'cost', agent: 'odds', label: 'Odds API reserve',
        detail: `${ob.remaining} credits left, below the ${ob.reserve} reserve — props, tennis and derivatives are paused`,
      });
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

  // Schema check: probe the recently-added tables AND every hand-run column, so
  // a missing migration — schema.sql not re-run, or an `alter table` nobody
  // pasted — surfaces immediately instead of as a blank tab.
  //
  // Why every hand-run column and not just the recent ones: on 2026-11-07 the
  // steam reader was found blind for 229 consecutive runs because the two
  // `line_movements` `alter table` lines from #136 were never applied in
  // Supabase, and the odds agent's strip-and-retry (D73) kept the inserts
  // landing WITHOUT the columns, so nothing complained until a reader selected
  // one. Every probe in the pre-2026-11-07 list named a column that always
  // exists, so the one channel built to catch unapplied DDL (D69/D70) was
  // structurally unable to see a skipped `alter table`. D103.
  if (db.isConnected()) {
    // Two kinds of probe, and the third element says which:
    //   [t, c]           — `c` is a sentinel column standing in for the
    //                      TABLE's existence; the fix is to run schema.sql.
    //   [t, c, 'column'] — `c` is a column added by an `alter table … add
    //                      column if not exists` in schema.sql, i.e. hand-run
    //                      DDL that is skippable; the fix is that statement.
    // The split is by probe INTENT, not by error code: `isMissingRelation`
    // reads 42703 (undefined column) and 42P01 (undefined table) alike, which
    // is correct here — either way the named thing is not queryable and the
    // named DDL is what creates it, and this flag does not latch. D73 is where
    // that same conflation is NOT fine (a latching write-path flag), which is
    // why the odds agent carries its own `isMissingColumn` instead.
    //
    // Cost: each probe is `select <col> limit 1` with no `where`, so Postgres
    // seq-scans and stops at the first row — one row touched, even on
    // `line_snapshots` (7M rows). 43 of them every 5 minutes is noise.
    const probes = [
      // ── table-existence probes ──
      ['opp_results', 'id'], ['line_signals', 'id'], ['ev_opportunities', 'id'],
      ['arb_opportunities', 'id'], ['research_notes', 'id'], ['fair_line_log', 'game_id'],
      ['pred_market_edges', 'id'], ['umpire_runs', 'umpire'], ['pitcher_changes', 'id'],
      ['weather_changes', 'id'], ['nfl_qb_status', 'id'], ['book_move_log', 'id'],
      // ── hand-run `alter table … add column` probes, one per statement ──
      ['game_weather', 'wind_effect', 'column'],
      ['monitor_scores', 'player', 'column'], ['monitor_scores', 'stat_type', 'column'],
      ['monitor_scores', 'anomaly', 'column'], ['monitor_scores', 'observational', 'column'],
      ['monitor_scores', 'prop_signal_type', 'column'], ['monitor_scores', 'price', 'column'],
      ['monitor_scores', 'live', 'column'],
      ['subscribers', 'email', 'column'], ['subscribers', 'sms', 'column'],
      ['subscribers', 'email_opt', 'column'],
      ['clv_records', 'entry_at', 'column'], ['clv_records', 'close_at', 'column'],
      ['clv_records', 'suspect', 'column'], ['clv_records', 'clv_odds', 'column'],
      ['clv_records', 'close_source', 'column'],
      ['opp_results', 'detail', 'column'], ['opp_results', 'price', 'column'],
      ['nfl_line_moves', 'sport', 'column'], ['nfl_line_moves', 'open_ml', 'column'],
      ['nfl_line_moves', 'close_ml', 'column'], ['nfl_line_moves', 'ml_move', 'column'],
      ['ev_opportunities', 'commence_time', 'column'], ['ev_opportunities', 'note', 'column'],
      ['ev_opportunities', 'quote_age_min', 'column'],
      ['public_splits', 'freeze', 'column'], ['public_splits', 'pileon', 'column'],
      ['public_splits', 'net_move', 'column'],
      ['line_snapshots', 'last_update', 'column'],
      ['line_movements', 'gap_min', 'column'], ['line_movements', 'baseline_source', 'column'],
    ];
    // tools/smoke.mjs cross-checks this list against schema.sql, both ways: a
    // table declared there without a probe here fails the build, and so does
    // an `alter table … add column` without a `[table, column]` probe. Hand-run
    // DDL is how this repo ships a table nobody created and a column nobody
    // added (D69/D70/D103), and this is the probe for it.
    const missingTables = [];
    const missingColumns = [];
    for (const [t, c, kind] of probes) {
      try { await db.select(t, c, { limit: 1 }); }
      catch (e) {
        if (db.isMissingRelation(e) || /relation/i.test(e.message || '')) {
          (kind === 'column' ? missingColumns : missingTables).push(`${t}.${c}`);
        }
      }
    }
    if (missingTables.length) {
      issues.push({ key: 'schema', type: 'schema', agent: 'db', label: 'Database schema', detail: `out of date — run scripts/schema.sql in Supabase (missing: ${missingTables.join(', ')})` });
    }
    // Deliberately its own key and its own sentence: "the table is not there"
    // and "the table is there but one `alter table` was skipped" are different
    // repairs, and sharing the key would let whichever fired first hide the
    // other for the rest of the day.
    if (missingColumns.length) {
      issues.push({ key: 'schema|column', type: 'schema', agent: 'db', label: 'Database schema (column)', detail: `missing hand-run column${missingColumns.length > 1 ? 's' : ''}: ${missingColumns.join(', ')} — run the matching alter table in scripts/schema.sql` });
    }
  }

  // ── Self-reported data-integrity degradations ─────────────────
  // The gap this closes: an agent only looks unhealthy to the orchestrator if
  // it THROWS. Agents that succeed while producing nothing usable — a
  // swallowed count error, a work queue where nothing matches, a CLV run where
  // every record is junk — report themselves onto this channel instead, and
  // this is where they become visible and alertable.
  //
  // A `<agent>|blocked` key is the same channel carrying the adjacent fault:
  // not bad output but NO output, because absent configuration prevented the
  // run (the orchestrator posts these). It gets its own type/label so the
  // dashboard can separate "the data is wrong" from "the agent is off".
  for (const d of getDegraded()) {
    const agent = d.key.split('|')[0];
    const isBlocked = d.key.endsWith('|blocked');
    issues.push({
      // The `data|` prefix stays either way — it keys the per-day dedup set.
      key: `data|${d.key}`, type: isBlocked ? 'blocked' : 'data', agent,
      label: isBlocked ? `Agent blocked (${agent})` : `Data integrity (${d.key})`,
      detail: `${d.detail}${d.count > 1 ? ` — seen ${d.count}× since ${d.since}` : ''}`,
    });
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
