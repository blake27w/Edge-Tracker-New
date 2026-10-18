// ══════════════════════════════════════════════════════════════
// Watchdog — the one place a silent fault is supposed to become visible.
//
// This file had no coverage, which is awkward given it is the terminus of
// every "make it loud" path in this PR. If the degraded channel stops reaching
// the issues array, all five fixes go quiet again and nothing else notices.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let watchdog, store, published, alerts, budget;

before(async () => {
  published = []; alerts = [];
  // A budget that is healthy under BOTH the current tripwire and #131's, so
  // these tests pass before and after that merges.
  //
  // Worth knowing why this fixture is not the real Oct-17 reading: at the
  // actual 15164/20000 on day 17, `projectedMonthly` is 27651 and the CURRENT
  // tripwire fires — so a "healthy system raises nothing" test written with
  // live-healthy numbers fails on this branch. That is the false-alarm #131
  // fixes, reproduced by accident while writing this file.
  budget = { budget: 20000, used: 9000, remaining: 11000, pctUsed: 45, monthPct: 54.8,
    paceRatio: 0.82, projectedMonthly: 16408, reserve: 1000, discretionaryActive: true };

  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: { rules: { unitDollars: 100 } },
  });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      isConnected: () => false,                       // skip the schema probes
      insert: async () => ({ count: 1 }),
      select: async () => [],
      isMissingRelation: () => false,
    },
    namedExports: { isMissingRelation: () => false },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      notifyAll: async (subject, body) => { alerts.push({ subject, body }); return { total: 0 }; },
      getClaudeUsage: async () => ({ projectedMonthly: 0 }),
    },
  });
  mock.module(import.meta.resolve('../src/agents/odds/index.js'), {
    namedExports: { getOddsBudget: () => budget },
  });

  store = await import('../src/store/index.js');
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: {
      getHealth: () => health,
      getGames: () => games,
      setWatchdog: (w) => published.push(w),
      getDegraded: () => store.getDegraded(),
      reportDegraded: store.reportDegraded,
      clearDegraded: store.clearDegraded,
    },
  });
  watchdog = (await import('../src/agents/watchdog/index.js')).default;
});
after(() => mock.reset());

let health = [], games = [];
const idle = (name, over = {}) => ({ name, label: name, status: 'idle', error: null,
  consecutiveFailures: 0, lastRunAt: new Date().toISOString(), intervalMs: 600_000, ...over });

beforeEach(() => {
  published.length = 0; alerts.length = 0;
  health = [idle('clv'), idle('grading')];
  games = [];
  for (const d of store.getDegraded()) store.clearDegraded(d.key);
});

const issues = () => published[published.length - 1].issues;

// ── The premise of the whole PR ─────────────────────────────────
test('an agent reporting SUCCESS with 0 failures still raises an issue if it degraded', async () => {
  // This is the case the orchestrator cannot see: status idle, error null,
  // consecutiveFailures 0 — and the agent produced nothing usable.
  store.reportDegraded('clv|none-beat', '0 of 14 measurable CLV records beat the close');
  await watchdog.run();

  const i = issues().find((x) => x.key === 'data|clv|none-beat');
  assert.ok(i, 'a degradation must become an issue even though the agent looks healthy');
  assert.equal(i.type, 'data');
  assert.equal(i.agent, 'clv');
  assert.match(i.detail, /0 of 14/);
});

test('a repeated degradation surfaces how long it has been happening', async () => {
  store.reportDegraded('write|public_splits', 'insert public_splits failing — schema out of date');
  store.reportDegraded('write|public_splits', 'insert public_splits failing — schema out of date');
  await watchdog.run();
  const i = issues().find((x) => x.key === 'data|write|public_splits');
  assert.match(i.detail, /seen 2×/, '106 days of this should not look like a first occurrence');
});

test('every degradation key becomes its own issue', async () => {
  store.reportDegraded('clv|schema', 'a');
  store.reportDegraded('grading|zero', 'b');
  store.reportDegraded('data-health|counts', 'c');
  await watchdog.run();
  const keys = issues().filter((i) => i.type === 'data').map((i) => i.key);
  assert.deepEqual(keys.sort(), ['data|clv|schema', 'data|data-health|counts', 'data|grading|zero']);
});

test('a clean system raises nothing', async () => {
  await watchdog.run();
  assert.deepEqual(issues(), [], 'no crying wolf — a healthy run must be silent');
  assert.equal(alerts.length, 0);
});

// ── Agent-level detection ───────────────────────────────────────
test('an erroring agent is reported once, not also as stale', async () => {
  health = [idle('clv', { status: 'error', error: 'boom', consecutiveFailures: 3,
    lastRunAt: new Date(Date.now() - 86400_000).toISOString() })];
  await watchdog.run();
  const mine = issues().filter((i) => i.agent === 'clv');
  assert.equal(mine.length, 1, 'an erroring agent is also stale; report it once');
  assert.equal(mine[0].type, 'error');
});

test('a single failure is below the floor; repeated failures are not', async () => {
  health = [idle('clv', { status: 'error', error: 'boom', consecutiveFailures: 1 })];
  await watchdog.run();
  assert.equal(issues().some((i) => i.type === 'error'), false, 'one blip is not an incident');
});

test('an agent that stopped running is flagged stale', async () => {
  health = [idle('clv', { lastRunAt: new Date(Date.now() - 10 * 3600_000).toISOString() })];
  await watchdog.run();
  assert.equal(issues().find((i) => i.agent === 'clv').type, 'stale');
});

test('games on the board with no book prices is a data gap', async () => {
  games = [{ game_id: 'a', books: {} }, { game_id: 'b' }];
  await watchdog.run();
  assert.ok(issues().some((i) => i.key === 'gap|odds'));
});

// ── Alerting ────────────────────────────────────────────────────
test('each issue alerts once per day, not on every run', async () => {
  // Fresh keys: the per-day `alerted` set is module state that persists across
  // tests in this file, which is itself the behaviour under test.
  store.reportDegraded('dedup-a|first', 'x');
  await watchdog.run();
  assert.equal(alerts.length, 1, 'first sighting alerts');
  assert.match(alerts[0].body, /dedup-a/);

  await watchdog.run();
  assert.equal(alerts.length, 1, 'the same issue must not re-alert every 2 minutes');

  store.reportDegraded('dedup-b|second', 'y');
  await watchdog.run();
  assert.equal(alerts.length, 2, 'but a NEW issue does alert');
  assert.match(alerts[1].body, /dedup-b/);
});

test('the run summary counts issues and new issues', async () => {
  store.reportDegraded('summary-only|x', 'x');
  const r = await watchdog.run();
  assert.match(r.summary, /1 issue/);
  assert.equal(r.data.issues, 1);
});

// ── Cost tripwire — coverage lands with #131 ─────────────────────
// The tripwire on this branch is still `projectedMonthly > budget`, which fires
// on essentially every football month: paceRatio IS projectedMonthly/budget
// (pctUsed/monthPct reduces to used*daysInMonth / cap*dayOfMonth), so any
// pace-based rule is the same tripwire wearing a different name. #131
// (c572d0e) replaces it with two checks on ACTUALS — `pctUsed >= 90 &&
// monthPct <= 75`, and `discretionaryActive === false`. Deliberately not
// tested here: asserting the current behaviour would pin a known false-alarm
// generator as correct, and asserting the new one would fail until that merges.
//
// The cases to add once it lands (the `budget` fixture above is already the
// healthy Oct-17 reading, so most are one-liners):
//   - Sept d15 crisis (used 19915, pctUsed 99.6, monthPct 48)    -> fires
//   - the healthy readings: Oct d14, Oct d17, Nov d5, Oct d28     -> silent
//   - remaining < reserve (discretionaryActive false)             -> fires
//     `cost|odds-reserve`, separately keyed so day-dedup treats it apart
//   - MUTATION: restore `projectedMonthly > budget` and the four healthy
//     cases must fail. That is the check that matters — it is what proves the
//     new rule separates anything at all.
