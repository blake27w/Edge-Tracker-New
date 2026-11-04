// ══════════════════════════════════════════════════════════════
// The three movement-baseline guards ACTING TOGETHER. Each was added in its
// own pass and tested on its own; this file drives one process through states
// where two or three of them are live at once, because that is where a guard
// that is individually correct can still latch:
//
//   1. `baselineFailed`   — a failed read is not a settled game, so it is retried.
//   2. HYDRATE_FAIL_RUNS  — three all-failed runs forfeit the cold allowance.
//   3. steamSafeMovements — a wide-gap movement is written but not published.
//
// Caps: cold 4, steady 2, probe 1 — three distinguishable numbers, so which cap
// governed a run reads straight off `hydrateAttempted`.
//
// The question this file exists to answer: after any sequence of failures and
// recoveries, does the process return to steady state, or can it wedge?
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Mutable so a test can take a game off the slate (eviction) or move a line.
let slate = ['g1', 'g2', 'g3', 'g4'];
let line = -3;

const ev = (id, i) => ({
  id, home_team: 'Home', away_team: 'Away', commence_time: iso(now + (20 + i) * MIN),
  bookmakers: [{
    key: 'draftkings', last_update: iso(Date.now()),
    markets: [{
      key: 'spreads', last_update: iso(Date.now()),
      outcomes: [{ name: 'Home', point: line, price: -110 }, { name: 'Away', point: -line, price: -110 }],
    }],
  }],
});

let mod;
let fdb;
let logs;
// Games whose line_snapshots read should throw — per game, which `fdb.fail` cannot
// express and which is the shape that matters here: a table that is partly sick.
let failReads = new Set();

const tick = () => new Promise((r) => setTimeout(r, 5));

let seen = 0;
// Which games were read since the last call, so "who got the cap" is observable.
const readsThisRun = () => {
  const all = fdb.calls.select.filter((c) => c.table === 'line_snapshots');
  const fresh = all.slice(seen);
  seen = all.length;
  return { count: fresh.length, games: [...new Set(fresh.map((c) => c.opts.match.game_id))].sort() };
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
  const realSelect = fdb.select;
  fdb.select = async (table, cols, opts = {}) => {
    if (table === 'line_snapshots' && failReads.has(opts.match && opts.match.game_id)) {
      // Record the attempt before throwing — a timed-out read cost the same
      // query a successful one would have, and the cap must see it.
      fdb.calls.select.push({ table, cols, opts });
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    }
    return realSelect(table, cols, opts);
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
      : slate.map(ev)),
  });

  mod = await import('../src/agents/odds/index.js');
});
after(() => mock.reset());

test('all three guards on one run: half the reads fail, and the wide-gap move is written but not published', async () => {
  // g1/g2: the read fails -> no baseline, no movement, and NOT settled.
  // g3: baseline 300 minutes old -> inside the 360 write bound, outside the
  //     35-minute steam bound -> one row in line_movements, nothing published.
  // g4: baseline 5 minutes old -> written AND published.
  failReads = new Set(['g1', 'g2']);
  fdb.setRows('line_snapshots', [
    { game_id: 'g3', book: 'draftkings', market: 'spreads', side: 'Home', line: -2.5, price: -110, fetched_at: iso(now - 300 * MIN) },
    { game_id: 'g4', book: 'draftkings', market: 'spreads', side: 'Home', line: -2.5, price: -110, fetched_at: iso(now - 5 * MIN) },
  ]);

  const r = await mod.default.run();

  assert.equal(r.data.hydrateAttempted, 4, `the cold cap governs run 1: ${r.summary}`);
  assert.equal(r.data.rehydratedGames, 2, 'g3 and g4 only — a failed read is not a hydrated game');
  assert.equal(r.data.hydrateFailures, 4, 'g1 and g2, two markets each');
  assert.equal(r.data.rehydratedKeys, 2, 'one Home key per hydrated game');
  assert.equal(r.data.hydrateFailRuns, 0, 'a run that hydrated something is not an all-failed run');

  // Guard 3, interacting with guard 1's output: both moves are real and both are
  // written; only the one that could have been a single odds cycle is published.
  assert.equal(r.data.movements, 2, `g3 and g4 moved -2.5 -> ${line}: ${r.summary}`);
  const written = fdb.calls.insert.filter((c) => c.table === 'line_movements').at(-1).rows;
  assert.deepEqual(written.map((x) => x.game_id).sort(), ['g3', 'g4'],
    'line_movements is the complete record — it is not steam-filtered');
  assert.ok(written.every((x) => x.baseline_source === 'rehydrated'));
  assert.equal(r.data.steamFeed, 1, `only g4's 5-minute gap may be published: ${r.summary}`);
  assert.equal(r.data.steamDropped, 1);
  assert.equal(r.data.staleBaseline, 0, '300 minutes is inside the 360 write bound');
  await tick();
});

test('the next run retries exactly the failed games — settled games are not re-read', async () => {
  readsThisRun();                 // discard run 1's reads
  line = -3.5;                    // everything moves again, in-process this time
  const r = await mod.default.run();

  // Steady cap (2) now: run 1 hydrated something, so the process is not cold.
  assert.equal(r.data.hydrateAttempted, 2, `steady cap, not cold: ${r.summary}`);
  const { games } = readsThisRun();
  assert.deepEqual(games, ['g1', 'g2'],
    'g3/g4 were settled by a successful read; g1/g2 stayed unsettled because theirs failed');
  assert.equal(r.data.rehydratedGames, 0);
  assert.equal(r.data.hydrateFailRuns, 1, 'every game it attempted failed — streak 1');
  assert.doesNotMatch(r.summary, /circuit-broken/);

  // And the reseed from run 1 is doing its job. Every key of every game —
  // including g1/g2, whose READ failed but which normalize() still observed, and
  // g3, whose baseline was 300 minutes old last run — now carries an in-process
  // baseline milliseconds old. So all 8 keys (4 games x Home/Away) move and all
  // 8 are publishable: a wide gap is a property of the baseline, not a latch.
  assert.equal(r.data.movements, 8, r.summary);
  assert.equal(r.data.steamDropped, 0, 'the reseeded baseline is milliseconds old');
  assert.equal(r.data.steamFeed, 8);
  assert.equal(r.data.staleBaseline, 0);
  await tick();
});

test('the breaker still trips in steady state, on the two games guard 1 keeps alive', async () => {
  for (const run of [2, 3]) {
    const r = await mod.default.run();
    assert.equal(r.data.hydrateFailRuns, run, r.summary);
    assert.equal(r.data.hydrateAttempted, 2, `streak ${run} is still at the steady cap`);
    await tick();
  }
  assert.ok(logs.warn.some((l) => /failed every read for 3 consecutive runs/.test(l)),
    `the crossing is announced: ${logs.warn.join(' | ')}`);

  const probe = await mod.default.run();
  assert.equal(probe.data.hydrateAttempted, 1, `and the next run probes: ${probe.summary}`);
  assert.equal(readsThisRun().count > 0, true);
  await tick();
});

test('the table recovers for one game mid-outage: the streak clears and steady state resumes', async () => {
  readsThisRun();
  failReads = new Set(['g2']);    // g1 answers again, g2 is still sick
  fdb.setRows('line_snapshots', [
    { game_id: 'g1', book: 'draftkings', market: 'spreads', side: 'Home', line: -9, price: -110, fetched_at: iso(now - 2 * MIN) },
  ]);

  const recovery = await mod.default.run();
  const probed = readsThisRun().games;
  assert.equal(recovery.data.hydrateAttempted, 1, `still a probe on the recovery run: ${recovery.summary}`);

  if (probed.includes('g1')) {
    assert.equal(recovery.data.rehydratedGames, 1, recovery.summary);
    assert.equal(recovery.data.hydrateFailRuns, 0, 'one hydrated game clears the streak');
  } else {
    // The probe landed on the game that is still sick — the streak keeps
    // counting and the breaker stays shut. Either way it must not wedge.
    assert.equal(recovery.data.rehydratedGames, 0, recovery.summary);
    assert.ok(recovery.data.hydrateFailRuns >= 4, recovery.summary);
  }
  await tick();

  // g2 never answers again, and guard 1 keeps it pending forever by design, so
  // the streak rebuilds and the breaker re-trips. That is the steady state this
  // combination settles into, and the thing that matters is its COST: the probe
  // cap, 2 selects a run. The cold allowance is never refunded — the 240-query
  // burst into a table that just came back is the behaviour being prevented.
  let r;
  for (let i = 0; i < 4; i++) {
    r = await mod.default.run();
    assert.ok(r.data.hydrateAttempted <= 2,
      `never back to the cold cap after an outage: ${r.summary}`);
    await tick();
  }
  assert.ok(r.data.hydrateFailRuns >= 3,
    `one permanently sick game re-trips the breaker, which is correct: ${r.summary}`);
  assert.equal(readsThisRun().count <= 2 * 4 + 2, true,
    'and it stays cheap — a probe, not a re-spend');
  // Once per CROSSING, not once per run: the streak reset on the recovery and
  // rebuilt, so the condition genuinely recurred and is announced again — but
  // the probe runs in between stay quiet, which is the property that keeps the
  // warn readable.
  assert.equal(logs.warn.filter((l) => /consecutive runs/.test(l)).length, 2,
    `two crossings, two announcements: ${logs.warn.join(' | ')}`);
});

test('a tripped breaker costs new games only their HISTORICAL baseline, not detection', async () => {
  // g2 is permanently sick and sorts ahead of a brand-new g5, so while the
  // breaker is open the one probe slot goes to g2 and g5 is never hydrated from
  // history — normalize() settles it live instead. That is the designed loss and
  // it is cheap in a long-lived process: g5 gets an in-process baseline on the
  // spot, so movement detection resumes for it on the very next run. The
  // cross-process cold start is the only thing hydration was ever for.
  readsThisRun();
  slate = ['g1', 'g2', 'g3', 'g4', 'g5'];
  line = -4;
  const r = await mod.default.run();
  const { games } = readsThisRun();
  assert.deepEqual(games, ['g2'], `the probe slot goes to the oldest pending game: ${games}`);
  assert.ok([...mod.getBaseline().keys()].some((k) => k.startsWith('g5|')),
    'but the new game is still observed live — no baseline means no movement, not no tracking');

  line = -4.5;
  await tick();
  const next = await mod.default.run();
  assert.ok(next.data.movements >= 2,
    `g5 moves on the next run off its in-process baseline: ${next.summary}`);
  assert.equal(next.data.steamDropped, 0, 'and it is publishable — the gap is one run');
});
