// ══════════════════════════════════════════════════════════════
// The hydration circuit breaker — the other half of "a failed read is not a
// game that is done".
//
// Not burning the once-per-process cold allowance on a run that hydrated
// nothing is right for a transient timeout and catastrophic for a persistent
// one: `line_snapshots` is the table that statement-timeouts (D68), and
// `db.isConnected()` is false only when Supabase is UNCONFIGURED, so a
// query-level failure short-circuits nothing. Every attempted game fails ->
// games === 0 -> `hydratedOnce` stays false -> the next run re-spends the FULL
// cold cap (120 games x 2 markets = 240 timing-out selects in 40 chunked waves)
// before a single normalize() runs. Every run, indefinitely. At an 8s statement
// timeout that is ~5 minutes of added latency per odds run, and the
// orchestrator awaits `odds` before every other agent — so the whole chain
// stalls while the one table already in distress is hammered 5x harder than the
// steady-state cap allows.
//
// So after HYDRATE_FAIL_RUNS (3) consecutive all-failed runs the cold allowance
// is forfeited, hydration drops to a one-game probe, and it is logged. One
// hydrated game resets the streak.
//
// Caps here: cold 4, steady 2, probe 1 — three distinguishable numbers, so
// "which cap governed this run" is directly observable as `hydrateAttempted`.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const GAMES = ['g1', 'g2', 'g3', 'g4'];

const ev = (id, i) => ({
  id, home_team: 'Home', away_team: 'Away', commence_time: iso(now + (20 + i) * MIN),
  bookmakers: [{
    key: 'draftkings', last_update: iso(Date.now()),
    markets: [{
      key: 'spreads', last_update: iso(Date.now()),
      outcomes: [{ name: 'Home', point: -3, price: -110 }, { name: 'Away', point: 3, price: -110 }],
    }],
  }],
});

let mod;
let fdb;
let logs;

const tick = () => new Promise((r) => setTimeout(r, 5));
// Reads issued by the run that just finished — the latency this guard exists to
// bound, counted rather than asserted about in prose.
let seen = 0;
const readsThisRun = () => {
  const total = fdb.calls.select.filter((c) => c.table === 'line_snapshots').length;
  const n = total - seen;
  seen = total;
  return n;
};

before(async () => {
  process.env.ODDS_HYDRATE_COLD_MAX = '4';
  process.env.ODDS_HYDRATE_MAX_GAMES = '2';
  for (const k of ['ODDS_STRIKE_MIN', 'ODDS_NEAR_MIN', 'ODDS_MID_MIN', 'ODDS_IDLE_MIN']) {
    process.env[k] = '0.000001';
  }

  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: { allocation: { A: 1 }, monthlyBudget: 20000, tier: 'starter', key: 'test-key',
        footballSports: [], footballPriority: 'false', footballPriorityOn: () => false,
        base: 'https://api.the-odds-api.com/v4' },
      SPORTS: { A: { key: 'k_A' } },
      BOOKS: ['draftkings'], BOOK_LABELS: { draftkings: 'DK' },
      rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: false,
    },
  });

  fdb = fakeDb({});
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb,
    namedExports: { isMissingRelation: fdb.isMissingRelation },
  });

  const fl = fakeLogger();
  logs = fl.lines;
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: fl.logger, notifyAll: async () => ({ total: 0 }) },
  });

  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?')
      ? [{ key: 'k_A', active: true }]
      : GAMES.map(ev)),
  });

  mod = await import('../src/agents/odds/index.js');
});
after(() => mock.reset());

test('the cold allowance survives a transient failure — twice', async () => {
  // The documented D68 mode: a statement timeout, not a disconnect. isConnected()
  // is true throughout, which is exactly why nothing short-circuits on its own.
  fdb.fail['select:line_snapshots'] = Object.assign(
    new Error('canceling statement due to statement timeout'), { code: '57014' });

  for (const run of [1, 2]) {
    const r = await mod.default.run();
    assert.equal(r.data.hydrateAttempted, 4, `run ${run} must still get the cold cap: ${r.summary}`);
    assert.equal(r.data.rehydratedGames, 0);
    assert.equal(r.data.hydrateFailRuns, run, r.summary);
    assert.equal(readsThisRun(), 8, '4 games x 2 markets');
    assert.doesNotMatch(r.summary, /circuit-broken/, 'two bad runs is a blip, not an outage');
    await tick();
  }
});

test('the third all-failed run announces the breaker instead of failing silently', async () => {
  const r = await mod.default.run();
  assert.equal(r.data.hydrateFailRuns, 3, r.summary);
  assert.equal(r.data.hydrateAttempted, 4, 'this run still ran at the cold cap; the NEXT one backs off');
  assert.match(r.summary, /circuit-broken after 3 failed runs/,
    'the condition has to be visible in the line Blake reads, not inferred from latency');
  assert.ok(logs.warn.some((l) => /failed every read for 3 consecutive runs/.test(l)),
    `and logged once at warn: ${logs.warn.join(' | ')}`);
  assert.equal(readsThisRun(), 8);
  await tick();
});

test('after that the reads back off to a probe, every run, until the table answers', async () => {
  for (const run of [4, 5]) {
    const r = await mod.default.run();
    assert.equal(r.data.hydrateAttempted, 1,
      `run ${run} must probe, not re-spend the cold cap (or even the steady one): ${r.summary}`);
    assert.equal(readsThisRun(), 2, 'one game x two markets — 2 selects, not 8');
    assert.equal(r.data.rehydratedGames, 0);
    assert.equal(r.data.hydrateFailRuns, run, r.summary);
    await tick();
  }
  assert.equal(logs.warn.filter((l) => /consecutive runs/.test(l)).length, 1,
    'announced on the crossing, not re-announced every run — that is how a warn becomes noise');
});

test('one successful probe resets the streak and normal hydration resumes', async () => {
  delete fdb.fail['select:line_snapshots'];
  fdb.setRows('line_snapshots', [
    { game_id: 'g1', book: 'draftkings', market: 'spreads', side: 'Home', line: -3, price: -110, fetched_at: iso(now - 5 * MIN) },
  ]);

  const probe = await mod.default.run();
  assert.equal(probe.data.hydrateAttempted, 1, `still a probe on the recovery run: ${probe.summary}`);
  assert.equal(probe.data.rehydratedGames, 1, probe.summary);
  assert.equal(probe.data.hydrateFailRuns, 0, 'one hydrated game clears the streak');
  assert.doesNotMatch(probe.summary, /circuit-broken/);
  assert.equal(readsThisRun(), 2);
  await tick();

  // Steady cap, not the cold one: the successful run set hydratedOnce. The cold
  // allowance is deliberately NOT refunded after a sustained outage — a 240-query
  // burst into a table that just came back is the behaviour being prevented.
  const after2 = await mod.default.run();
  assert.equal(after2.data.hydrateAttempted, 2, `steady cap (2), not cold (4): ${after2.summary}`);
  assert.equal(after2.data.rehydratedGames, 2);
  assert.equal(readsThisRun(), 4);
});

test('the hydration read does not ask for a hand-migrated column', async () => {
  // `last_update` on line_snapshots exists only via a hand-run `alter table`
  // (scripts/schema.sql), and baselineFromSnapshots never reads it — the
  // baseline age is `fetched_at`. On any environment where that DDL was never
  // applied, PostgREST rejects the WHOLE select on the unknown column: 100% of
  // hydration reads fail, which with the breaker above is a permanent probe
  // loop. Not selecting it removes the dependency entirely.
  const cols = fdb.calls.select.filter((c) => c.table === 'line_snapshots').map((c) => c.cols);
  assert.ok(cols.length > 0);
  for (const c of cols) {
    assert.ok(/fetched_at/.test(c), `the baseline age must be selected: ${c}`);
    assert.doesNotMatch(c, /last_update/, `unused and hand-migrated — do not depend on it: ${c}`);
  }
});
