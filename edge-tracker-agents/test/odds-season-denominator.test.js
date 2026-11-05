// ══════════════════════════════════════════════════════════════
// The derived denominator, through the REAL run() — the wiring, not the rules.
//
// Its own file and its own process, per the odds-budget-gate.test.js precedent:
// node:test cannot re-mock a module inside one file, and this needs run() to
// publish a denominator before the ceiling path becomes reachable.
//
// Why the wiring needs its own coverage: the pure rules can be perfectly right
// while `billed` still re-adds a released sport, which is the bug this feature
// exists to fix (one MLB credit held 0.14 of the pool for a whole month, D86).
// Only run() puts the two together.
//
// A season boundary cannot be summoned live, so it is simulated: the stubbed
// /sports response is the feed, and `seasonGraceDays` is swapped between runs.
// With grace 0 the seeding run is itself a quiet day, so every sport absent
// from the feed is released immediately — a boundary on demand, no clock travel
// and no network.
//
// Mutation-verified per D21: dropping `&& !v.out` from seasonDenominator fails
// 'MLB is released'; reverting capOf to the unnormalised budget x share fails
// 'a released sport is priced as if it were in the denominator'; dropping the
// football backstop fails 'the backstop holds football in'; letting an
// unreadable feed write `last` fails 'an unreadable /sports read changes nothing'.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ALLOC = { NFL: 0.32, NCAAF: 0.16, MLB: 0.14, NBA: 0.10, NCAAB: 0.06, NHL: 0.06,
  SOCCER: 0.03, UFC: 0.04, BOXING: 0.02, WNBA: 0.02, TENNIS: 0.03, GOLF: 0.02 };
const BUDGET = 20000;
const POOL = 0.85;
const KEY = (s) => `k_${s}`;
const SPORTS = Object.fromEntries(Object.keys(ALLOC).map((s) => [s, { key: KEY(s) }]));
SPORTS.TENNIS.oddsSkip = true;
SPORTS.GOLF.oddsSkip = true;

// November's real shape: MLB has spent ONE credit this month and is otherwise
// finished for the year; TENNIS has spent, which is its only route in.
// WNBA's 900 is the capOf probe: it sits ABOVE the unnormalised `budget x share`
// (400) and BELOW the normalised ceiling it gets once the denominator shrinks,
// so WHICH formula capOf uses is visible in the run's budget-skips.
const SEEDED = { MLB: 1, NBA: 400, NHL: 300, NCAAB: 200, WNBA: 900, TENNIS: 40 };
const SEEDED_USED = Object.values(SEEDED).reduce((a, b) => a + b, 0);

// The winter board. Football is deliberately ABSENT from the feed, which is the
// September condition (D6) that used to drop its 0.48 out of the denominator.
let feed = ['NBA', 'NHL', 'NCAAB'];
const cfg = {
  oddsApi: { allocation: ALLOC, monthlyBudget: BUDGET, tier: 'starter', key: 'test-key',
    seasonGraceDays: 14, footballSports: ['NFL', 'NCAAF'], footballPriority: 'false',
    footballPriorityOn: () => false, base: 'https://api.the-odds-api.com/v4' },
  SPORTS, BOOKS: ['draftkings'], BOOK_LABELS: { draftkings: 'DK' },
  rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: true,
};
const upserts = [];
let sportsReadable = true;
let mod;

// The only input the season signal has. Stubbed at module scope, not in a hook:
// the agent reads `global.fetch` at call time and a hook assignment did not
// reach it. `/sports` is the feed; every odds call returns an empty slate,
// because this file is about the DENOMINATOR, not about games.
const realFetch = global.fetch;
global.fetch = async (url) => {
  const isSports = String(url).includes('/sports?');
  if (isSports && !sportsReadable) return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => (isSports ? feed.map((s) => ({ key: KEY(s), active: true })) : []),
  };
};

const nominal = (sport, denom) => {
  const sum = denom.reduce((t, s) => t + (ALLOC[s] ?? 0.05), 0) || 1;
  return Math.floor(BUDGET * POOL * ((ALLOC[sport] ?? 0.05) / sum));
};
const sumOver = (denom) => Math.round(denom.reduce((t, s) => t + (ALLOC[s] ?? 0.05), 0) * 1000) / 1000;

before(async () => {
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: cfg });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      isConnected: () => true,
      select: async (tbl, cols, opts) => {
        const m = (opts && opts.match) || {};
        if (tbl !== 'api_usage') return [];
        if (m.provider === 'odds') return [{ used: SEEDED_USED, by_sport: { ...SEEDED } }];
        return [];                              // no persisted season state yet
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
after(() => { global.fetch = realFetch; mock.reset(); });

// ── 1. Grace, with the football backstop OFF ────────────────────
// The verifier's first question: with FOOTBALL_PRIORITY=false and /sports NOT
// listing NFL, is NFL still in the denominator? It must be — on grace alone.
// Entry is immediate but release takes a full window, and that asymmetry is the
// only thing standing between a slate-derived denominator and D6.
test('a sport absent from the feed is held in by grace alone, with no football backstop', async () => {
  const r = await mod.default.run();
  const p = mod.getOddsCeilings();
  assert.equal(p.denom.includes('NFL'), true, 'NFL must not leave the denominator on one quiet day');
  assert.equal(p.season.NFL.reason, 'seeding (14d left)');
  assert.equal(p.season.NBA.reason, 'active-now');
  assert.equal(p.denom.includes('MLB'), true, 'MLB has not been quiet long enough to be released');
  assert.equal(p.season.TENNIS.reason, 'billed (event-only sport)');
  assert.equal(p.denom.includes('GOLF'), false, 'an oddsSkip sport with no spend stays out, as today');
  assert.equal(p.graceDays, 14);
  assert.equal(p.sumAlloc, sumOver(p.denom), 'the published sum must be the sum over the published denominator');
  // Positive control for the capOf probe below: with all twelve shares still
  // priced in, WNBA's normalised ceiling is 347, so its 900 is spent out and the
  // run reports a budget-skip. (The PUBLISHED ceiling reads 900, not 347: a
  // ceiling never falls below what the sport has already spent, so an arrival
  // mid-month stops granting headroom rather than stranding anyone.)
  assert.equal(p.ceilings.WNBA, SEEDED.WNBA, 'the published ceiling is floored at spend');
  assert.match(r.summary, /budget-skips/, 'WNBA is spent out while all twelve shares are priced in');
});

// ── 2. The release ──────────────────────────────────────────────
test('MLB is released despite having spent, and its share returns to the pool', async () => {
  const before = mod.getOddsCeilings();
  cfg.oddsApi.seasonGraceDays = 0;              // the boundary, summoned
  await mod.default.run();
  const p = mod.getOddsCeilings();

  assert.equal(p.denom.includes('MLB'), false,
    'one credit must not hold 0.14 of the pool through an offseason — this is the whole fix');
  assert.match(p.season.MLB.reason, /^released \(\d+d idle\)$/);
  assert.equal(p.denom.includes('NFL'), false, 'with grace 0 and the backstop off, football leaves too');
  assert.deepEqual(p.denom.slice().sort(), ['NBA', 'NCAAB', 'NHL', 'TENNIS'],
    'only the active sports and the billed event-only sport remain');
  assert.ok(p.sumAlloc < before.sumAlloc, `sumAlloc must fall: ${before.sumAlloc} -> ${p.sumAlloc}`);

  // The point of the release: the sports actually playing get the share back.
  for (const s of ['NBA', 'NHL', 'NCAAB']) {
    assert.ok(p.ceilings[s] > before.ceilings[s],
      `${s} ceiling must rise when a dead share is returned (${before.ceilings[s]} -> ${p.ceilings[s]})`);
  }
});

test('the ceilings of the sports in the denominator still sum within the pool', async () => {
  // Nothing may overspend the pool in EITHER membership state (D85). The bound
  // is over the DENOMINATOR, which is what nominalCap normalises and what can
  // actually spend: a RELEASED sport is priced against `denom + itself`, so with
  // a small denominator its individual number is generous, and the sum over all
  // twelve exceeds the pool for that reason alone. It cannot be spent — a
  // released sport is absent from /sports and so every one of its keys is
  // season-skipped in the loop below, which the next assertion pins.
  const p = mod.getOddsCeilings();
  const total = p.denom.reduce((t, s) => t + p.ceilings[s], 0);
  assert.ok(total <= Math.floor(BUDGET * POOL),
    `the denominator's ceilings sum to ${total}, over the ${BUDGET * POOL} pool`);
  assert.ok(total > Math.floor(BUDGET * POOL) * 0.9,
    `and not vacuously small: ${total} of a ${Math.floor(BUDGET * POOL)} pool`);
});

test('a released sport cannot spend — its keys are season-skipped', async () => {
  // The ceiling of a released sport is generous by construction (see above), so
  // what keeps it at zero is the per-key season skip, not its cap. If that ever
  // stopped holding, the loose ceiling would become spendable.
  const before = mod.getOddsBudget().bySport.MLB || 0;
  const r = await mod.default.run();
  assert.equal(mod.getOddsBudget().bySport.MLB || 0, before,
    'MLB is absent from /sports and must not be fetched at all');
  assert.match(r.summary, /denom \d+\/12/);
});

test('the loop prices a released sport against the live denominator, not the raw share', async () => {
  // capOf's out-of-denominator branch used to be the unnormalised `budget x
  // share` — a path that was nearly unreachable before this change and is now
  // where every released sport lands. It is observable in exactly one place:
  // the sport-level cap check runs BEFORE the per-key season skip, so the
  // formula decides whether a released sport is reported as a budget-skip.
  //
  // WNBA has spent 900. Normalised against `denom + WNBA` that is inside its
  // ceiling; against the raw share (400) it is over it.
  const r = await mod.default.run();
  const p = mod.getOddsCeilings();
  assert.equal(p.denom.includes('WNBA'), false, 'WNBA is released in this state');
  assert.ok(p.ceilings.WNBA > SEEDED.WNBA,
    `a released sport is normalised against denom + itself (${p.ceilings.WNBA} vs a raw share of ${Math.floor(BUDGET * ALLOC.WNBA)})`);
  assert.doesNotMatch(r.summary, /budget-skips/,
    'nothing is over its ceiling once the dead shares are out — the raw-share fallback would report WNBA as one');
});

test('a released sport is priced as if it were in the denominator, never on the raw share', async () => {
  // capOf used to fall back to the unnormalised `budget x share` for anything
  // outside the denominator — a path that was nearly unreachable before this
  // change and is now where every released sport lands. Same shape as D65's
  // branch 2: the denominator plus this sport.
  const p = mod.getOddsCeilings();
  const want = nominal('MLB', [...p.denom, 'MLB']);
  const raw = Math.floor(BUDGET * ALLOC.MLB);
  assert.notEqual(want, raw, 'the fixture only means something if the two formulas differ');
  assert.equal(mod.currentCeiling('MLB'), want, 'a released sport is normalised against denom + itself');
  assert.ok(mod.currentCeiling('MLB') >= 1, 'and never below what it has already spent');
});

// ── 3. The backstop ────────────────────────────────────────────
test('the backstop holds football in when its grace has expired', async () => {
  // D6 generalised, not dropped: grace covers every sport now, and the football
  // month range survives as a labelled backstop. If /sports ever reports
  // football inactive for a whole window, this is the only thing left.
  cfg.oddsApi.footballPriorityOn = () => true;
  await mod.default.run();
  const p = mod.getOddsCeilings();
  assert.equal(p.season.NFL.reason, 'football-backstop');
  assert.equal(p.season.NCAAF.reason, 'football-backstop');
  assert.equal(p.denom.includes('NFL'), true);
  assert.equal(p.denom.includes('MLB'), false, 'the backstop covers football only — MLB stays released');
  cfg.oddsApi.footballPriorityOn = () => false;
});

// ── 4. Persistence ─────────────────────────────────────────────
test('the season state lands in its own sentinel row and never clobbers the month row', async () => {
  const month = upserts.filter((u) => u.tbl === 'api_usage' && u.row.provider === 'odds');
  const sentinel = upserts.filter((u) => u.tbl === 'api_usage' && u.row.provider === 'odds-season');
  assert.ok(month.length > 0 && sentinel.length > 0, 'both rows are written every run');
  assert.equal(sentinel.at(-1).row.month, 'state',
    'month-independent: a month rollover must not reset a season clock');
  const last = month.at(-1).row;
  assert.equal(last.month, new Date().toISOString().slice(0, 7));
  assert.equal(last.by_sport.NBA >= SEEDED.NBA, true, 'the credit counter is untouched by the sentinel write');
  assert.equal(last.by_sport.first, undefined, 'season state must not leak into the month row');
  const state = sentinel.at(-1).row.by_sport;
  assert.equal(typeof state.MLB.first, 'string');
  assert.equal(state.MLB.in, false, 'the published membership is persisted so a change logs once, not every run');
  assert.equal(state.TENNIS, undefined, 'oddsSkip sports accumulate no season state');
});

// ── 5. Fail safe ───────────────────────────────────────────────
test('an unreadable /sports read changes nothing and holds everything in', async () => {
  // Refreshing `last` here would silently extend a dead sport's season by
  // another full window, forever, on a flaky network. So the run writes no
  // stamp — and reports every non-skip sport in, which is the tight direction.
  const stateBefore = JSON.stringify(upserts.filter((u) => u.row.provider === 'odds-season').at(-1).row.by_sport);
  sportsReadable = false;
  await mod.default.run();
  const p = mod.getOddsCeilings();
  assert.equal(p.denom.includes('MLB'), true, 'unknown resolves to IN — stranding beats inflating');
  assert.equal(p.season.MLB.reason, 'feed-unreadable');
  assert.equal(p.season.NFL.reason, 'feed-unreadable');
  const stateAfter = JSON.stringify(upserts.filter((u) => u.row.provider === 'odds-season').at(-1).row.by_sport);
  assert.equal(stateAfter, stateBefore, 'no season stamp may move on an unreadable feed');
  sportsReadable = true;
});

test('the run summary names the denominator and what was released', async () => {
  // The D88 gap: the live denominator was unknowable from anywhere but a model
  // of it, which is why November's analysis had to be inferred rather than read.
  sportsReadable = true;
  cfg.oddsApi.seasonGraceDays = 0;
  const r = await mod.default.run();
  assert.match(r.summary, /denom \d+\/12 \(/);
  assert.match(r.summary, /released .*MLB/);
});
