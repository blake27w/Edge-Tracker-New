// ══════════════════════════════════════════════════════════════
// The season rules themselves — seasonVerdicts / seasonDenominator, pure.
//
// Who is in the ceiling DENOMINATOR is worth as much as the shares, because a
// ceiling is `budget x POOL x share / sumAlloc`. It used to be decided by
// today's /sports flag plus a hand-coded football month range; it is now derived
// from a persisted "last seen active" date with an asymmetric release grace.
//
// Both halves of that asymmetry are asserted here, because the asymmetry IS the
// design: entry is immediate (one active observation), release needs a full
// window of consecutive quiet days. Symmetric membership — today's flag alone —
// is the September bug (D6): football leaves the denominator on a Tuesday and
// every other ceiling inflates to fill the gap.
//
// `now` and `activeKeys` are parameters, so a season boundary is simulated
// deterministically rather than waited for. No clock, no network.
//
// Mutation-verified per D21: `quiet <= graceDays` -> `quiet <= 0` fails the
// grace tests; writing `last` on an unreadable feed fails 'an unreadable feed
// writes nothing'; dropping `&& !v.out` from seasonDenominator fails 'a released
// sport leaves the denominator even though it has spent'.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ALLOC = { NFL: 0.32, NCAAF: 0.16, MLB: 0.14, NBA: 0.10, NCAAB: 0.06, NHL: 0.06,
  SOCCER: 0.03, UFC: 0.04, BOXING: 0.02, WNBA: 0.02, TENNIS: 0.03, GOLF: 0.02 };
const SOCCER_LEAGUES = ['soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_uefa_champs_league', 'soccer_usa_mls'];
const SPORTS = {
  MLB: { key: 'baseball_mlb' }, NBA: { key: 'basketball_nba' }, NHL: { key: 'icehockey_nhl' },
  NFL: { key: 'americanfootball_nfl' }, NCAAF: { key: 'americanfootball_ncaaf' },
  NCAAB: { key: 'basketball_ncaab' }, WNBA: { key: 'basketball_wnba' },
  UFC: { key: 'mma_mixed_martial_arts' }, BOXING: { key: 'boxing_boxing' },
  SOCCER: { key: 'soccer', leagues: SOCCER_LEAGUES },
  TENNIS: { key: 'tennis', oddsSkip: true }, GOLF: { key: 'golf', oddsSkip: true },
};
const NON_SKIP = Object.keys(SPORTS).filter((s) => !SPORTS[s].oddsSkip);

// The closed set of authored reason strings. Never interpolated from env or
// from an API payload (D80) — only the day counts are substituted in.
const REASON_OK = (r) => r === 'active-now' || r === 'football-backstop' || r === 'feed-unreadable'
  || r === 'billed (event-only sport)' || r === 'skip (ODDS_SKIP_SPORTS)'
  || /^grace \(\d+d ago\)$/.test(r) || /^seeding \(\d+d left\)$/.test(r)
  || /^released \(\d+d idle\)$/.test(r);

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-05T12:00:00Z');
const at = (days) => new Date(T0 + days * DAY);
const day = (days) => new Date(T0 + days * DAY).toISOString().slice(0, 10);
const keysOf = (...sports) => new Set(sports.flatMap((s) => SPORTS[s].leagues || [SPORTS[s].key]));

let seasonVerdicts; let seasonDenominator;

before(async () => {
  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: { allocation: ALLOC, monthlyBudget: 20000, tier: 'starter', key: '',
        seasonGraceDays: 14, footballSports: ['NFL', 'NCAAF'], footballPriority: 'false',
        footballPriorityOn: () => false, base: 'https://api.the-odds-api.com/v4' },
      SPORTS, BOOKS: [], BOOK_LABELS: {}, rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: true,
    },
  });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: { isConnected: () => false, select: async () => [], upsert: async () => ({}), insert: async () => ({}) },
    namedExports: { isMissingRelation: () => false },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: { info() {}, warn() {}, error() {} }, notifyAll: async () => ({ total: 0 }) },
  });
  ({ seasonVerdicts, seasonDenominator } = await import('../src/agents/odds/index.js'));
});
after(() => mock.reset());

const run = (active, state, days = 0, grace = 14, footballOn = false) =>
  seasonVerdicts(active, state, SPORTS, at(days), grace, footballOn);

test('the seeding run holds every sport in — nothing is released for lack of history', () => {
  // The clock starts at deploy, not at the sport's real death: no per-sport
  // activity date is persisted anywhere today. An un-seeded sport is an UNKNOWN,
  // and every unknown resolves to IN the denominator.
  const { verdicts, nextState } = run(keysOf('NBA'), {});
  for (const s of NON_SKIP) {
    assert.equal(verdicts[s].in, true, `${s} must be in on the seeding run`);
  }
  assert.equal(verdicts.NBA.reason, 'active-now');
  assert.equal(verdicts.MLB.reason, 'seeding (14d left)');
  assert.equal(nextState.MLB.first, day(0));
  assert.equal(nextState.MLB.last, null, 'a sport never seen active has no last-active day');
  assert.equal(nextState.NBA.last, day(0));
});

test('entry is immediate — one active observation, no waiting', () => {
  // The flapping direction. Entry only ever TIGHTENS other sports' ceilings,
  // which is the harmless half of the asymmetry.
  const state = { NCAAB: { first: day(-40), last: day(-40), in: false } };
  const { verdicts } = run(keysOf('NCAAB'), state);
  assert.equal(verdicts.NCAAB.in, true);
  assert.equal(verdicts.NCAAB.reason, 'active-now');
});

test('a quiet sport is held by grace, and the reason says how long it has been quiet', () => {
  const state = { NBA: { first: day(-30), last: day(-3), in: true } };
  const { verdicts } = run(keysOf('NHL'), state);
  assert.equal(verdicts.NBA.in, true);
  assert.equal(verdicts.NBA.reason, 'grace (3d ago)');
});

test('release lands at exactly graceDays + 1 quiet days, not before', () => {
  const quiet = (n) => run(keysOf('NHL'), { MLB: { first: day(-120), last: day(-n), in: true } }).verdicts.MLB;
  assert.equal(quiet(13).in, true, '13 quiet days is inside a 14-day grace');
  assert.equal(quiet(14).in, true, 'the boundary day itself is still in');
  assert.equal(quiet(14).reason, 'grace (14d ago)');
  assert.equal(quiet(15).in, false, 'the day after the window closes, the sport is released');
  assert.equal(quiet(15).reason, 'released (15d idle)');
  assert.equal(quiet(15).out, true, '`out` is what lets spend stop holding the share');
});

test('graceDays = 0 releases a quiet sport on its first run — a boundary on demand', () => {
  // This is how a season boundary is summoned in a test and in the manual
  // recipe: with no grace, the seeding run is itself a quiet day. It also pins
  // that 0 means zero — config reads the knob through intEnv for this reason.
  const { verdicts } = run(keysOf('NBA'), {}, 0, 0);
  assert.equal(verdicts.MLB.in, false);
  assert.equal(verdicts.MLB.reason, 'released (0d idle)');
  assert.equal(verdicts.NBA.in, true, 'an active sport is unaffected by the grace being zero');
});

test('an unreadable feed writes nothing and holds everything in', () => {
  // Not writing is the load-bearing half. Refreshing `last` on an unreadable
  // feed would silently extend a dead sport's season by another full window,
  // forever, on a flaky network.
  const state = { MLB: { first: day(-120), last: day(-40), in: false }, NBA: { first: day(-30), last: day(-1), in: true } };
  const snapshot = JSON.stringify(state);
  const { verdicts, nextState, transitions } = run(null, state);
  assert.deepEqual(nextState, JSON.parse(snapshot), 'no stamp may move on an unreadable feed');
  assert.equal(JSON.stringify(state), snapshot, 'the input state is not mutated either');
  assert.equal(transitions.length, 0, 'an unreadable feed is not a season change');
  for (const s of NON_SKIP) {
    assert.equal(verdicts[s].in, true, `${s} must be held in when the feed cannot be read`);
    assert.equal(verdicts[s].reason, 'feed-unreadable');
  }
  assert.equal(verdicts.MLB.last, day(-40), 'the known history is still reported, just not advanced');
});

test('a sport cannot flap in and out inside one grace window', () => {
  // Any active observation rewrites `last`, so release is rate-limited to one
  // transition per sport per window by construction. Day 0 active, then quiet.
  let state = run(keysOf('NHL'), {}, 0).nextState;
  assert.equal(state.NHL.last, day(0));
  for (let d = 1; d <= 14; d++) {
    const step = run(keysOf('MLB'), state, d);
    assert.equal(step.verdicts.NHL.in, true, `NHL must still be in on quiet day ${d}`);
    assert.equal(step.transitions.filter((t) => t.sport === 'NHL').length, 0,
      `no NHL transition may fire on quiet day ${d}`);
    state = step.nextState;
  }
  const d15 = run(keysOf('MLB'), state, 15);
  assert.equal(d15.verdicts.NHL.in, false, 'day 15 is the single release transition');
  assert.deepEqual(d15.transitions.filter((t) => t.sport === 'NHL').map((t) => `${t.sport}:${t.in}`),
    ['NHL:false']);
  // And one active day resets the whole clock.
  const back = run(keysOf('NHL'), d15.nextState, 16);
  assert.equal(back.verdicts.NHL.in, true);
  assert.deepEqual(back.transitions.filter((t) => t.sport === 'NHL').map((t) => `${t.sport}:${t.in}`),
    ['NHL:true']);
  assert.equal(back.nextState.NHL.last, day(16));
});

test('a transition fires only on a CHANGE, never on every run', () => {
  const state = { MLB: { first: day(-120), last: day(-40), in: false } };
  const { transitions } = run(keysOf('NBA'), state);
  assert.equal(transitions.length, 0, 'MLB was already out; staying out is not an event');
});

test('oddsSkip sports are outside the sweep entirely — neither in nor out', () => {
  // TENNIS and GOLF have no bare Odds API key, never appear in `active`, and are
  // deliberately excluded from the sweep (D64/D65). `out: false` is what lets
  // spend still carry them into the denominator, exactly as it does today.
  const { verdicts, nextState } = run(keysOf('NBA'), {});
  for (const s of ['TENNIS', 'GOLF']) {
    assert.equal(verdicts[s].in, false, `${s} is not claimed in-season`);
    assert.equal(verdicts[s].out, false, `${s} must not be marked released — that would block its spend route`);
    assert.equal(verdicts[s].reason, 'skip (ODDS_SKIP_SPORTS)');
    assert.equal(nextState[s], undefined, `${s} must not accumulate season state`);
  }
});

test('SOCCER is in when ANY of its seven leagues is active', () => {
  // The some() semantics matter: our leagues do not take their international
  // breaks simultaneously, which is what keeps a 14-day grace workable for it.
  for (const league of SOCCER_LEAGUES) {
    const { verdicts } = run(new Set([league]), {});
    assert.equal(verdicts.SOCCER.in, true, `${league} alone must hold SOCCER in`);
    assert.equal(verdicts.SOCCER.reason, 'active-now');
  }
  const none = run(new Set(['soccer_brazil_serie_a']), { SOCCER: { first: day(-200), last: day(-40), in: true } });
  assert.equal(none.verdicts.SOCCER.in, false, 'a league we do not track is not our signal');
});

test('the football backstop holds football in after its grace has expired', () => {
  // D6 generalised, not dropped. Grace now gives every sport the protection
  // football was given by hand — so this term is redundant and stays anyway,
  // because it only ever holds a sport IN and it is the last line against D6's
  // measured failure if /sports ever reports football inactive for a fortnight.
  const dead = {
    NFL: { first: day(-200), last: day(-40), in: true },
    NCAAF: { first: day(-200), last: day(-40), in: true },
    MLB: { first: day(-200), last: day(-40), in: true },
  };
  const off = run(keysOf('NBA'), dead, 0, 14, false);
  assert.equal(off.verdicts.NFL.in, false, 'with the backstop off, an expired grace releases football');
  const on = run(keysOf('NBA'), dead, 0, 14, true);
  assert.equal(on.verdicts.NFL.in, true);
  assert.equal(on.verdicts.NFL.reason, 'football-backstop');
  assert.equal(on.verdicts.NCAAF.reason, 'football-backstop');
  assert.equal(on.verdicts.MLB.in, false, 'the backstop covers football only');
  // And grace alone holds football in with the backstop off — the two
  // protections are independent, which is the point of keeping both.
  const fresh = run(keysOf('NBA'), {}, 0, 14, false);
  assert.equal(fresh.verdicts.NFL.in, true);
  assert.equal(fresh.verdicts.NFL.reason, 'seeding (14d left)');
});

test('every reason comes from the closed set', () => {
  const states = [
    run(keysOf('NBA'), {}),
    run(null, {}),
    run(keysOf('NBA'), { MLB: { first: day(-120), last: day(-40), in: false }, NHL: { first: day(-9), last: day(-9), in: true } }, 0, 14, true),
    run(keysOf('NBA'), {}, 0, 0),
  ];
  for (const { verdicts } of states) {
    for (const [s, v] of Object.entries(verdicts)) {
      assert.equal(REASON_OK(v.reason), true, `${s}: ${v.reason} is not in the closed set`);
    }
  }
});

test('a malformed stored stamp reseeds rather than being parsed loosely', () => {
  // Tight direction: seeding holds the sport in for a full window.
  const { verdicts, nextState } = run(keysOf('NBA'), { MLB: { first: 'last tuesday', last: 'nope', in: false } });
  assert.equal(verdicts.MLB.in, true);
  assert.equal(verdicts.MLB.reason, 'seeding (14d left)');
  assert.equal(nextState.MLB.first, day(0));
});

test('a future stamp reads as today, not as negative age', () => {
  const { verdicts } = run(keysOf('NBA'), { MLB: { first: day(-120), last: day(+9), in: true } });
  assert.equal(verdicts.MLB.in, true);
  assert.equal(verdicts.MLB.reason, 'grace (0d ago)');
});

// ── seasonDenominator: who the ceilings are priced against ──────
test('a released sport leaves the denominator even though it has spent', () => {
  // THE fix. `billed` alone put any sport with a single credit into the
  // denominator and never took it out — which is how MLB's 0.14 of the pool
  // survived its whole offseason on one credit (D86).
  const verdicts = run(keysOf('NBA'), { MLB: { first: day(-120), last: day(-40), in: true } }).verdicts;
  const { denom, season } = seasonDenominator(verdicts, { MLB: 1, NBA: 900 });
  assert.equal(denom.includes('MLB'), false, 'one credit must not buy a dead sport a share');
  assert.equal(season.MLB.in, false);
  assert.match(season.MLB.reason, /^released \(\d+d idle\)$/);
  assert.equal(denom.includes('NBA'), true);
});

test('an oddsSkip sport with spend is in the denominator, and says why', () => {
  const verdicts = run(keysOf('NBA'), {}).verdicts;
  const { denom, season } = seasonDenominator(verdicts, { TENNIS: 40 });
  assert.equal(denom.includes('TENNIS'), true, 'spend is the only route TENNIS has — D64/D65 depend on it');
  assert.equal(season.TENNIS.reason, 'billed (event-only sport)');
  assert.equal(denom.includes('GOLF'), false, 'an oddsSkip sport with no spend stays out, as today');
});

test('the denominator reports a reason for every sport, in as well as out', () => {
  // The D88 gap: the live denominator was unknowable from /budget, so November's
  // analysis had to be modelled. Membership without a reason leaves the next
  // reader inferring the decision from a share table.
  const verdicts = run(keysOf('NBA', 'NHL'), { MLB: { first: day(-120), last: day(-40), in: true } }).verdicts;
  const { season } = seasonDenominator(verdicts, { MLB: 1 });
  assert.deepEqual(Object.keys(season).sort(), Object.keys(SPORTS).sort());
  for (const [s, v] of Object.entries(season)) {
    assert.equal(typeof v.in, 'boolean', `${s} has no membership`);
    assert.equal(REASON_OK(v.reason), true, `${s}: ${v.reason} is not in the closed set`);
  }
});
