// ══════════════════════════════════════════════════════════════
// The movement baseline across SEVERAL runs of one process — the two
// behaviours that a single run cannot show, and that a passing suite otherwise
// does not notice:
//
//   1. A hydration read that FAILS must leave the game unsettled and must not
//      burn the once-per-process cold allowance. line_snapshots is the table
//      that statement-timeouts (D68); if a cold-run failure counted as "done",
//      every later run would find every game already settled and hydrate
//      nothing, forever — a long-lived process would behave exactly as it did
//      before this fix, silently.
//   2. Past the staleness bound the entry must be RESEEDED. Suppressing the
//      write without reseeding leaves the key comparing against an
//      ever-older baseline for the rest of the process's life, which is the
//      opposite of what the bound is for.
//
// Pacing is effectively disabled here so run() refetches every time. Note the
// env cannot be set to 0: the agent reads these with `Number(x) || 4`, so '0'
// reads as the default — the smallest positive value is the way through.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const KEY = 'g1|draftkings|spreads|Home';

// The feed's current home spread. Runs mutate it between calls.
let LINE = -3;

const ev = (id, kickoff) => ({
  id, home_team: 'Home', away_team: 'Away', commence_time: iso(kickoff),
  bookmakers: [{
    key: 'draftkings', last_update: iso(Date.now()),
    markets: [{
      key: 'spreads', last_update: iso(Date.now()),
      outcomes: [{ name: 'Home', point: LINE, price: -110 }, { name: 'Away', point: -LINE, price: -110 }],
    }],
  }],
});

let mod;
let fdb;

// The per-key fetch dedup is `Date.now() - lastFetch < ivMs`, and ivMs here is
// a fraction of a millisecond — so two runs inside the same millisecond make
// the second one paced-skip. One tick between runs, and only that.
const tick = () => new Promise((r) => setTimeout(r, 5));

before(async () => {
  // Two games offered, cold cap 2, steady cap 1 — so "did the cold allowance
  // survive the failed run?" is directly observable as attempted 2 vs 1.
  process.env.ODDS_HYDRATE_COLD_MAX = '2';
  process.env.ODDS_HYDRATE_MAX_GAMES = '1';
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
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: fl.logger, notifyAll: async () => ({ total: 0 }) },
  });

  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?')
      ? [{ key: 'k_A', active: true }]
      : [ev('g1', now + 20 * MIN), ev('g2', now + 25 * MIN)]),
  });

  mod = await import('../src/agents/odds/index.js');
});
after(() => mock.reset());

test('a failed hydration read is not "done" — it is retried, with the cold allowance intact', async () => {
  fdb.fail['select:line_snapshots'] = Object.assign(
    new Error('canceling statement due to statement timeout'), { code: '57014' });

  const r1 = await mod.default.run();
  assert.equal(r1.data.hydrateAttempted, 2, r1.summary);
  assert.equal(r1.data.rehydratedGames, 0, 'nothing was hydrated — every read failed');
  assert.equal(r1.data.hydrateFailures, 4, '2 games x 2 markets');
  assert.match(r1.summary, /read failures/,
    'a run that hydrated nothing because the DB failed must not read like a run with nothing to do');

  // Now the DB answers. Both games must be re-read — a failure that settled the
  // game would mean 0 attempted here and no rehydration ever again this process.
  delete fdb.fail['select:line_snapshots'];
  fdb.setRows('line_snapshots', [
    { game_id: 'g1', book: 'draftkings', market: 'spreads', side: 'Home', line: LINE, price: -110, fetched_at: iso(now - 5 * MIN) },
  ]);
  await tick();
  const r2 = await mod.default.run();
  assert.equal(r2.data.hydrateAttempted, 2,
    'attempted 2 proves BOTH that the games were not latched done and that the cold cap (2) still applied — the steady cap is 1');
  assert.equal(r2.data.rehydratedGames, 2, r2.summary);
  assert.equal(r2.data.hydrateFailures, 0);
  // Keys filled is 0 here and that is correct: run 1 observed every key live,
  // and hydration only ever fills ABSENT keys.
  assert.equal(r2.data.rehydratedKeys, 0);
});

test('past the bound the baseline is reseeded, not left to age forever', async () => {
  const b = mod.getBaseline();
  assert.equal(b.get(KEY).line, -3, 'precondition: the in-process baseline is the line run 1 saw');

  // Age ONE key past the 360-minute bound; the other three stay fresh, so a
  // stale verdict and a real movement are distinguishable in the same run.
  b.get(KEY).at = now - 400 * MIN;
  LINE = -4;

  await tick();
  const r3 = await mod.default.run();
  assert.equal(r3.data.staleBaseline, 1, r3.summary);
  assert.equal(r3.data.movements, 3, 'the three fresh keys moved; the stale one was suppressed');

  // THE point: the suppressed key is reseeded to what we just saw. Without this
  // it would compare against the same 400-minute-old entry next run, and the
  // one after, and never emit again.
  assert.equal(b.get(KEY).line, -4, 'a suppressed key must still take the current observation as its new baseline');
  assert.ok(b.get(KEY).at >= now, 'and a current stamp — otherwise it is stale again next run, forever');
  assert.equal(b.get(KEY).source, 'in-process');

  // Proved by behaviour one run later: the key emits a movement measured from
  // the reseeded line, not a second stale verdict measured from the old one.
  LINE = -4.5;
  await tick();
  const r4 = await mod.default.run();
  assert.equal(r4.data.staleBaseline, 0, r4.summary);
  assert.equal(r4.data.movements, 4, 'all four keys, including the one suppressed last run');
  const rows = fdb.calls.insert.filter((c) => c.table === 'line_movements').at(-1).rows;
  const row = rows.find((x) => x.game_id === 'g1' && x.side === 'Home');
  assert.equal(row.line_open, -4, 'measured from the reseeded baseline, not the 400-minute-old one');
  assert.equal(row.line_current, -4.5);
  assert.ok(row.gap_min < 5, `the gap is the reseed-to-now gap, got ${row.gap_min}`);
});
