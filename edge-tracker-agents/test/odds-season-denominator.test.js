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
// The clock is pinned so the month-row assertion cannot straddle a month
// boundary between the run that wrote it and the line that reads it.
const NOW = Date.parse('2026-11-05T15:00:00Z');
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
global.Date = FakeDate;
const upserts = [];
let sportsReadable = true;
let sentinelWritable = true;
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
      upsert: async (tbl, row) => {
        if (!sentinelWritable && row && row.provider === 'odds-season') {
          throw new Error('permission denied for table api_usage');
        }
        upserts.push({ tbl, row });
        return { count: 1 };
      },
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

test('every in-denominator ceiling equals its independently-computed share of the pool', async () => {
  // NOT `sum(ceilings) <= pool`. That bound is an algebraic identity of
  // nominalCap — `sum floor(B x POOL x share_i / sumAlloc)` is at most
  // `B x POOL` for ANY denominator, because sumAlloc is the sum of exactly those
  // shares — so it holds just as well for a denominator that has released the
  // whole table, and its `> 0.9 x pool` companion holds for any denominator of
  // fewer than ~1700 members. Both would have passed unchanged under the
  // collapse this file is here to rule out. So the ceilings are checked against
  // numbers computed here from the fixture instead, sport by sport.
  const p = mod.getOddsCeilings();
  assert.deepEqual(p.denom.slice().sort(), ['NBA', 'NCAAB', 'NHL', 'TENNIS'],
    'the fixture this is pinned against');
  const sum = 0.10 + 0.06 + 0.06 + 0.03;          // NBA + NCAAB + NHL + TENNIS = 0.25
  assert.equal(p.sumAlloc, sum);
  const want = { NBA: 6800, NCAAB: 4080, NHL: 4080, TENNIS: 2040 };
  for (const [s, n] of Object.entries(want)) {
    assert.equal(nominal(s, p.denom), n, `the arithmetic itself: ${s}`);
    assert.equal(p.ceilings[s], n, `${s} must be priced at ${n}, not ${p.ceilings[s]}`);
  }
  // Which, being a partition of the pool among those four, exhausts it — the
  // identity above, now anchored to a known membership rather than standing in
  // for one.
  const total = Object.values(want).reduce((a, b) => a + b, 0);
  assert.equal(total, 17000);
  assert.ok(total <= Math.floor(BUDGET * POOL), `${total} is within the ${BUDGET * POOL} pool`);
});

// ── 2b. The denominator cannot collapse ─────────────────────────
test('a one-sport denominator cannot be priced at the whole pool', async () => {
  // Gating `billed` with `&& !v.out` removed the guarantee that every sport with
  // spend stays in the denominator — which is what kept sumAlloc large and made
  // the degenerate case currentCeiling's own comment forbids unreachable. It is
  // reachable now: a thin or partially-recovered /sports board listing one
  // league would hand that league the entire month and, being active, it could
  // spend it. So sumAlloc carries a floor, and the INVARIANT is that no
  // denominator — not even a single sport — can be priced at the pool.
  const pool = Math.floor(BUDGET * POOL);
  const alone = mod.nominalCap('MLB', ['MLB']);
  assert.ok(alone < pool, `a lone MLB must not be priced at the whole ${pool} pool (got ${alone})`);
  assert.equal(alone, Math.floor(BUDGET * POOL * (ALLOC.MLB / 0.25)), 'floored at MIN_SUM_ALLOC');
  assert.equal(mod.sumAllocOf(['MLB']), 0.25, 'the floor, not MLB\'s own 0.14');
  // Every single-sport denominator, and the smallest two-sport one.
  for (const s of Object.keys(ALLOC)) {
    assert.ok(mod.nominalCap(s, [s]) <= Math.floor(pool * 0.6), `${s} alone is bounded by MAX_SPORT_POOL`);
    assert.ok(mod.nominalCap(s, [s]) < pool, `${s} alone must not be the whole pool`);
  }
  // A big share is bounded by the per-sport cap, not by the sum floor: dividing
  // 0.32 by a 0.25 floor is still the whole pool, which is why there are two.
  assert.equal(mod.nominalCap('NFL', ['NFL']), Math.floor(pool * 0.6));
  assert.ok(mod.nominalCap('BOXING', ['BOXING', 'GOLF']) < pool / 4,
    'nor may a 0.04 denominator hand a 0.02 sport half the month');
  // And the floor must not bind on a real board, or it would quietly undo the
  // feature by refusing to return a released share to the pool.
  assert.equal(mod.sumAllocOf(['NBA', 'NCAAB', 'NHL', 'SOCCER', 'UFC', 'BOXING']), 0.31,
    'deep winter after football is above the floor — the floor is a guard, not a share table');
});

test('the published season block is a copy, not a window into agent state', async () => {
  // getOddsCeilings is a READ path that used to alias `lastSeason` and then write
  // through it, permanently marking any allocation sport absent from SPORTS as
  // `in: true` while leaving it out of `denom` — a contradiction published every
  // run thereafter, to a /budget handler holding a live reference to agent state.
  const a = mod.getOddsCeilings();
  a.season.MLB.in = true;
  a.season.MLB.reason = 'tampered';
  a.season.INVENTED = { in: true, reason: 'tampered' };
  const b = mod.getOddsCeilings();
  assert.equal(b.season.MLB.in, false, 'a caller cannot reach in and change a verdict');
  assert.match(b.season.MLB.reason, /^released \(\d+d idle\)$/);
  assert.equal(b.season.INVENTED, undefined, 'nor add a sport');
  assert.notEqual(b.season, a.season);
  // Each sport also carries the sumAlloc ITS OWN ceiling was priced against: one
  // top-level number cannot describe a released sport, which is normalised
  // against `denom + itself`.
  assert.equal(b.season.NBA.pricedSum, b.sumAlloc, 'a member is priced against the denominator');
  assert.equal(b.season.MLB.pricedSum, Math.round((b.sumAlloc + ALLOC.MLB) * 1000) / 1000,
    'a released sport is priced against the denominator plus its own share');
});

test('a released sport cannot spend — its keys are season-skipped', async () => {
  // The ceiling of a released sport is generous by construction (see above), so
  // what keeps it at zero is the per-key season skip, not its cap. If that ever
  // stopped holding, the loose ceiling would become spendable.
  const spentBefore = mod.getOddsBudget().bySport.MLB || 0;
  const r = await mod.default.run();
  assert.equal(mod.getOddsBudget().bySport.MLB || 0, spentBefore,
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
  assert.equal(last.month, '2026-11');
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

// ── 6. A failing sentinel write is loud ────────────────────────
test('a persistently failing sentinel write announces itself instead of looking like day 1', async () => {
  // The signature failure of this repo, in its worst form: with no sentinel row
  // the state resets every process, every sport reseeds forever, and the ONLY
  // symptom is /budget reading `seeding (Nd left)` — which the manual check
  // recipe tells the operator to EXPECT on day 1. An RLS change on api_usage
  // would disable the feature while looking exactly like a successful deploy.
  const { getDegraded, clearDegraded } = await import('../src/store/index.js');
  clearDegraded('odds|season-state');
  sentinelWritable = false;
  await mod.default.run();
  assert.equal(getDegraded().some((d) => d.key === 'odds|season-state'), false,
    'one failed write is a transient the next run fixes — an alert that fires on those is one nobody reads');
  await mod.default.run();
  await mod.default.run();
  const d = getDegraded().find((x) => x.key === 'odds|season-state');
  assert.ok(d, 'three consecutive failures is a condition, and conditions are reported');
  assert.match(d.detail, /3 consecutive runs/);
  assert.match(d.detail, /permission denied/, 'the error itself, not a shrug');
  assert.match(d.detail, /reads as a healthy day 1/, 'and why the symptom is deceptive');

  // The month row is still written throughout — a sentinel failure may never
  // cost us the credit counter.
  assert.ok(upserts.filter((u) => u.row.provider === 'odds').length > 0);

  // And one success retracts it: an unretracted reportDegraded latches for its
  // full TTL and goes on repeating an obsolete reason (D73).
  sentinelWritable = true;
  await mod.default.run();
  assert.equal(getDegraded().some((x) => x.key === 'odds|season-state'), false,
    'the condition clears on the first run that persists again');
});

// ── 7. An empty board is a broken read, not an empty world ─────
test('a 200 carrying an empty board is treated exactly like an unreadable one', async () => {
  // `new Set()` is truthy, so an empty active set walked past the `!activeKeys`
  // fail-safe and was accepted as "nothing is in season" — the premise that
  // releases the entire table one window later. It is folded into the unknown
  // path in BOTH places it could be believed: inSeasonKeys returns null for it,
  // and seasonVerdicts refuses it too (an exported pure function cannot rely on
  // its caller). The observable difference from the old behaviour is here: an
  // empty Set season-skipped every key, so the agent went silent and called it a
  // board; `null` means unknown, and unknown fetches.
  sportsReadable = true;
  cfg.oddsApi.seasonGraceDays = 14;
  feed = [];
  const r = await mod.default.run();
  const p = mod.getOddsCeilings();
  for (const s of ['MLB', 'NFL', 'NBA']) {
    assert.equal(p.season[s].reason, 'feed-unreadable', `${s} is an unknown, and unknowns are held IN`);
    assert.equal(p.denom.includes(s), true);
  }
  // And the sweep does not silently stop: every key is still DUE (paced, since
  // earlier runs in this process already fetched them) rather than skipped as
  // out of season, which is what an empty Set handed on as a board would do.
  assert.match(r.summary, /\d+ paced/,
    'an unknown board means `null = fetch anyway`, as before this feature — not "every key is out of season"');
  assert.match(r.summary, /denom \d+\/12/);
  feed = ['NBA', 'NHL', 'NCAAB'];
});
