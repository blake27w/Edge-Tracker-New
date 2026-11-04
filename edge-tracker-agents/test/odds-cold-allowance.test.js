// ══════════════════════════════════════════════════════════════
// The once-per-process cold allowance must be spent on a run that actually
// HYDRATED something.
//
// The rule the spec states: "a run where every attempted game failed does not
// set `hydratedOnce`, so the once-per-process cold allowance is not burnt on a
// run that hydrated nothing". A run that fetched an EMPTY slate hydrated
// nothing either, and it is the ordinary case — a league key between slates, a
// redeploy in a dead hour — so it must not consume the allowance before the
// real slate shows up on the next run. The code already guards the sibling case
// (`if (calls)`, so a wholly paced-skipped run does not burn it).
//
// Caps here: cold 4, steady 2 — two distinguishable numbers, so which one
// governed a run reads straight off `hydrateAttempted`.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

let slate = [];     // run 1 fetches a real key and gets no games back

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
const tick = () => new Promise((r) => setTimeout(r, 5));

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

test('a run that fetched an empty slate hydrates nothing and must not spend the allowance', async () => {
  const r = await mod.default.run();
  assert.equal(r.data.calls, 1, `the key WAS fetched — this is not the paced-skip case: ${r.summary}`);
  assert.equal(r.data.hydrateAttempted, 0, 'there was nothing to hydrate');
  assert.equal(r.data.rehydratedGames, 0);
  assert.equal(r.data.hydrateFailRuns, 0, 'nothing failed either — an empty slate is not an outage');
  await tick();
});

test('so the real slate on the next run still gets the cold cap, not the steady one', async () => {
  slate = ['g1', 'g2', 'g3', 'g4'];
  fdb.setRows('line_snapshots', slate.map((g) => (
    { game_id: g, book: 'draftkings', market: 'spreads', side: 'Home', line: -2.5, price: -110, fetched_at: iso(now - 5 * MIN) }
  )));

  const r = await mod.default.run();
  assert.equal(r.data.hydrateAttempted, 4,
    `the first slate this process ever saw is a cold start: ${r.summary}`);
  assert.equal(r.data.rehydratedGames, 4, r.summary);
  assert.equal(r.data.movements, 4, 'and every one of them detects movement on its first fetch');
  await tick();
});

test('once something has actually hydrated, the allowance is spent for good', async () => {
  slate = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
  const r = await mod.default.run();
  assert.equal(r.data.hydrateAttempted, 2,
    `steady cap from here on — the cold burst is once per process: ${r.summary}`);
});

test('and the same rule cannot wedge the breaker: an idle run holds it, a healthy read clears it', async () => {
  // The other half of gating on `hydr.games > 0`: a run with nothing to hydrate
  // no longer RETRACTS the breaker either, which is correct — a breaker should
  // be cleared by evidence of recovery, not by absence of work. The thing to
  // prove is that it is still clearable.
  // The previous test did not tick, and the per-key dedup is
  // `Date.now() - lastFetch < ivMs` with ivMs a fraction of a millisecond — so
  // without this the first run below paced-skips, `calls` is 0, and the streak
  // block never runs at all.
  await tick();
  fdb.fail['select:line_snapshots'] = Object.assign(
    new Error('canceling statement due to statement timeout'), { code: '57014' });
  slate = ['n1', 'n2', 'n3', 'n4'];               // four games this process has never settled
  let r;
  for (let i = 0; i < 3; i++) { r = await mod.default.run(); await tick(); }
  assert.ok(r.data.hydrateFailRuns >= 3, `breaker tripped: ${r.summary}`);
  assert.match(r.summary, /circuit-broken/);

  // Two runs with nothing on the slate. The breaker must survive them.
  slate = [];
  for (let i = 0; i < 2; i++) { r = await mod.default.run(); await tick(); }
  assert.equal(r.data.hydrateAttempted, 0, r.summary);
  assert.ok(r.data.hydrateFailRuns >= 3,
    `an idle run is not a recovery: ${r.summary}`);

  // The table answers again. One probe is all it takes.
  delete fdb.fail['select:line_snapshots'];
  slate = ['n1', 'n2', 'n3', 'n4'];
  const probe = await mod.default.run();
  assert.equal(probe.data.hydrateAttempted, 1, `still a probe: ${probe.summary}`);
  assert.equal(probe.data.rehydratedGames, 1, probe.summary);
  assert.equal(probe.data.hydrateFailRuns, 0, 'one successful read clears it');
  await tick();

  const back = await mod.default.run();
  assert.ok(back.data.hydrateAttempted >= 1 && back.data.hydrateAttempted <= 2,
    `steady cap governs again — never the cold cap after an outage: ${back.summary}`);
  assert.equal(back.data.hydrateFailRuns, 0, back.summary);
  assert.doesNotMatch(back.summary, /circuit-broken/);
});
