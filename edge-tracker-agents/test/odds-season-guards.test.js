// ══════════════════════════════════════════════════════════════
// The three guards together, and the feeds that try to make them flap.
//
// The observation counter (quiet/obs), the denominator bounds (MIN_SUM_ALLOC /
// MAX_SPORT_POOL) and the empty-board fail-safe each landed in a separate pass.
// Each is tested on its own elsewhere; this file drives SEQUENCES through the
// real run() — a partial board for eight days then a full one, an empty board
// across a month rollover, a sport that shows up for one day mid-window, a
// corrupted sentinel row met by a fresh process, a presence flag that alternates
// day by day, a feed that alternates readable/unreadable run by run, and twenty
// runs a day for fifteen days — and asks the one question that matters for all
// of them: does the denominator return to, and stay at, the correct steady
// state, and does any sport move more often than its season does?
//
// Each scenario gets a fresh module instance (a cache-busted import — the same
// trick as a process restart) over a fresh fake api_usage table, so no scenario
// inherits another's clock or state. The wall clock is replaced before the
// first import, as in odds-season-simulation.test.js.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ALLOC = { NFL: 0.32, NCAAF: 0.16, MLB: 0.14, NBA: 0.10, NCAAB: 0.06, NHL: 0.06,
  SOCCER: 0.03, UFC: 0.04, BOXING: 0.02, WNBA: 0.02, TENNIS: 0.03, GOLF: 0.02 };
const BUDGET = 20000;
const KEY = (s) => `k_${s}`;
const SPORTS = Object.fromEntries(Object.keys(ALLOC).map((s) => [s, { key: KEY(s) }]));
SPORTS.SOCCER.leagues = ['soccer_a', 'soccer_b'];
SPORTS.TENNIS.oddsSkip = true;
SPORTS.GOLF.oddsSkip = true;
const NON_SKIP = Object.keys(SPORTS).filter((s) => !SPORTS[s].oddsSkip);
const keysOf = (s) => SPORTS[s].leagues || [SPORTS[s].key];
const boardOf = (...sports) => sports.flatMap((s) => (SPORTS[s] ? keysOf(s) : [s]));

// ── Clock ──────────────────────────────────────────────────────
const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T15:00:00Z');
const RealDate = Date;
let simNow = T0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(simNow); }
  static now() { return simNow; }
}
const ymd = (ms) => new RealDate(ms).toISOString().slice(0, 10);
const day = (d) => ymd(T0 + d * DAY);

// ── Fake api_usage, reset per scenario ─────────────────────────
let table = new Map();
const rowKey = (r) => `${r.provider}|${r.month}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
let writes = [];
const db = {
  isConnected: () => true,
  select: async (tbl, cols, opts) => {
    if (tbl !== 'api_usage') return [];
    const r = table.get(rowKey((opts && opts.match) || {}));
    return r ? [clone(r)] : [];
  },
  upsert: async (tbl, row) => {
    if (tbl !== 'api_usage') return { count: 1 };
    writes.push(clone(row));
    table.set(rowKey(row), clone(row));
    return { count: 1 };
  },
  insert: async () => ({ count: 1 }),
};

// ── Feed ───────────────────────────────────────────────────────
let board = null;            // array of keys; null = unreadable (503); [] = empty 200
let oddsCalls = [];
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/sports?')) {
    if (board === null) return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => board.map((k) => ({ key: k, active: true })) };
  }
  oddsCalls.push(u.match(/\/sports\/([^/]+)\/odds/)[1]);
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
};

const cfg = {
  oddsApi: { allocation: ALLOC, monthlyBudget: BUDGET, tier: 'starter', key: 'test-key',
    seasonGraceDays: 14, footballSports: ['NFL', 'NCAAF'], footballPriority: 'false',
    footballPriorityOn: () => false, base: 'https://api.the-odds-api.com/v4' },
  SPORTS, BOOKS: ['draftkings'], BOOK_LABELS: { draftkings: 'DK' },
  rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: true,
};
let logs = [];
let n = 0;

before(() => {
  global.Date = FakeDate;
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: cfg });
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isMissingRelation: () => false } });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: { info: (a, m) => logs.push(m), warn: (a, m) => logs.push(m), error() {} }, notifyAll: async () => ({ total: 0 }) },
  });
});
after(() => { global.Date = RealDate; global.fetch = realFetch; mock.reset(); });

// A scenario: fresh process, fresh table (optionally pre-seeded), its own grace.
async function scenario({ grace = 14, state = null, monthRow = null, footballOn = false } = {}) {
  table = new Map(); writes = []; logs = []; oddsCalls = [];
  cfg.oddsApi.seasonGraceDays = grace;
  cfg.oddsApi.footballPriorityOn = () => footballOn;
  if (state) table.set('odds-season|state', { provider: 'odds-season', month: 'state', used: 0, budget: 0, by_sport: clone(state) });
  if (monthRow) table.set(`odds|${monthRow.month}`, { provider: 'odds', ...clone(monthRow) });
  simNow = T0;
  const mod = await import(`../src/agents/odds/index.js?scenario=${++n}`);
  const step = async (d, keys, hour = 15) => {
    simNow = T0 + d * DAY + (hour - 15) * HOUR;
    board = keys;
    const r = await mod.default.run();
    const p = mod.getOddsCeilings();
    return { day: d, date: ymd(simNow), summary: r.summary, denom: p.denom.slice().sort(), season: clone(p.season),
      sumAlloc: p.sumAlloc, ceilings: clone(p.ceilings), bySport: clone(mod.getOddsBudget().bySport),
      sentinel: clone(table.get('odds-season|state')?.by_sport || null) };
  };
  return { mod, step };
}
const flipsOf = (snaps) => {
  const f = {};
  for (let i = 1; i < snaps.length; i++) {
    for (const s of Object.keys(SPORTS)) {
      if (snaps[i - 1].denom.includes(s) !== snaps[i].denom.includes(s)) f[s] = (f[s] || 0) + 1;
    }
  }
  return f;
};
const transitions = () => logs.filter((m) => /^season: /.test(m));
// Every sport we scripted as active, plus nothing else, is in — the steady state
// this file keeps asking for. Spend-only entries (TENNIS/GOLF) are not scripted
// here, so the denominator is exactly the in-season set.
const steady = (snap, ...sports) => assert.deepEqual(snap.denom, sports.slice().sort(), `day ${snap.day}: ${snap.denom}`);

// ── 1. A partial board for eight days, then full ───────────────
test('grace 14: a board missing NBA and NHL for 8 days never moves the denominator; the full board restores quiet 0', async () => {
  const { step } = await scenario({ grace: 14 });
  const snaps = [await step(0, boardOf('MLB', 'NBA', 'NHL', 'SOCCER'))];
  for (let d = 1; d <= 8; d++) snaps.push(await step(d, boardOf('MLB', 'SOCCER')));
  for (let d = 9; d <= 30; d++) snaps.push(await step(d, boardOf('MLB', 'NBA', 'NHL', 'SOCCER')));
  assert.equal(snaps[8].season.NBA.reason, 'grace (8d ago)');
  assert.equal(snaps[8].sentinel.NBA.quiet, 8);
  assert.equal(snaps[9].season.NBA.reason, 'active-now');
  assert.equal(snaps[9].sentinel.NBA.quiet, 0, 'one active observation zeroes the counter, not just the date');
  for (const s of snaps) for (const x of ['MLB', 'NBA', 'NHL', 'SOCCER']) assert.ok(s.denom.includes(x), `day ${s.day}: ${x} out`);
  // The sports never on this board leave at day 14 — once — and the rest never move.
  assert.deepEqual(flipsOf(snaps), { NFL: 1, NCAAF: 1, NCAAB: 1, WNBA: 1, UFC: 1, BOXING: 1 });
  steady(snaps.at(-1), 'MLB', 'NBA', 'NHL', 'SOCCER');
  assert.equal(transitions().length, 6, 'one log line per real release, none for the partial board');
});

test('grace 7 (the production floor): the same 8-day gap releases NBA for exactly one day, then steady', async () => {
  const { step } = await scenario({ grace: 7 });
  const snaps = [await step(0, boardOf('MLB', 'NBA', 'NHL', 'SOCCER'))];
  for (let d = 1; d <= 8; d++) snaps.push(await step(d, boardOf('MLB', 'SOCCER')));
  for (let d = 9; d <= 30; d++) snaps.push(await step(d, boardOf('MLB', 'NBA', 'NHL', 'SOCCER')));
  assert.equal(snaps[7].season.NBA.reason, 'grace (7d ago)', 'the 7th quiet day is still inside the window');
  assert.equal(snaps[8].season.NBA.reason, 'released (8d idle)', 'the 8th is not');
  assert.equal(snaps[8].denom.includes('NBA'), false);
  assert.equal(snaps[9].season.NBA.reason, 'active-now', 're-entry is immediate');
  for (let i = 9; i < snaps.length; i++) steady(snaps[i], 'MLB', 'NBA', 'NHL', 'SOCCER');
  assert.deepEqual(flipsOf(snaps).NBA, 2, 'out once, in once — and never again');
  assert.deepEqual(flipsOf(snaps).NHL, 2);
  assert.equal(flipsOf(snaps).MLB, undefined);
  // Day 8 is the one day the board is just MLB + SOCCER (raw 0.17): the sum
  // floor binds, the published sumAlloc says so, and MLB is priced at 0.14/0.25
  // of the pool rather than 0.14/0.17 of it. The floor lets go as soon as the
  // board is credible again.
  assert.equal(snaps[8].sumAlloc, 0.25, 'the floor binds on a two-sport board, and the published number is the one priced against');
  assert.equal(snaps[8].ceilings.MLB, Math.floor(BUDGET * 0.85 * (0.14 / 0.25)));
  assert.equal(snaps[9].sumAlloc, 0.33, 'and releases the moment the board does');
  for (let i = 9; i < snaps.length; i++) assert.equal(snaps[i].sumAlloc, 0.33);
});

// ── 2. An empty board across a month rollover ──────────────────
test('an empty 200 board straddling Nov 1 moves no stamp, resets only the credit counter, and resumes the count', async () => {
  // Oct 20 + 10 = Oct 30. Seed with MLB five observed quiet days in and TENNIS
  // billed in October, which is its only route into the denominator.
  const state = {
    MLB: { first: day(-100), last: day(4), in: true, quiet: 5, obs: day(9) },
    NBA: { first: day(-100), last: day(9), in: true, quiet: 0, obs: day(9) },
  };
  const { step } = await scenario({ state, monthRow: { month: '2026-10', used: 500, by_sport: { NBA: 460, TENNIS: 40 } } });
  const oct30 = await step(10, []);                   // 200 with [] — the empty board
  const oct31 = await step(11, []);
  const nov1 = await step(12, []);
  const nov2 = await step(13, []);
  const nov3 = await step(14, boardOf('NBA', 'NHL'));
  for (const s of [oct30, oct31, nov1, nov2]) {
    assert.equal(s.season.MLB.reason, 'feed-unreadable', `${s.date}: an empty board is an unknown`);
    assert.equal(s.season.NFL.reason, 'feed-unreadable');
    assert.deepEqual(s.sentinel, state, `${s.date}: the sentinel must not move on an unreadable feed`);
    for (const x of NON_SKIP) assert.ok(s.denom.includes(x), `${s.date}: ${x} must be held in`);
    assert.match(s.summary, /\d+ (calls|paced)/, 'unknown means fetch anyway, not "nothing is in season"');
  }
  assert.equal(oct31.denom.includes('TENNIS'), true, 'billed in October');
  assert.equal(nov1.denom.includes('TENNIS'), false, 'the credit counter rolled over; the season clock did not');
  assert.equal(nov1.bySport.TENNIS, undefined);
  assert.equal(nov3.season.MLB.reason, 'grace (10d ago)', 'calendar age is reported');
  assert.equal(nov3.sentinel.MLB.quiet, 6, 'but the count resumed from 5: the four unreadable days were not observations');
  assert.equal(nov3.sentinel.MLB.obs, day(14));
  assert.equal(nov3.season.NHL.reason, 'active-now');
  assert.equal(transitions().length, 0, 'nothing changed, so nothing was announced');
});

// ── 3. One day of presence in the middle of a grace window ─────
test('a sport that appears for one day mid-window restarts its clock in full and is released once, 15 quiet days later', async () => {
  const { step } = await scenario();
  const snaps = [await step(0, boardOf('MLB', 'NBA'))];
  for (let d = 1; d <= 10; d++) snaps.push(await step(d, boardOf('NBA')));
  snaps.push(await step(11, boardOf('MLB', 'NBA')));
  for (let d = 12; d <= 30; d++) snaps.push(await step(d, boardOf('NBA')));
  assert.equal(snaps[10].season.MLB.reason, 'grace (10d ago)');
  assert.equal(snaps[11].season.MLB.reason, 'active-now');
  assert.equal(snaps[11].sentinel.MLB.last, day(11));
  assert.equal(snaps[25].season.MLB.reason, 'grace (14d ago)');
  assert.equal(snaps[26].season.MLB.reason, 'released (15d idle)');
  assert.equal(flipsOf(snaps).MLB, 1, 'a blip costs a full window; it does not cause a flap');
  for (let i = 26; i < snaps.length; i++) steady(snaps[i], 'NBA');
});

// ── 4. A corrupted sentinel row, met by a fresh process ────────
test('a corrupted sentinel row resolves every unknown to IN, self-heals, and reaches the correct steady state', async () => {
  // A row hit by a partial jsonb write, a hand edit and a type confusion at once.
  const state = {
    MLB: { first: '2026-09-06', last: '2026-11', in: false, quiet: 40, obs: day(-1) },   // truncated `last`
    NBA: 'garbage',                                                                         // not an object
    NHL: null,
    NFL: { first: 'x', last: null, quiet: 'y', obs: 5 },                                   // nothing parseable
    SOCCER: { first: day(-100), last: day(-1), in: true, quiet: -4, obs: 'garbage' },      // negative count, bad obs
    UFC: { first: day(-100), last: day(-1), in: true, quiet: 1e9, obs: day(-1) },          // absurd count, recent last
    NCAAB: { first: day(-100), last: day(-30), in: false, quiet: 29, obs: day(-1) },       // a legitimately released sport
  };
  const { step } = await scenario({ state });
  const snaps = [await step(0, boardOf('NBA', 'NHL', 'SOCCER', 'NCAAB'))];
  const s0 = snaps[0];
  assert.equal(s0.season.MLB.reason, 'seeding (14d left)', 'a half-written row reseeds — it does not release on the spot');
  assert.equal(s0.season.NFL.reason, 'seeding (14d left)');
  assert.equal(s0.season.NBA.reason, 'active-now');
  assert.equal(s0.season.NHL.reason, 'active-now');
  assert.equal(s0.season.SOCCER.reason, 'active-now');
  assert.equal(s0.sentinel.SOCCER.quiet, 0, 'an active observation overwrote the negative count');
  assert.equal(s0.season.UFC.reason, 'grace (1d ago)', 'an absurd count cannot release a sport active yesterday');
  assert.equal(s0.season.NCAAB.reason, 'active-now', 'a released sport that shows up is back on one observation');
  for (const x of NON_SKIP) assert.ok(s0.denom.includes(x), `${x}: every unknown must resolve to IN`);
  // The rewritten row is clean: every field parseable, every count an integer.
  for (const [sp, e] of Object.entries(s0.sentinel)) {
    assert.match(e.first, /^\d{4}-\d{2}-\d{2}$/, `${sp}.first`);
    assert.ok(e.last === null || /^\d{4}-\d{2}-\d{2}$/.test(e.last), `${sp}.last`);
    assert.ok(Number.isInteger(e.quiet) && e.quiet >= 0, `${sp}.quiet = ${e.quiet}`);
    assert.equal(e.obs, day(0), `${sp}.obs`);
  }
  assert.equal(s0.sentinel.UFC.quiet, 1e9 + 1, 'the absurd count is carried, not repaired — the calendar guard is what contains it');
  // Then quiet days for everyone but NBA.
  for (let d = 1; d <= 20; d++) snaps.push(await step(d, boardOf('NBA')));
  assert.equal(snaps[13].season.MLB.reason, 'seeding (1d left)');
  assert.equal(snaps[14].season.MLB.reason, 'released (14d idle)', 'the reseeded clock ran its full window');
  assert.equal(snaps[14].season.NFL.reason, 'released (14d idle)');
  // UFC: the count was corrupt-high, so release waits only on the calendar half
  // of the rule — 14 days after its (genuine) last active day, i.e. day 13 —
  // one day earlier than an honest count would have released it. Documented
  // here because it is the one place the two halves of the rule disagree, and
  // the calendar half is the weaker guard by design.
  assert.equal(snaps[12].season.UFC.reason, 'grace (13d ago)');
  assert.equal(snaps[13].season.UFC.reason, 'released (14d idle)');
  assert.equal(snaps[15].season.SOCCER.reason, 'released (15d idle)', 'an honest count from zero: 15 observed quiet days');
  assert.equal(snaps[15].season.NCAAB.reason, 'released (15d idle)');
  for (let i = 15; i < snaps.length; i++) steady(snaps[i], 'NBA');
  // One flip per sport, no churn while healing.
  for (const [x, f] of Object.entries(flipsOf(snaps))) assert.equal(f, 1, `${x} flipped ${f} times`);
});

// ── 5. Flapping feeds ──────────────────────────────────────────
test('a presence flag that alternates day by day never moves the denominator — zero transitions in 40 days', async () => {
  const { step } = await scenario();
  const snaps = [];
  for (let d = 0; d <= 40; d++) snaps.push(await step(d, d % 2 ? boardOf('NBA', 'NHL') : boardOf('NHL')));
  for (const s of snaps) {
    assert.ok(s.denom.includes('NBA'), `day ${s.day}: NBA out`);
    assert.ok(['active-now', 'grace (1d ago)', 'seeding (14d left)'].includes(s.season.NBA.reason), `day ${s.day}: ${s.season.NBA.reason}`);
    assert.ok(s.sentinel.NBA.quiet <= 1);
  }
  assert.equal(flipsOf(snaps).NBA, undefined);
  assert.equal(flipsOf(snaps).NHL, undefined);
  assert.ok(!transitions().some((m) => /^season: NBA /.test(m)), 'no NBA transition was ever logged');
  // Ceilings for the sport that IS stable are stable too, once the never-seen
  // sports have left (day 14): the flapping sport's presence must not move them.
  const after = snaps.slice(15);
  const nhl = new Set(after.map((s) => s.ceilings.NHL));
  assert.equal(nhl.size, 1, `NHL's ceiling moved with NBA's flag: ${[...nhl]}`);
  steady(snaps.at(-1), 'NBA', 'NHL');
});

test('a feed that alternates readable/unreadable run by run moves no stamp and announces nothing', async () => {
  // Start from a released MLB and an active NBA.
  const state = {
    MLB: { first: day(-100), last: day(-30), in: false, quiet: 29, obs: day(-1) },
    NBA: { first: day(-100), last: day(-1), in: true, quiet: 0, obs: day(-1) },
  };
  const { step } = await scenario({ state });
  const snaps = [];
  for (let d = 0; d <= 20; d++) snaps.push(await step(d, d % 2 ? null : boardOf('NBA')));
  for (const s of snaps) {
    assert.ok(s.denom.includes('NBA'), `day ${s.day}`);
    if (s.day % 2) {
      // The designed tight-side reading of an unknown: a released sport is
      // priced back in for this run. That is pre-feature behaviour (`active ===
      // null` always meant "every sport in") and it costs nothing but headroom.
      assert.equal(s.season.MLB.reason, 'feed-unreadable');
      assert.equal(s.denom.includes('MLB'), true);
      assert.deepEqual(s.sentinel, snaps[s.day - 1].sentinel, `day ${s.day}: an unreadable run wrote a stamp`);
    } else {
      assert.match(s.season.MLB.reason, /^released \(\d+d idle\)$/);
      assert.equal(s.denom.includes('MLB'), false);
    }
  }
  assert.equal(transitions().length, 0, 'membership on an unreadable run is a reading, not a transition');
  assert.equal(snaps.at(-1).sentinel.MLB.quiet, 29 + 11, 'only the 11 readable days counted');
  assert.equal(snaps.at(-1).sentinel.MLB.in, false, 'the persisted membership never flipped');
});

test('twenty runs a day count one quiet day each, so release lands on the calendar day, not on run 15', async () => {
  const state = { MLB: { first: day(-100), last: day(-1), in: true, quiet: 0, obs: day(-1) } };
  const { step } = await scenario({ state });
  const perDay = [];
  for (let d = 0; d <= 15; d++) {
    let last;
    for (let h = 0; h < 20; h++) last = await step(d, boardOf('NBA'), h);   // 00:00 … 19:00 UTC
    perDay.push(last);
    assert.equal(last.sentinel.MLB.quiet, d + 1, `day ${d}: ${last.sentinel.MLB.quiet} after 20 runs`);
  }
  assert.equal(perDay[13].season.MLB.reason, 'grace (14d ago)');
  assert.equal(perDay[14].season.MLB.reason, 'released (15d idle)');
  assert.equal(transitions().filter((m) => /^season: MLB /.test(m)).length, 1);
  // And across a UTC midnight two runs two hours apart are two observations.
  const { step: step2 } = await scenario({ state: { MLB: { first: day(-100), last: day(-1), in: true, quiet: 0, obs: day(-1) } } });
  const late = await step2(0, boardOf('NBA'), 23);
  const early = await step2(1, boardOf('NBA'), 1);
  assert.equal(late.sentinel.MLB.quiet, 1);
  assert.equal(early.sentinel.MLB.quiet, 2);
  assert.equal(early.sentinel.MLB.obs, day(1));
});

// ── 6. The bounds, reached through run() ───────────────────────
test('a one-league board prices that league inside the bounds and the rest return the moment the board does', async () => {
  // Every other sport quiet past the window, so only the one on the board is in.
  const state = Object.fromEntries(NON_SKIP.map((s) => [s, { first: day(-100), last: day(-30), in: false, quiet: 29, obs: day(-1) }]));
  const { mod, step } = await scenario({ state });
  const thin = await step(0, boardOf('NFL'));
  assert.deepEqual(thin.denom, ['NFL']);
  assert.equal(thin.sumAlloc, 0.32, 'published as the raw sum');
  assert.equal(thin.ceilings.NFL, Math.floor(BUDGET * 0.85 * 0.6), 'but priced under MAX_SPORT_POOL, never at the whole pool');
  assert.equal(mod.currentCeiling('NFL'), thin.ceilings.NFL);
  const full = await step(1, boardOf(...NON_SKIP));
  assert.deepEqual(full.denom, NON_SKIP.slice().sort());
  assert.ok(full.ceilings.NFL < thin.ceilings.NFL);
  const sum = Object.values(full.ceilings).filter((_, i) => NON_SKIP.includes(Object.keys(full.ceilings)[i])).reduce((a, b) => a + b, 0);
  assert.ok(sum <= BUDGET * 0.85);
  assert.equal(transitions().length, NON_SKIP.length, 'every returning sport announced once — NFL on day 0, the other nine on day 1');
});
