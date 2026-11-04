// ══════════════════════════════════════════════════════════════
// Eviction, on the games the OTHER guards keep alive.
//
// `baselineFailed` exists so a game whose read failed is retried forever rather
// than silently settled. "Forever" has to end somewhere, or the three
// module-level collections (lastLines, baselineDone, baselineFailed) grow for
// the life of the process — ~66 keys per game, ~150 new games a day. The
// eviction block uses the same kickoff + 6h cutoff as the slate retention
// above it, so this drives a game past that cutoff while its reads are failing
// and checks it actually leaves.
//
// The existing baseline test proves eviction clears a synthetic key. What is
// untested is eviction of a game that is simultaneously (a) long finished and
// (b) held open by a failed read.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// gLive kicks off in 30 minutes; gStale kicked off 7 hours ago, i.e. past the
// retention cutoff the eviction block reuses.
const KICK = { gLive: now + 30 * MIN, gStale: now - 7 * 3600_000 };
let slate = ['gLive', 'gStale'];

const ev = (id) => ({
  id, home_team: 'Home', away_team: 'Away', commence_time: iso(KICK[id]),
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
const keysFor = (g) => [...mod.getBaseline().keys()].filter((k) => k.startsWith(`${g}|`));

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
  fdb.fail['select:line_snapshots'] = Object.assign(
    new Error('canceling statement due to statement timeout'), { code: '57014' });
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

test('a long-finished game whose read failed still gets observed and still holds keys', async () => {
  const r = await mod.default.run();
  assert.equal(r.data.hydrateAttempted, 2, r.summary);
  assert.equal(r.data.rehydratedGames, 0, 'every read timed out');
  assert.equal(keysFor('gStale').length, 2, 'normalize() observed it live: Home and Away');
  assert.equal(keysFor('gLive').length, 2);
  await tick();
});

test('once it is off the slate and past kickoff + 6h, every collection lets go of it', async () => {
  slate = ['gLive'];
  const r = await mod.default.run();

  assert.deepEqual(keysFor('gStale'), [],
    'the Map is pruned on the same cutoff the retention block just applied');
  assert.equal(keysFor('gLive').length, 2, 'and the live game is untouched');
  // baselineDone/baselineFailed ride the same block; their effect is that the
  // breaker's pending set shrinks to the games still in play, which is what
  // keeps a dead game from claiming a probe slot forever.
  assert.equal(r.data.hydrateAttempted, 1, `only the live game is pending: ${r.summary}`);
  await tick();
});

test('a still-upcoming game is NOT evicted just because it fell off one fetch', async () => {
  // The retention block keeps previously-known games whose key was paced-skipped,
  // so a game that merely missed a response must keep its baseline — evicting it
  // would reintroduce the bug this feature exists to fix, one fetch at a time.
  slate = [];
  await mod.default.run();
  assert.equal(keysFor('gLive').length, 2,
    'kickoff is 30 minutes out — it is still in play and its baseline must survive');
});
