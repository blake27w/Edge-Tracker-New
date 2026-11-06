// ══════════════════════════════════════════════════════════════
// The chunked snapshot write's retry and its degradation bookkeeping.
//
// odds-snapshot-insert-timeout.test.js proves the size failure (a batch too
// big for the statement timeout still lands once chunked). This file proves
// the two things around it:
//
//  1. A chunk that times out ONCE and lands on retry costs nothing visible:
//     every row is written, no error is logged, and the `write|line_snapshots`
//     degradation the failed first attempt fired is retracted — otherwise
//     /data-health and the watchdog report snapshot writes as broken for the
//     full TTL while every row is in fact landing (D73's false alarm, again).
//
//  2. When every chunk times out twice the loss is reported: 0 written, the
//     count named in the summary, logged at error, and the degradation LEFT
//     STANDING — that one is real.
//
// The fake db fires reportDegraded on a failed insert exactly as the real
// db layer does, so the retraction is tested against the real store.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';
import { getDegraded, reportDegraded, clearDegraded } from '../src/store/index.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const N_GAMES = 20;
const ROWS_PER_GAME = 6; // 1 book x 3 markets x 2 outcomes
const CHUNK = 50;        // 120 rows → 3 chunks (50, 50, 20)
const KEY = 'write|line_snapshots';

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
let mode = 'once'; // 'once': each chunk's first attempt times out; 'always': every attempt does
const seen = new WeakSet(); // chunks that have already timed out once (keyed by first row)
let attempts = 0;

const tick = () => new Promise((r) => setTimeout(r, 5));
const runOdds = async () => { await tick(); return mod.default.run(); };
const statementTimeout = () => Object.assign(
  new Error('insert line_snapshots: canceling statement due to statement timeout'), { code: '57014' });

before(async () => {
  process.env.ODDS_SNAPSHOT_CHUNK = String(CHUNK);
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
  const realInsert = fdb.insert.bind(fdb);
  fdb.insert = async (table, rows, options) => {
    if (table !== 'line_snapshots') return realInsert(table, rows);
    attempts++;
    assert.equal(options?.returning, 'minimal', 'every snapshot chunk asks for the minimal return');
    assert.ok(rows.length <= CHUNK, `chunk of ${rows.length} exceeds ODDS_SNAPSHOT_CHUNK=${CHUNK}`);
    const first = mode === 'once' && !seen.has(rows[0]);
    if (mode === 'always' || first) {
      seen.add(rows[0]);
      // What the real db layer does before rethrowing.
      reportDegraded(KEY, 'insert line_snapshots failing — canceling statement due to statement timeout');
      throw statementTimeout();
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
after(() => { mock.reset(); clearDegraded(KEY); });

const standing = () => getDegraded().some((d) => d.key === KEY);

test('a chunk that times out once lands on retry, and the false alarm is cleared', async () => {
  clearDegraded(KEY);
  const r = await runOdds();
  const built = N_GAMES * ROWS_PER_GAME;
  const chunks = Math.ceil(built / CHUNK);

  assert.equal(r.data.snapshots, built, `precondition — the full batch was built: ${r.summary}`);
  assert.equal(fdb.rows('line_snapshots').length, built, 'every row landed on the second attempt');
  assert.equal(attempts, chunks * 2, `each of ${chunks} chunks was tried exactly twice (once failed, once landed)`);
  assert.equal(r.data.snapshotsWritten, built, `written must equal built: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.snapshotsLost, 0);
  assert.match(r.summary, new RegExp(`${built} snapshots \\(${built} written\\)`), r.summary);
  assert.doesNotMatch(r.summary, /lost/, `nothing was lost: ${r.summary}`);
  assert.equal(logs.error.length, 0, `nothing lost → nothing at error: ${logs.error.join(' | ')}`);
  assert.equal(standing(), false,
    'the degradation the failed first attempt fired must be retracted once the retry lands (D73)');
});

test('when every chunk times out twice, nothing lands, the loss is named and the alarm stands', async () => {
  mode = 'always';
  attempts = 0;
  clearDegraded(KEY);
  const before = fdb.rows('line_snapshots').length;
  const r = await runOdds();
  const built = N_GAMES * ROWS_PER_GAME;
  const chunks = Math.ceil(built / CHUNK);

  assert.equal(fdb.rows('line_snapshots').length, before, 'nothing landed');
  assert.equal(attempts, chunks * 2, 'each chunk was retried exactly once, then given up on — no unbounded retry');
  assert.equal(r.data.snapshotsWritten, 0, JSON.stringify(r.data));
  assert.equal(r.data.snapshotsLost, built);
  assert.match(r.summary, new RegExp(`${built} snapshots \\(0 written, ${built} lost\\)`), r.summary);
  assert.ok(logs.error.some((l) => /snapshot/.test(l) && /timeout/.test(l) && new RegExp(`${built}/${built}`).test(l)),
    `the loss is logged at error naming the timeout and the count: ${logs.error.join(' | ')}`);
  assert.equal(standing(), true, 'a genuine, final loss leaves write|line_snapshots standing for the watchdog');
});
