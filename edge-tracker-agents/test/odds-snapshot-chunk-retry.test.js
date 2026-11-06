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
// And then the cases between those two poles, which are the ones production
// actually produces:
//
//  3. Partial loss in ONE run: some chunks lost for good, another chunk
//     recovered on retry. The arithmetic must be exact, the alarm must stand
//     (a recovery later in the loop must not retract an alarm an earlier,
//     final loss earned), and it must not matter which order the two happen in.
//
//  4. A chunk that fails for a reason that is NOT a statement timeout — a
//     constraint violation, a missing column, a network error with no code at
//     all — is not retried (retrying bad rows into the same error is not
//     load), is counted lost, does not abort the chunks after it, and leaves
//     the alarm standing.
//
//  5. `line_movements` still gets the D73 strip-and-retry on a missing column,
//     with the minimal return preserved on the retry, and that error is never
//     mistaken for a timeout.
//
//  6. A lost batch is not a lost baseline: the in-process baseline is the
//     observation itself, not the row, so the run after a total loss still
//     reads movement off it, and a cold boot against a table that is missing
//     those rows hydrates nothing and says so, rather than assuming they landed.
//
//  7. The `ODDS_SNAPSHOT_CHUNK` knob: a malformed value must collapse to the
//     default, never to a negative step (an infinite loop in an agent the
//     orchestrator awaits before every other agent) or a fractional one
//     (empty chunks and double writes).
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
const MOVE_KEY = 'write|line_movements';

// `shift` moves every spread point so a run produces movement rows against
// the previous run's baseline; 0 means "same board as last time".
let shift = 0;
const ev = (i) => ({
  id: `g${i}`, home_team: `Home${i}`, away_team: `Away${i}`, commence_time: iso(now + (20 + i) * MIN),
  bookmakers: [{
    key: 'draftkings', last_update: iso(Date.now()),
    markets: [
      { key: 'h2h', last_update: iso(Date.now()),
        outcomes: [{ name: `Home${i}`, price: -130 }, { name: `Away${i}`, price: 110 }] },
      { key: 'spreads', last_update: iso(Date.now()),
        outcomes: [{ name: `Home${i}`, point: -3 - shift, price: -110 }, { name: `Away${i}`, point: 3 + shift, price: -110 }] },
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

// Plan-driven failures for the cases after the first two. When `snapshotPlan`
// is set it overrides `mode`: it is called with the chunk's ordinal within the
// run (0-based, in write order) and which attempt this is for that chunk
// (1 or 2), and returns an Error to throw or null to let the chunk land.
let snapshotPlan = null;
let movementPlan = null;       // (attempt, rows) => Error | null, for line_movements
let nGames = N_GAMES;          // how many games the fake Odds API returns
let maxChunk = CHUNK;          // the largest chunk the fake will accept
const chunkOrdinal = new WeakMap(); // first row -> ordinal within its run
const chunkTries = new WeakMap();   // first row -> attempts so far
let chunksThisRun = 0;
const snapshotCalls = []; // { ordinal, attempt, size, options }
const movementCalls = []; // { attempt, rows, options }

const tick = () => new Promise((r) => setTimeout(r, 5));
const runOdds = async (m = mod) => { await tick(); chunksThisRun = 0; return m.default.run(); };
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
    if (table === 'line_movements') {
      const attempt = movementCalls.length + 1;
      movementCalls.push({ attempt, rows, options });
      const err = movementPlan ? movementPlan(attempt, rows) : null;
      if (err) {
        reportDegraded(MOVE_KEY, `insert line_movements failing — ${err.message}`);
        throw err;
      }
      return realInsert(table, rows);
    }
    if (table !== 'line_snapshots') return realInsert(table, rows);
    attempts++;
    assert.equal(options?.returning, 'minimal', 'every snapshot chunk asks for the minimal return');
    assert.ok(rows.length > 0, 'an empty chunk is a wasted statement — the chunker must never emit one');
    assert.ok(rows.length <= maxChunk, `chunk of ${rows.length} exceeds ODDS_SNAPSHOT_CHUNK=${maxChunk}`);
    if (snapshotPlan) {
      if (!chunkOrdinal.has(rows[0])) chunkOrdinal.set(rows[0], chunksThisRun++);
      const ordinal = chunkOrdinal.get(rows[0]);
      const attempt = (chunkTries.get(rows[0]) || 0) + 1;
      chunkTries.set(rows[0], attempt);
      snapshotCalls.push({ ordinal, attempt, size: rows.length, options });
      const err = snapshotPlan(ordinal, attempt);
      if (err) {
        reportDegraded(KEY, `insert line_snapshots failing — ${err.message}`);
        throw err;
      }
      return realInsert(table, rows);
    }
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
      : Array.from({ length: nGames }, (_, i) => ev(i))),
  });

  mod = await import('../src/agents/odds/index.js');
});
after(() => { mock.reset(); clearDegraded(KEY); clearDegraded(MOVE_KEY); });

const standing = (key = KEY) => getDegraded().some((d) => d.key === key);
const resetLogs = () => { logs.info.length = 0; logs.warn.length = 0; logs.error.length = 0; };
const errorsAbout = (re) => logs.error.filter((l) => re.test(l));

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

// ── 3. Partial loss: exact arithmetic, and the alarm survives a later recovery ──
//
// The production batch: 4,800 rows. With this file's 50-row chunks that is 96
// chunks; ten of them (ordinals 30–39, 500 rows) time out on both attempts and
// are lost for good, one (ordinal 70) times out once and lands on retry. Same
// numbers D99 reasons about — 4,300 written, 500 lost — and the recovery comes
// AFTER the loss in write order, which is the order that matters: the retry
// that lands at chunk 70 must not retract the alarm chunks 30–39 earned.
const PROD_ROWS = 4800;
const partialPlan = (lostFrom, lostTo, recoverAt) => (ordinal, attempt) => {
  if (ordinal >= lostFrom && ordinal <= lostTo) return statementTimeout();     // both attempts
  if (ordinal === recoverAt && attempt === 1) return statementTimeout();       // first attempt only
  return null;
};

test('partial loss: 4,800 rows, 500 lost for good, one chunk recovered later — 4300/500, one error, alarm standing', async () => {
  nGames = PROD_ROWS / ROWS_PER_GAME; // 800 games x 6 rows
  snapshotPlan = partialPlan(30, 39, 70);
  snapshotCalls.length = 0;
  resetLogs();
  clearDegraded(KEY);
  const before = fdb.rows('line_snapshots').length;

  const r = await runOdds();

  assert.equal(r.data.snapshots, PROD_ROWS, `precondition — the production-sized batch was built: ${r.summary}`);
  const chunks = Math.ceil(PROD_ROWS / CHUNK);
  assert.equal(new Set(snapshotCalls.map((c) => c.ordinal)).size, chunks, `all ${chunks} chunks were attempted — a lost chunk does not abort the rest`);
  assert.equal(snapshotCalls.length, chunks + 10 + 1, 'exactly one retry per timed-out chunk: 96 first attempts + 10 + 1 retries');
  assert.equal(snapshotCalls.filter((c) => c.ordinal >= 30 && c.ordinal <= 39 && c.attempt === 2).length, 10,
    'each lost chunk was retried exactly once before being given up on');
  assert.equal(snapshotCalls.filter((c) => c.ordinal === 70).length, 2, 'the recovered chunk was tried twice');

  assert.equal(r.data.snapshotsWritten, PROD_ROWS - 500, `written: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.snapshotsLost, 500, `lost: ${JSON.stringify(r.data)}`);
  assert.equal(fdb.rows('line_snapshots').length - before, PROD_ROWS - 500, 'and that is what actually landed');
  assert.equal(r.data.snapshotsWritten + r.data.snapshotsLost, r.data.snapshots, 'written + lost = built, always');
  assert.match(r.summary, /4800 snapshots \(4300 written, 500 lost\)/, r.summary);

  const errs = errorsAbout(/snapshot write/);
  assert.equal(errs.length, 1, `exactly one error line for the run: ${logs.error.join(' | ')}`);
  assert.match(errs[0], /500\/4800 rows lost/, errs[0]);
  assert.match(errs[0], /after 21 statement timeout\(s\)/, `10 chunks x 2 + 1 = 21 timeouts: ${errs[0]}`);

  assert.equal(standing(), true,
    'chunk 70 landing on retry must NOT retract the write|line_snapshots alarm that chunks 30-39 earned by being lost for good — ' +
    'a final loss in the run wins over a recovery in the same run, whatever the order');
});

test('partial loss, recovery BEFORE the loss in write order: same numbers, alarm still standing', async () => {
  nGames = PROD_ROWS / ROWS_PER_GAME;
  snapshotPlan = partialPlan(70, 79, 30); // chunk 30 recovers, chunks 70-79 are lost afterwards
  snapshotCalls.length = 0;
  resetLogs();
  clearDegraded(KEY);

  const r = await runOdds();

  assert.equal(r.data.snapshotsWritten, 4300, JSON.stringify(r.data));
  assert.equal(r.data.snapshotsLost, 500);
  assert.match(r.summary, /4800 snapshots \(4300 written, 500 lost\)/, r.summary);
  assert.equal(errorsAbout(/snapshot write/).length, 1, logs.error.join(' | '));
  assert.equal(standing(), true, 'the order of recovery and loss within a run must not change the verdict');
});

test('a run with retries but no loss still clears the alarm (the partial-loss rule does not over-correct)', async () => {
  nGames = N_GAMES;
  snapshotPlan = (ordinal, attempt) => (ordinal === 1 && attempt === 1 ? statementTimeout() : null);
  resetLogs();
  clearDegraded(KEY);

  const r = await runOdds();
  assert.equal(r.data.snapshotsLost, 0, JSON.stringify(r.data));
  assert.equal(r.data.snapshotsWritten, N_GAMES * ROWS_PER_GAME);
  assert.equal(logs.error.length, 0, logs.error.join(' | '));
  assert.ok(logs.warn.some((l) => /1 chunk\(s\) timed out once and landed on retry/.test(l)),
    `a recovered chunk is a warn, not silence: ${logs.warn.join(' | ')}`);
  assert.equal(standing(), false, 'every row landed — the alarm the first attempt fired is a false one and must be retracted');
});

// ── 4. Non-timeout failures: not retried, counted lost, the rest continues ──
const notNull = () => Object.assign(
  new Error('insert line_snapshots: null value in column "line" of relation "line_snapshots" violates not-null constraint'),
  { code: '23502' });
const missingCol = () => Object.assign(
  new Error("insert line_snapshots: Could not find the 'last_update' column of 'line_snapshots' in the schema cache"),
  { code: 'PGRST204' });
const noCode = () => new Error('insert line_snapshots: TypeError: fetch failed'); // pool/network: no SQLSTATE at all

for (const [label, make, code] of [
  ['a not-null violation (23502)', notNull, '23502'],
  ['a missing column (PGRST204)', missingCol, 'PGRST204'],
  ['an error with no .code at all (network/pool)', noCode, undefined],
]) {
  test(`chunk failing with ${label} is not retried, is counted lost, and the remaining chunks still land`, async () => {
    nGames = N_GAMES;
    const built = N_GAMES * ROWS_PER_GAME; // 120 rows: chunks of 50, 50, 20
    snapshotPlan = (ordinal) => (ordinal === 1 ? make() : null);
    snapshotCalls.length = 0;
    resetLogs();
    clearDegraded(KEY);
    const before = fdb.rows('line_snapshots').length;

    const r = await runOdds();

    assert.equal(snapshotCalls.filter((c) => c.ordinal === 1).length, 1,
      `code ${code}: the chunk was tried ONCE — only a statement timeout earns a retry; retrying bad rows is not load`);
    assert.deepEqual(snapshotCalls.map((c) => c.ordinal), [0, 1, 2], 'chunk 2 was still attempted after chunk 1 failed');
    assert.equal(r.data.snapshotsWritten, built - CHUNK, JSON.stringify(r.data));
    assert.equal(r.data.snapshotsLost, CHUNK);
    assert.equal(fdb.rows('line_snapshots').length - before, built - CHUNK, 'chunks 0 and 2 landed');
    assert.match(r.summary, new RegExp(`${built} snapshots \\(${built - CHUNK} written, ${CHUNK} lost\\)`), r.summary);

    const errs = errorsAbout(/snapshot write/);
    assert.equal(errs.length, 1, logs.error.join(' | '));
    assert.match(errs[0], new RegExp(`${CHUNK}/${built} rows lost`), errs[0]);
    assert.doesNotMatch(errs[0], /statement timeout\(s\)/, `a ${code} loss must not be reported as a timeout: ${errs[0]}`);
    assert.ok(errs[0].includes(make().message), `the error names the real cause: ${errs[0]}`);
    assert.equal(standing(), true, 'a chunk lost to a real error leaves write|line_snapshots standing');
  });
}

// ── 5. line_movements: minimal return + the D73 strip-and-retry, not confused with a timeout ──
test('line_movements missing gap_min: stripped and retried once with the minimal return preserved; alarm cleared', async () => {
  nGames = N_GAMES;
  snapshotPlan = () => null;
  shift = 0.5; // every spread moves half a point against the previous run's baseline
  movementCalls.length = 0;
  movementPlan = (attempt) => (attempt === 1
    ? Object.assign(new Error("insert line_movements: Could not find the 'gap_min' column of 'line_movements' in the schema cache"), { code: 'PGRST204' })
    : null);
  resetLogs();
  clearDegraded(MOVE_KEY);
  clearDegraded(KEY); // the non-timeout cases above left it standing, by design

  const r = await runOdds().finally(() => { movementPlan = null; shift = 0; });

  assert.ok(r.data.movements >= N_GAMES, `precondition — the shifted spreads produced movement rows: ${r.summary}`);
  assert.equal(movementCalls.length, 2, 'probe failed on the missing column, ONE retry, no third attempt');
  assert.equal(movementCalls[0].options?.returning, 'minimal', 'the first movement insert asks for the minimal return');
  assert.equal(movementCalls[1].options?.returning, 'minimal', 'and so does the stripped retry — the option must survive the strip');
  assert.ok(movementCalls[0].rows.every((m) => 'gap_min' in m && 'baseline_source' in m), 'the probe carried the D73 columns');
  assert.ok(movementCalls[1].rows.every((m) => !('gap_min' in m) && !('baseline_source' in m)), 'the retry stripped both');
  assert.equal(movementCalls[1].rows.length, movementCalls[0].rows.length, 'same rows, minus the two columns');
  assert.equal(fdb.rows('line_movements').length, r.data.movements, 'every movement row landed on the retry');
  assert.ok(logs.warn.some((l) => /line_movements is missing gap_min/.test(l)), logs.warn.join(' | '));
  assert.equal(logs.error.length, 0, `nothing lost: ${logs.error.join(' | ')}`);
  assert.equal(standing(MOVE_KEY), false, 'the probe fired write|line_movements; the landed retry retracts it (D73)');
  assert.equal(standing(KEY), false, 'and the snapshot alarm is untouched by the movement path');
});

test('line_movements timing out is NOT the missing-column path: no strip, no retry, warned, alarm standing', async () => {
  nGames = N_GAMES;
  snapshotPlan = () => null;
  movementPlan = null;
  mod.__resetBaseline(); // un-latch extraCols from the missing-column case above, whether or not it passed
  shift = 1; // a fresh board after __resetBaseline: this run seeds the baseline …
  await runOdds();
  shift = 1.5; // … and this one moves off it
  movementCalls.length = 0;
  movementPlan = () => Object.assign(new Error('insert line_movements: canceling statement due to statement timeout'), { code: '57014' });
  resetLogs();
  clearDegraded(MOVE_KEY);

  const r = await runOdds().finally(() => { movementPlan = null; shift = 0; });

  assert.ok(r.data.movements >= N_GAMES, `precondition — movement rows were built: ${r.summary}`);
  assert.equal(movementCalls.length, 1, 'a 57014 on line_movements is rethrown as-is: no strip-and-retry, and no timeout retry either (that is the snapshot path only)');
  assert.ok(movementCalls[0].rows.every((m) => 'gap_min' in m), 'the columns were not stripped — a timeout is not a schema error');
  assert.ok(logs.warn.some((l) => /movement write: .*statement timeout/.test(l)), logs.warn.join(' | '));
  assert.equal(standing(MOVE_KEY), true, 'the movement write really failed; the alarm stands');
});

// ── 6. A lost batch is not a lost baseline ──
test('after a run that lost its whole batch, the next run still reads movement off the in-process baseline and writes in full', async () => {
  nGames = N_GAMES;
  shift = 0;
  snapshotPlan = () => statementTimeout(); // total loss, every attempt
  resetLogs();
  const r1 = await runOdds();
  assert.equal(r1.data.snapshotsWritten, 0, `precondition — the batch was lost: ${r1.summary}`);
  assert.equal(r1.data.snapshotsLost, N_GAMES * ROWS_PER_GAME);

  snapshotPlan = () => null;
  shift = 0.5; // the board moves against the baseline the LOST run observed
  resetLogs();
  const r2 = await runOdds();
  assert.equal(r2.data.snapshots, N_GAMES * ROWS_PER_GAME, 'the games whose rows were lost are re-observed in full, not skipped as seen');
  assert.equal(r2.data.snapshotsWritten, r2.data.snapshots, `and this run lands: ${r2.summary}`);
  assert.ok(r2.data.movements >= N_GAMES,
    `the baseline is the observation, not the row — a lost insert must not blank it: ${r2.summary}`);
  shift = 0;
});

test('cold boot against a table missing the lost rows hydrates nothing, reports it, and does not count the games as read failures', async () => {
  nGames = N_GAMES;
  snapshotPlan = () => null;
  mod.__resetBaseline();
  fdb.setRows('line_snapshots', []); // the rows a lost batch would have left are simply not there
  resetLogs();

  const r = await runOdds();
  assert.equal(r.data.rehydratedKeys, 0, `nothing to hydrate from: ${r.summary}`);
  assert.equal(r.data.rehydratedGames, 2, 'the reads succeeded (empty is an answer, a timeout is not) — the cold cap of 2 was spent');
  assert.match(r.summary, /baseline 2\/2 games → 0 keys rehydrated/, r.summary);
  assert.doesNotMatch(r.summary, /read failures/, 'an empty table is not a failed read');
  assert.equal(r.data.snapshotsWritten, N_GAMES * ROWS_PER_GAME, 'and this run\'s own batch lands normally');
});

// ── 7. The chunk-size knob ──
// `Number(env) || 500` makes '', '  ', '0' and 'abc' collapse to 500 — fine for
// a size, 0 is not a chunk. But a NEGATIVE value is a negative loop step: with
// `i += -5` the loop never terminates and the odds agent hangs, and the
// orchestrator awaits odds before every other agent. A FRACTIONAL step emits
// empty chunks and visits rows twice. Each must collapse to the default.
const DEFAULT_CHUNK = 500;
for (const [raw, why] of [
  ['abc', 'NaN'],
  ['-5', 'a negative step is an infinite loop'],
  ['0.5', 'a fractional step emits empty chunks'],
  ['0', 'zero is not a chunk'],
  ['', 'empty'],
  ['  ', 'whitespace'],
]) {
  test(`ODDS_SNAPSHOT_CHUNK=${JSON.stringify(raw)} (${why}) collapses to ${DEFAULT_CHUNK}: one chunk for 120 rows, run terminates`, async () => {
    process.env.ODDS_SNAPSHOT_CHUNK = raw;
    const fresh = await import(`../src/agents/odds/index.js?chunk=${encodeURIComponent(raw)}`);
    nGames = N_GAMES;
    maxChunk = DEFAULT_CHUNK;
    snapshotPlan = () => null;
    snapshotCalls.length = 0;
    resetLogs();
    try {
      const r = await Promise.race([
        runOdds(fresh),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`odds run did not terminate with ODDS_SNAPSHOT_CHUNK=${JSON.stringify(raw)}`)), 5000).unref()),
      ]);
      const built = N_GAMES * ROWS_PER_GAME;
      assert.equal(r.data.snapshotsWritten, built, r.summary);
      assert.equal(r.data.snapshotsLost, 0);
      assert.deepEqual(snapshotCalls.map((c) => c.size), [built],
        `120 rows at the default chunk of ${DEFAULT_CHUNK} is exactly one insert of 120 — no empty chunks, no row written twice`);
      assert.equal(fdb.rows('line_snapshots').filter((s) => s.game_id === 'g0').length % ROWS_PER_GAME, 0,
        'no row was written twice');
    } finally {
      maxChunk = CHUNK;
      process.env.ODDS_SNAPSHOT_CHUNK = String(CHUNK);
    }
  });
}

test('ODDS_SNAPSHOT_CHUNK="1e2" and "  120 " are honoured as 100 and 120', async () => {
  for (const [raw, size] of [['1e2', 100], ['  120 ', 120]]) {
    process.env.ODDS_SNAPSHOT_CHUNK = raw;
    const fresh = await import(`../src/agents/odds/index.js?chunk=${encodeURIComponent(raw)}`);
    nGames = N_GAMES;
    maxChunk = size;
    snapshotPlan = () => null;
    snapshotCalls.length = 0;
    try {
      const r = await runOdds(fresh);
      assert.equal(r.data.snapshotsWritten, N_GAMES * ROWS_PER_GAME, r.summary);
      assert.deepEqual(snapshotCalls.map((c) => c.size), size === 100 ? [100, 20] : [120], `chunk ${JSON.stringify(raw)}`);
    } finally {
      maxChunk = CHUNK;
      process.env.ODDS_SNAPSHOT_CHUNK = String(CHUNK);
    }
  }
});
