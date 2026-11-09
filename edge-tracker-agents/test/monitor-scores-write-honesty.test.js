// ══════════════════════════════════════════════════════════════
// A rejected monitor_scores batch must be REPORTED, not warned about — and a
// run that landed nothing at all must say it could not do its job.
//
// The companion of monitor-scores-price-type.test.js, and the other two thirds
// of what pred-market-write-honesty.test.js pins. `signal-engine/index.js:302`
// and `public-fade/index.js:118` carried the identical shape that hid nine lost
// `pred_market_edges` runs: `catch { logger.warn }` under a summary reporting
// the count BUILT. PostgREST applies a batch insert as one statement, so the
// loss is always the whole run; a warn in a 100-entry ring buffer is how the
// first nine disappeared.
//
// Two properties, per agent:
//
//  1. HONESTY — the summary and `data` distinguish built from landed, and the
//     loss logs at error with the database message. "Nothing happened" and
//     "I could not write it" must never look the same.
//  2. BLOCKED — a run whose entire batch was rejected "succeeded while unable
//     to do its job", which is D80's definition, so it returns a `blocked`
//     reason and the orchestrator does the reporting. The reason is a CONSTANT
//     literal: the orchestrator reads a changed reason as a new fault and
//     restarts the streak, so a count in the reason would read `blockedRuns: 1`
//     forever and churn reportDegraded every run (the trap `sharp` documents).
//     A later run that writes returns no `blocked` and the orchestrator clears.
//
// Each agent gets its own process-level module mocks, so the two runs live in
// separate files' worth of state — except here they share one, which is fine:
// the agents' in-memory dedupe sets are per-module and each agent runs once.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const HOME = 'Boston Celtics', AWAY = 'Miami Heat';
const GAME_ID = 'g-nba-1';
const game = {
  sport: 'NBA', game_id: GAME_ID, home: HOME, away: AWAY,
  commence_time: '2026-11-07T23:00:00Z',
  books: {
    dk: { label: 'DK', markets: { [`h2h:${HOME}`]: { price: 120 }, [`h2h:${AWAY}`]: { price: -140 } } },
    fd: { label: 'FD', markets: { [`h2h:${HOME}`]: { price: 131 }, [`h2h:${AWAY}`]: { price: -151 } } },
  },
};
const intel = {
  splits: [{ sport: 'NBA', game_id: GAME_ID, market: 'ml', side: HOME, bets_pct: 78, handle_pct: 60, divergence: -18, rlm: true }],
  sharp: [{ game_id: GAME_ID, market: 'h2h', side: HOME, detail: 'steam: 3 books moved +120 → +131' }],
  weather: [], injuries: [], schedule: [], mlbContext: [], umpire: [], lineup: [], bullpenFatigue: [],
};

// The live rejection, in db.insert's rethrow shape. monitor_scores.price was
// one even-book moneyline away from producing exactly this.
const REJECTION = 'insert monitor_scores: invalid input syntax for type integer: "125.5"';

const logs = { info: [], warn: [], error: [] };
let signalRes, fadeRes;

before(async () => {
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      async select() { return []; },
      async insert(table) {
        // Only the monitor_scores batch is rejected: public-fade also writes
        // `public_fades`, and failing that too would let a test pass on the
        // wrong write. alert_log is the signal agent's notification record.
        if (table === 'monitor_scores') throw new Error(REJECTION);
        return { data: [], count: 0 };
      },
    },
  });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: {
      getGames: () => [game],
      getIntel: (k) => (k === 'splits' ? intel.splits : []),
      signalsForGame: () => intel,
      getPower: () => ({}),
      getPredMarket: () => null,
      getBacktest: () => null,
      getNflTotals: () => null,
      getNflPace: () => null,
      setPlays: () => {},
      setFadePlays: () => {},
    },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: {
        info: (...a) => logs.info.push(a.join(' ')),
        warn: (...a) => logs.warn.push(a.join(' ')),
        error: (...a) => logs.error.push(a.join(' ')),
      },
      notifyAll: async () => ({ total: 0, email: true, sms: false }),
    },
  });
  const signal = (await import('../src/agents/signal-engine/index.js')).default;
  const fade = (await import('../src/agents/public-fade/index.js')).default;
  signalRes = await signal.run();
  fadeRes = await fade.run();
});
after(() => mock.reset());

test('a failed signal-engine monitor_scores insert is reported as lost, not as success', () => {
  assert.equal(signalRes.data.newAlerts, 1, 'the scripted slate must still produce one new play');
  assert.equal(signalRes.data.written, 0, 'nothing landed, so `written` must be 0');
  assert.equal(signalRes.data.lost, 1, 'the whole batch is lost — `lost` must say so');
  assert.match(signalRes.summary, /\(1 new, 0 written, 1 lost\)/,
    `the summary must name the loss, not just the count built — got ${JSON.stringify(signalRes.summary)}`);
});

test('a failed public-fade monitor_scores insert is reported as lost, not as success', () => {
  assert.equal(fadeRes.data.graded, 1, 'the scripted slate must still produce one graded fade');
  assert.equal(fadeRes.data.written, 0, 'nothing landed, so `written` must be 0');
  assert.equal(fadeRes.data.lost, 1, 'the whole batch is lost — `lost` must say so');
  assert.match(fadeRes.summary, /1 new → grading: 0 written, 1 lost/,
    `the summary must name the loss, not just the count built — got ${JSON.stringify(fadeRes.summary)}`);
});

test('each lost batch logs once at error level, carrying the database message', () => {
  const mine = logs.error.filter((l) => l.includes('invalid input syntax'));
  assert.equal(mine.length, 2, 'one error per agent — a lost write is not a warn in a ring buffer');
  for (const l of mine) {
    assert.match(l, /1 rows lost/, 'the count belongs in the log, where it can vary freely');
    assert.match(l, /invalid input syntax for type integer/, 'the database message is what explains the loss');
  }
  assert.deepEqual(logs.warn.filter((l) => l.includes('invalid input syntax')), [],
    'a lost write must not be downgraded to warn');
});

test('a total write loss returns a blocked reason, in both agents', () => {
  for (const [name, res] of [['signal-engine', signalRes], ['public-fade', fadeRes]]) {
    assert.equal(typeof res.blocked, 'string', `${name} built rows and landed none — that is D80's blocked`);
    assert.match(res.blocked, /monitor_scores rejects the batch/, `${name}'s reason must name the table`);
    assert.match(res.blocked, /alter column in scripts\/schema\.sql/, `${name}'s reason must name the fix`);
    // The D80 trap: the orchestrator treats a changed reason as a NEW fault and
    // restarts the streak, so a reason carrying a run-varying count would sit
    // at blockedRuns 1 forever and re-fire reportDegraded every run.
    assert.ok(!/\d/.test(res.blocked),
      `${name}'s blocked reason must be a constant literal with no counts — got ${JSON.stringify(res.blocked)}`);
  }
  assert.equal(signalRes.blocked, fadeRes.blocked,
    'both write the same table, so the same literal — one fix clears both');
});
