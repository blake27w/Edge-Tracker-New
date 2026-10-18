// ══════════════════════════════════════════════════════════════
// /data-health — that a failed count is reported AS a failure, and that
// producing the payload doesn't take 36 seconds.
//
// The original shape put every count inside `catch (_) { /* table optional */ }`,
// so a query that TIMED OUT returned the same `null` as a table that doesn't
// exist, and `errorsToday` (which only counts agent scan_runs rows) could not
// show an endpoint-level failure at all.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

// Read at module load by data-health.js, so they must be set before the
// dynamic import in before(). A clean payload caches for a minute; a degraded
// one only briefly, so one blip can't pin the endpoint at 207.
process.env.DATA_HEALTH_TTL_MS = '60000';
process.env.DATA_HEALTH_DEGRADED_TTL_MS = '60';

// Every table /data-health counts. The list is deliberately exhaustive over
// what agents write: it was 11 of 44, and public_splits was caught only
// because it happened to be one of the eleven.
const TABLES = ['line_snapshots', 'line_movements', 'opening_lines', 'monitor_scores', 'clv_records',
  'opp_results', 'ev_opportunities', 'arb_opportunities', 'line_signals', 'book_edge_log', 'sharp_signals',
  'fair_line_log', 'prop_snapshots', 'public_fades', 'pred_market_edges', 'injury_updates', 'game_weather',
  'weather_changes', 'public_splits', 'schedule_spots', 'power_ratings', 'mlb_context', 'umpire_runs',
  'pitcher_changes', 'nfl_power_ratings', 'nfl_win_totals', 'nfl_schedule_spots', 'nfl_prop_baselines',
  'nfl_scoring', 'nfl_pace', 'nfl_inactives', 'nfl_line_moves', 'nfl_derivatives', 'nfl_qb_status',
  'nfl_closing_lines', 'ncaaf_closing_lines', 'tennis_markets', 'tennis_fatigue', 'tennis_matchups',
  'combat_markets', 'combat_news', 'combat_derivatives', 'alert_log', 'api_usage'];
const WITH_TS = TABLES.length - 2;        // the two closing-lines tables have no timestamptz

let db, degraded, lines, buildDataHealth;

before(async () => {
  db = fakeDb(Object.fromEntries([...TABLES, 'scan_runs'].map((t) => [t, []])));
  degraded = [];
  const fl = fakeLogger(); lines = fl.lines;
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger: fl.logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), { namedExports: { reportDegraded: (k, d) => degraded.push({ k, d }) } });
  ({ buildDataHealth } = await import('../src/health/data-health.js'));
});
after(() => mock.reset());

beforeEach(() => { db.fail = {}; db.calls.count.length = 0; degraded.length = 0; lines.error.length = 0; });

const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const missing = () => Object.assign(new Error('relation "public_splits" does not exist'), { code: '42P01', missing: true });

// ── A failed count must not look like an absent one ──────────────
test('a timing-out count is reported as a failure, not as a null', async () => {
  db.fail['count:line_snapshots.total'] = timeout();
  const r = await buildDataHealth({ force: true });

  const row = r.tables.find((t) => t.table === 'line_snapshots');
  assert.equal(row.total, null, 'the value is unknown…');
  assert.match(row.error, /total/, '…but the row says so');
  assert.equal(r.queryErrors.length, 1);
  assert.equal(r.queryErrors[0].kind, 'failed', 'a timeout is a failure');
  assert.equal(r.queryErrors[0].code, '57014');
  assert.equal(r.degraded, true, 'and the payload flags itself');
});

test('a failed count is logged at ERROR and raised for the watchdog', async () => {
  db.fail['count:line_snapshots.total'] = timeout();
  await buildDataHealth({ force: true });
  assert.equal(lines.error.length, 1, 'error level, not a warn nobody reads');
  assert.ok(degraded.some((d) => d.k === 'data-health|counts'));
});

test('a missing table is distinguished from a failed query', async () => {
  db.fail['count:public_splits'] = missing();
  const r = await buildDataHealth({ force: true });
  assert.ok(r.queryErrors.every((e) => e.kind === 'missing'));
  assert.ok(degraded.some((d) => d.k === 'data-health|missing' && /schema\.sql/.test(d.d)),
    'missing columns are a migration to run, not a perf bug');
});

test('one slow table cannot hold the endpoint open forever', async () => {
  db.fail['count:line_snapshots.total'] = 'hang';
  const t0 = Date.now();
  const r = await buildDataHealth({ force: true });
  assert.ok(Date.now() - t0 < 12_000, 'must give up rather than hang');
  assert.ok(r.queryErrors.some((e) => /timed out/.test(e.message)));
});

test('a healthy run reports no errors and raises nothing', async () => {
  const r = await buildDataHealth({ force: true });
  assert.deepEqual(r.queryErrors, []);
  assert.equal(r.degraded, false);
  assert.equal(degraded.length, 0, 'no crying wolf on a clean run');
  assert.equal(r.tables.length, TABLES.length, 'every written table must be counted');
});

test('no database is stated outright, not served as a wall of nulls', async () => {
  // db.count returns null WITHOUT throwing when there's no client, so the old
  // shape answered 200 with every count null and no errors — the same lie.
  const saved = db.isConnected;
  db.isConnected = () => false;
  try {
    const r = await buildDataHealth({ force: true });
    assert.equal(r.degraded, true);
    assert.match(r.reason, /Supabase not configured/);
  } finally { db.isConnected = saved; }
});

// ── Speed: the 36s ──────────────────────────────────────────────
test('counts run concurrently, not one after another', async () => {
  const r = await buildDataHealth({ force: true });
  // today+total per table, minus the two with no timestamp column, + scan_runs
  assert.equal(db.calls.count.length, TABLES.length + WITH_TS + 1);
  // All issued inside the same tick-ish window rather than serialised.
  const span = Math.max(...db.calls.count.map((c) => c.at)) - Math.min(...db.calls.count.map((c) => c.at));
  assert.ok(span < 500, `all 23 counts should be in flight together (span ${span}ms)`);
  assert.ok(r.durationMs < 2000);
});

test('big append-only totals use the planner estimate; today stays exact', async () => {
  await buildDataHealth({ force: true });
  const mode = (t, scope) => db.calls.count.find((c) => c.table === t && c.scope === scope)?.mode;
  // An exact COUNT(*) on these is a multi-second scan and nobody reads the
  // last digit of "73284".
  assert.equal(mode('line_snapshots', 'total'), 'estimated');
  assert.equal(mode('injury_updates', 'total'), 'estimated');
  // Small tables stay exact…
  assert.equal(mode('monitor_scores', 'total'), 'exact');
  assert.equal(mode('clv_records', 'total'), 'exact');
  // …and every "today" count stays exact, because that number is the signal.
  assert.ok(db.calls.count.filter((c) => c.scope === 'today').every((c) => c.mode === 'exact'));
});

test('the payload is cached, and force bypasses the cache', async () => {
  await buildDataHealth({ force: true });
  const n = db.calls.count.length;
  const cached = await buildDataHealth();
  assert.equal(db.calls.count.length, n, 'no new queries');
  assert.equal(cached.cached, true);
  const fresh = await buildDataHealth({ force: true });
  assert.ok(db.calls.count.length > n);
  assert.equal(fresh.cached, false);
});

test('a transient failure is not cached as long as a clean payload', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A degraded payload expires fast: the next caller gets a fresh attempt
  // rather than a minute of stale 207s (and a minute of watchdog alerts).
  db.fail['count:line_snapshots.total'] = timeout();
  const bad = await buildDataHealth({ force: true });
  assert.equal(bad.degraded, true);
  db.fail = {};
  await sleep(100);                                   // past the 60ms degraded TTL
  const retried = await buildDataHealth();
  assert.equal(retried.cached, false, 'a degraded payload must not be cached long');
  assert.equal(retried.degraded, false, 'and the retry sees the recovered DB');

  // A clean payload, by contrast, is still cached well past that window.
  await sleep(100);
  const clean = await buildDataHealth();
  assert.equal(clean.cached, true, 'a healthy payload holds for the full TTL');
});

test('every table an agent writes to is counted', async () => {
  // The blind spot that let public_splits sit broken for 106 days: the spec
  // list covered 11 of the 44 tables agents write to, so most of the system
  // had no "today: 0" tell at all. If a new agent starts writing a new table,
  // this is the test that should fail.
  const r = await buildDataHealth({ force: true });
  const counted = new Set(r.tables.map((t) => t.table));
  for (const t of TABLES) assert.ok(counted.has(t), `${t} is written by an agent but not counted`);
});

test('a table with no timestamp column reports total-only, not an error', async () => {
  const r = await buildDataHealth({ force: true });
  const nfl = r.tables.find((t) => t.table === 'nfl_closing_lines');
  assert.equal(nfl.today, null);
  assert.match(nfl.note, /no timestamp column/);
  assert.equal(r.degraded, false, 'an absent column is a property of the table, not a failure');
  assert.ok(!r.queryErrors.some((e) => e.table === 'nfl_closing_lines'));
});
