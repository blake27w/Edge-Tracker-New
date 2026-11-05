// ══════════════════════════════════════════════════════════════
// The exhausted month keeps watching.
//
// Its own file and its own process: this needs `api_usage` to come back with the
// month already spent, and node:test cannot re-mock a module inside one file.
//
// Why it is worth a file. Demand was measured at ~2.3x the allocatable pool
// (D87), so a 20000 month exhausts around day 13 and `budget.remaining <= 0` is
// the path the agent spends the REST of the month on — ~17 days of it. The
// season observation used to sit below that early return, so for those 17 days
// nothing watched; and on the `free` tier (500 credits) the gate closes within
// hours of day 1, which would have meant the feature never ran at all.
//
// /sports is free and unbilled, so there is nothing to save by not looking. The
// observation runs first, and it is PERSISTED on this path too — an observation
// that does not survive the restart was never made.
//
// Mutation-verified per D21: moving the season block back below the gate, or
// dropping the `await persistBudget()` from it, fails every test here.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ALLOC = { NFL: 0.32, NCAAF: 0.16, MLB: 0.14, NBA: 0.10, NCAAB: 0.06, NHL: 0.06,
  SOCCER: 0.03, UFC: 0.04, BOXING: 0.02, WNBA: 0.02, TENNIS: 0.03, GOLF: 0.02 };
const BUDGET = 20000;
const KEY = (s) => `k_${s}`;
const SPORTS = Object.fromEntries(Object.keys(ALLOC).map((s) => [s, { key: KEY(s) }]));
SPORTS.TENNIS.oddsSkip = true;
SPORTS.GOLF.oddsSkip = true;

// The clock is PINNED, not read: `today` here and `new Date()` inside the agent
// must agree, and a test that imports at 23:59:59 and runs at 00:00:00 UTC
// would otherwise count one quiet day more than its fixture says.
const NOW = Date.parse('2026-11-05T15:00:00Z');
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
global.Date = FakeDate;
const today = new RealDate(NOW).toISOString().slice(0, 10);
const daysAgo = (n) => new RealDate(NOW - n * 86_400_000).toISOString().slice(0, 10);
// The state a mid-month exhaustion leaves behind: MLB already 10 observed quiet
// days in, NBA seen active yesterday.
const STATE = {
  MLB: { first: daysAgo(200), last: daysAgo(10), in: true, quiet: 10, obs: daysAgo(1) },
  NBA: { first: daysAgo(200), last: daysAgo(1), in: true, quiet: 0, obs: daysAgo(1) },
};
const upserts = [];
let sportsCalls = 0;
let oddsCalls = 0;

const cfg = {
  oddsApi: { allocation: ALLOC, monthlyBudget: BUDGET, tier: 'starter', key: 'test-key',
    seasonGraceDays: 14, footballSports: ['NFL', 'NCAAF'], footballPriority: 'false',
    footballPriorityOn: () => false, base: 'https://api.the-odds-api.com/v4' },
  SPORTS, BOOKS: ['draftkings'], BOOK_LABELS: { draftkings: 'DK' },
  rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: true,
};

const realFetch = global.fetch;
global.fetch = async (url) => {
  const isSports = String(url).includes('/sports?');
  if (isSports) sportsCalls++; else oddsCalls++;
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => (isSports ? [{ key: KEY('NBA'), active: true }, { key: KEY('NHL'), active: true }] : []),
  };
};

let mod;
before(async () => {
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: cfg });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      isConnected: () => true,
      select: async (tbl, cols, opts) => {
        const m = (opts && opts.match) || {};
        if (tbl !== 'api_usage') return [];
        if (m.provider === 'odds') return [{ used: BUDGET, by_sport: { MLB: 1, NBA: 9000 } }];
        if (m.provider === 'odds-season') return [{ by_sport: JSON.parse(JSON.stringify(STATE)) }];
        return [];
      },
      upsert: async (tbl, row) => { upserts.push({ tbl, row }); return { count: 1 }; },
      insert: async () => ({ count: 1 }),
    },
    namedExports: { isMissingRelation: () => false },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: { info() {}, warn() {}, error() {} }, notifyAll: async () => ({ total: 0 }) },
  });
  mod = await import('../src/agents/odds/index.js');
});
after(() => { global.Date = RealDate; global.fetch = realFetch; mock.reset(); });

test('an exhausted month still observes the season, and says so', async () => {
  const r = await mod.default.run();
  assert.match(r.summary, /budget exhausted/, 'the month really is spent — this is the path, not an accident');
  assert.equal(oddsCalls, 0, 'and nothing billable was fetched');
  assert.equal(sportsCalls, 1, 'but the free /sports read still happened');
  assert.match(r.summary, /denom \d+\/12 \(/, 'the exhausted summary names the denominator too');

  const p = mod.getOddsCeilings();
  assert.equal(p.season.NBA.reason, 'active-now', 'presence was recorded while the month was spent');
  assert.equal(p.season.MLB.reason, 'grace (10d ago)');
  assert.equal(p.denom.includes('NBA'), true);
});

test('the observation survives the restart — it is persisted on this path too', async () => {
  // An observation that is not written is not an observation: the process
  // restarts (Railway redeploys, OOMs, month rollovers) and the release clock
  // would reset to whatever the last SPENDING run happened to write, ~17 days
  // earlier. That is the calendar-vs-observed confusion coming back through the
  // persistence layer.
  const sentinel = upserts.filter((u) => u.tbl === 'api_usage' && u.row.provider === 'odds-season');
  assert.ok(sentinel.length > 0, 'the sentinel row is written even when nothing was fetched');
  const state = sentinel.at(-1).row.by_sport;
  assert.equal(state.MLB.quiet, 11, "today's quiet observation counted");
  assert.equal(state.MLB.obs, today);
  assert.equal(state.NBA.quiet, 0, 'and presence zeroed NBA’s clock');
  assert.equal(state.NBA.last, today);
});

test('a release can happen while the month is exhausted', async () => {
  // The consequence of watching: the denominator the NEXT month is priced
  // against is derived from observations made during the starved one, instead of
  // from a 17-day gap that reads as every sport being dead at once.
  cfg.oddsApi.seasonGraceDays = 10;
  const r = await mod.default.run();
  const p = mod.getOddsCeilings();
  assert.equal(p.denom.includes('MLB'), false, '12 observed quiet days past a 10-day grace');
  assert.match(p.season.MLB.reason, /^released \(\d+d idle\)$/);
  assert.match(r.summary, /released .*MLB/);
  assert.equal(oddsCalls, 0, 'still without spending a credit');
});
