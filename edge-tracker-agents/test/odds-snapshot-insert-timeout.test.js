// ══════════════════════════════════════════════════════════════
// The snapshot write is one unchunked `db.insert('line_snapshots', snapshots)`
// (src/agents/odds/index.js, "Persist snapshots + movements + budget") inside
// `try { … } catch (e) { logger.warn(...) }`. A busy run builds ~4,800 rows
// (117 games x 11 books x 3 markets x 2 outcomes is the ceiling; ~4,800 is a
// typical slate), PostgREST runs the whole array as ONE statement, and the
// table is 7M rows with four btree indexes to maintain per row — so under load
// the statement exceeds the 8s statement timeout, the WHOLE batch is rolled
// back, and the only trace is a WARN line in a 100-entry ring buffer. The
// summary still reads "N snapshots" as if they landed.
//
// Observed live 2026-11-06: `write|line_snapshots` count 15 across 60 odds
// runs since boot — one run in four lost every snapshot it took. Snapshots are
// the raw material for the movement baseline, book-move, CLV closes and the
// steam reader, so each lost batch is a hole in all four.
//
// Two contracts, both red on today's code:
//
//  1. A batch that times out AS A WHOLE must still be persisted — written in
//     pieces small enough to finish. The fake here times out any single insert
//     over SIZE_LIMIT rows and accepts anything smaller, so a retry of the same
//     oversized batch stays red and only chunking (with or without retry) goes
//     green. That is the point: the production failure is a size failure, and
//     retrying 4,800 rows into the same timeout is not a fix.
//
//  2. When the rows genuinely cannot be written — every chunk, every retry
//     times out — the run must REPORT the loss, in the result Blake reads and
//     at error level, not warn. `data.snapshots` today is the count BUILT, not
//     the count WRITTEN; a run that persisted nothing must not be
//     indistinguishable from one that persisted everything.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// 20 games x 1 book x 3 markets x 2 outcomes = 120 snapshot rows a run.
const N_GAMES = 20;
const ROWS_PER_GAME = 6;
const SIZE_LIMIT = 50; // any single insert above this "times out"

const ev = (i) => ({
  id: `g${i}`, home_team: `Home${i}`, away_team: `Away${i}`, commence_time: iso(now + (20 + i) * MIN),
  bookmakers: [{
    key: 'draftkings', last_update: iso(Date.now()),
    markets: [
      { key: 'h2h', last_update: iso(Date.now()),
        outcomes: [{ name: `Home${i}`, price: -130 }, { name: `Away${i}`, price: 110 }] },
      { key: 'spreads', last_update: iso(Date.now()),
        outcomes: [{ name: `Home${i}`, point: -3, price: -110 }, { name: `Away${i}`, point: 3, price: -110 }] },
      { key: 'totals', last_update: iso(Date.now()),
        outcomes: [{ name: 'Over', point: 44.5, price: -110 }, { name: 'Under', point: 44.5, price: -110 }] },
    ],
  }],
});

let mod;
let fdb;
let logs;
let timeoutsFired = 0;
let timeoutAll = false; // second contract: nothing fits, ever

// The per-key pacer compares against the last fetch time, so wait it out BEFORE
// each run — a trailing wait would be skipped by any failed assertion above it
// and the next test would fetch nothing ("0 calls, 1 paced").
const tick = () => new Promise((r) => setTimeout(r, 5));
const runOdds = async () => { await tick(); return mod.default.run(); };
const statementTimeout = () => Object.assign(
  new Error('insert line_snapshots: canceling statement due to statement timeout'), { code: '57014' });

before(async () => {
  // The write is chunked at ODDS_SNAPSHOT_CHUNK (500 in production); pin it
  // at the fake's limit so the 120-row batch exercises the size failure.
  process.env.ODDS_SNAPSHOT_CHUNK = String(SIZE_LIMIT);
  process.env.ODDS_HYDRATE_COLD_MAX = '2';
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
  // Size-dependent failure: the real db layer's `.insert(rows).select()` is one
  // PostgREST statement for the whole array, and Postgres cancels the whole
  // statement at the timeout — nothing partial lands. The fake mirrors that:
  // over the limit the call throws and writes nothing; under it, rows land.
  const realInsert = fdb.insert.bind(fdb);
  fdb.insert = async (table, rows) => {
    if (table === 'line_snapshots') {
      const n = Array.isArray(rows) ? rows.length : 1;
      if (timeoutAll || n > SIZE_LIMIT) {
        fdb.calls.insert.push({ table, rows, timedOut: true });
        timeoutsFired++;
        throw statementTimeout();
      }
    }
    return realInsert(table, rows);
  };
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
      : Array.from({ length: N_GAMES }, (_, i) => ev(i))),
  });

  mod = await import('../src/agents/odds/index.js');
});
after(() => mock.reset());

test('a snapshot batch too large for the statement timeout is still persisted', async () => {
  const r = await runOdds();
  const built = N_GAMES * ROWS_PER_GAME;
  assert.equal(r.data.snapshots, built, `precondition — the run built the full batch: ${r.summary}`);
  assert.ok(r.data.calls >= 1, `precondition — the run actually fetched: ${r.summary}`);

  const landed = fdb.rows('line_snapshots').length;
  assert.equal(landed, built,
    `every snapshot row must reach line_snapshots even though a ${built}-row insert times out ` +
    `(limit ${SIZE_LIMIT}); ${landed} landed, ${timeoutsFired} insert(s) timed out. ` +
    `Today the whole batch is one insert, the timeout rolls it back, and the warn is the only trace.`);
});

test('the result reports what was WRITTEN, not just what was built', async () => {
  // Same run as above — every row landed (possibly after a timeout on the first
  // attempt), so a written-count must equal the built count and no loss may be
  // reported. The field name is this test's proposal; what matters is that the
  // two numbers are distinct and both present.
  const r = await runOdds();
  assert.equal(fdb.rows('line_snapshots').length, 2 * N_GAMES * ROWS_PER_GAME, r.summary);
  assert.equal(r.data.snapshotsWritten, r.data.snapshots,
    `a run that persisted every row must say so: ${JSON.stringify(r.data)}`);
  assert.equal(logs.error.length, 0, `nothing was lost, nothing to report at error: ${logs.error.join(' | ')}`);
});

test('when no chunk fits the timeout the loss is reported, not warned away', async () => {
  timeoutAll = true;
  const before = fdb.rows('line_snapshots').length;
  const r = await runOdds();
  const built = N_GAMES * ROWS_PER_GAME;

  assert.equal(fdb.rows('line_snapshots').length, before, 'precondition — nothing landed this run');
  assert.equal(r.data.snapshots, built, `precondition — the run built the batch: ${r.summary}`);

  // 1. The result the dashboard/watchdog reads must carry the loss.
  assert.equal(r.data.snapshotsWritten, 0,
    `0 rows persisted must be reported as 0, not as "${built} snapshots": ${JSON.stringify(r.data)}`);
  assert.match(r.summary, new RegExp(`${built}\\b[^·]*\\b(lost|unwritten|dropped|failed)`),
    `the summary line must name the loss (${built} rows), not read like a healthy run: ${r.summary}`);

  // 2. Logged at ERROR, not warn. A warn in a 100-entry ring buffer is how
  // this was invisible for 15 runs.
  assert.ok(logs.error.some((l) => /line_snapshots|snapshot/.test(l) && /timeout/.test(l)),
    `a lost batch is an error, not a warning: errors=${logs.error.join(' | ')} warns=${logs.warn.join(' | ')}`);
});
