// ══════════════════════════════════════════════════════════════
// /data-health — per-table "rows written today" + totals, plus the query
// failures that producing those numbers ran into.
//
// Extracted from index.js so the counting and error-classification logic can
// be exercised directly; the HTTP layer only shapes the response.
// ══════════════════════════════════════════════════════════════
import db from '../db/index.js';
import { logger } from '../utils/index.js';
import { reportDegraded } from '../store/index.js';

// Data-health: per-table rows written today + total, and agent errors today.
// A "today: 0" on an in-season table is the at-a-glance "data isn't flowing" tell.
//
// Two things used to make this endpoint lie:
//
//  1. Every count sat inside `catch (_) { /* table optional */ }`, so a query
//     that TIMED OUT reported the same `null` as a table that doesn't exist —
//     and `errorsToday` only counts agent `scan_runs` rows, so an endpoint-level
//     failure showed up nowhere at all. Now each failure is classified
//     (missing vs failed), returned in `errors[]`, logged, and pushed onto the
//     degradation channel so the watchdog alerts on it.
//
//  2. 23 sequential `count: 'exact'` queries. None of the counted tables had an
//     index on its timestamp column alone, so even the "today" counts were full
//     sequential scans, and the totals scanned multi-million-row tables
//     (line_snapshots, injury_updates). That is the 36s response. Now: totals
//     use the planner estimate, every count runs concurrently, and the whole
//     payload is cached for DATA_HEALTH_TTL_MS. schema.sql adds the matching
//     per-table timestamp indexes so the exact "today" counts are range scans.
const DATA_HEALTH_TTL_MS = Number(process.env.DATA_HEALTH_TTL_MS) || 60_000;
const COUNT_TIMEOUT_MS = Number(process.env.DATA_HEALTH_COUNT_TIMEOUT_MS) || 8_000;
const DEGRADED_TTL_MS = Number(process.env.DATA_HEALTH_DEGRADED_TTL_MS) || 10_000;
let dataHealthCache = null;

// Totals on these are estimates: they are append-only and large enough that an
// exact COUNT(*) is a multi-second scan, and nobody reads the last digit of
// "73284". Small/low-volume tables stay exact.
const ESTIMATE_TOTAL = new Set([
  'line_snapshots', 'injury_updates', 'line_signals', 'book_edge_log',
  'sharp_signals', 'ev_opportunities', 'opp_results', 'game_weather',
  'line_movements', 'opening_lines', 'prop_snapshots', 'alert_log',
  'arb_opportunities', 'fair_line_log', 'schedule_spots', 'tennis_markets',
]);
// Small reference tables — a few hundred rows at most, upserted one row per
// team/game — are left exact and unindexed on purpose: a seq scan of 32 rows
// costs nothing, and 33 more indexes would be 33 more things to migrate.

// Bound each count so one slow table can't hold the whole endpoint open. A
// timeout is a real failure and is reported as one.
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

export async function buildDataHealth({ force = false } = {}) {
  if (!force && dataHealthCache && Date.now() - dataHealthCache.at < dataHealthCache.ttl) {
    return { ...dataHealthCache.payload, cached: true, cache_age_ms: Date.now() - dataHealthCache.at };
  }

  const started = Date.now();
  const day = new Date(); day.setUTCHours(0, 0, 0, 0);
  const since = day.toISOString();

  // With no Supabase client, db.count() returns null without throwing — so the
  // old shape answered 200 with every count null and no errors, which is the
  // same lie by a different route. Say why instead.
  if (!db.isConnected()) {
    return {
      tables: [], errorsToday: null, queryErrors: [], degraded: true,
      reason: 'Supabase not configured (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)',
      dbConnected: false, since, durationMs: Date.now() - started,
      generated: new Date().toISOString(), cached: false,
    };
  }
  // Every table an agent writes to. This list was 11 of 44, and the 33 missing
  // ones are why `public_splits` went unnoticed for 106 days: it was caught
  // only because it happened to be one of the eleven. A silent write failure
  // on nfl_schedule_spots or tennis_markets had no tell at all.
  //
  // [table, timestamp column or null]. A null means the table has no
  // timestamptz to window on (the closing-lines history tables are keyed by
  // season/week), so only a total is meaningful — that is reported as
  // `today: null` with a `note`, which is NOT an error.
  const specs = [
    // ── core pipeline ──
    ['line_snapshots', 'fetched_at'], ['line_movements', 'detected_at'], ['opening_lines', 'captured_at'],
    ['monitor_scores', 'scored_at'], ['clv_records', 'recorded_at'], ['opp_results', 'graded_at'],
    ['ev_opportunities', 'fetched_at'], ['arb_opportunities', 'fetched_at'], ['line_signals', 'fetched_at'],
    ['book_edge_log', 'detected_at'], ['book_move_log', 'detected_at'], ['sharp_signals', 'detected_at'], ['fair_line_log', 'fetched_at'],
    ['prop_snapshots', 'fetched_at'], ['public_fades', 'detected_at'], ['pred_market_edges', 'detected_at'],
    // ── intelligence feeds ──
    ['injury_updates', 'fetched_at'], ['game_weather', 'fetched_at'], ['weather_changes', 'detected_at'],
    ['public_splits', 'fetched_at'], ['schedule_spots', 'fetched_at'], ['power_ratings', 'updated_at'],
    // ── MLB ──
    ['mlb_context', 'fetched_at'], ['umpire_runs', 'updated_at'], ['pitcher_changes', 'detected_at'],
    // ── NFL / NCAAF ──
    ['nfl_power_ratings', 'updated_at'], ['nfl_win_totals', 'updated_at'], ['nfl_schedule_spots', 'updated_at'],
    ['nfl_prop_baselines', 'updated_at'], ['nfl_scoring', 'updated_at'], ['nfl_pace', 'updated_at'],
    ['nfl_inactives', 'detected_at'], ['nfl_line_moves', 'captured_at'], ['nfl_derivatives', 'fetched_at'],
    ['nfl_qb_status', 'detected_at'], ['nfl_closing_lines', null], ['ncaaf_closing_lines', null],
    // ── tennis / combat ──
    ['tennis_markets', 'fetched_at'], ['tennis_fatigue', 'fetched_at'], ['tennis_matchups', 'fetched_at'],
    ['combat_markets', 'fetched_at'], ['combat_news', 'detected_at'], ['combat_derivatives', 'detected_at'],
    // ── operational ──
    ['alert_log', 'sent_at'], ['api_usage', 'updated_at'],
  ];

  const errors = [];
  // A failed count must never look like an absent one. `null` + a matching
  // entry in errors[] (and an `error` field on the row) is the honest answer.
  const attempt = async (table, scope, fn) => {
    try { return await withTimeout(fn(), COUNT_TIMEOUT_MS, `${table}.${scope}`); }
    catch (e) {
      errors.push({ table, scope, kind: e.missing ? 'missing' : 'failed', code: e.code || null, message: e.message });
      return null;
    }
  };

  // All counts concurrently — they're independent reads. Serially, 23 full
  // scans took ~36s; this is one wave.
  const errorsTodayP = attempt('scan_runs', 'errorsToday',
    () => db.count('scan_runs', { match: { status: 'error' }, gte: { started_at: since } }));

  const results = await Promise.all(specs.map(async ([t, ts]) => {
    const mode = ESTIMATE_TOTAL.has(t) ? 'estimated' : 'exact';
    const [today, total] = await Promise.all([
      ts ? attempt(t, 'today', () => db.count(t, { gte: { [ts]: since } })) : Promise.resolve(null),
      attempt(t, 'total', () => db.count(t, { mode })),
    ]);
    const row = { table: t, today, total, total_mode: mode };
    // An absent timestamp column is a property of the table, not a failure.
    if (!ts) row.note = 'no timestamp column — total only';
    const errs = errors.filter((e) => e.table === t);
    if (errs.length) row.error = errs.map((e) => `${e.scope}: ${e.kind}`).join(', ');
    return row;
  }));

  const errorsToday = await errorsTodayP;

  const failed = errors.filter((e) => e.kind === 'failed');
  const missing = errors.filter((e) => e.kind === 'missing');

  // Loud, not silent: log it, and raise it where the watchdog will see it.
  for (const e of failed) logger.error('data-health', `${e.table}.${e.scope} count failed — ${e.message}`);
  if (failed.length) {
    reportDegraded('data-health|counts',
      `${failed.length} count quer${failed.length === 1 ? 'y' : 'ies'} failing: ${failed.map((e) => `${e.table}.${e.scope}`).join(', ')}`);
  }
  if (missing.length) {
    reportDegraded('data-health|missing',
      `${missing.length} table/column missing — run scripts/schema.sql: ${missing.map((e) => `${e.table}.${e.scope}`).join(', ')}`);
  }

  const durationMs = Date.now() - started;
  if (durationMs > 5_000) {
    logger.warn('data-health', `slow: ${durationMs}ms for ${specs.length} tables`);
    reportDegraded('data-health|slow', `/data-health took ${durationMs}ms (counts unindexed?)`);
  }

  const payload = {
    tables: results,
    errorsToday,
    // Endpoint-level query failures, which errorsToday (agent scan_runs) can
    // never show. Non-empty here is itself the alarm.
    queryErrors: errors,
    degraded: failed.length > 0 || missing.length > 0,
    dbConnected: db.isConnected(),
    since,
    durationMs,
    generated: new Date().toISOString(),
  };
  // Cache a degraded payload only briefly. A single statement timeout should
  // not pin the endpoint to 207 (and the watchdog to an alert) for a full TTL —
  // the next caller should get a fresh attempt.
  dataHealthCache = { at: Date.now(), payload, ttl: payload.degraded ? DEGRADED_TTL_MS : DATA_HEALTH_TTL_MS };
  return { ...payload, cached: false };
}

