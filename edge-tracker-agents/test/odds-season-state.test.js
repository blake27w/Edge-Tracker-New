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
// The release clock counts OBSERVATIONS, not calendar days — days we actually
// looked and saw the sport absent. That is not a detail: a calendar clock makes
// an outage indistinguishable from a season ending, and since the month's
// credits exhaust around day 13 at measured demand (D87), it would meet the next
// month with every sport ~18 days idle and release the whole table on a single
// observation. D6 again, by a different road.
//
// Mutation-verified per D21: `quiet <= graceDays` -> `quiet <= 0` fails the
// grace tests; reverting the counter to calendar age (`entry.quiet` -> `idle`)
// fails 'an unobserved stretch cannot age a sport out'; writing `last` on an
// unreadable feed fails 'an unreadable feed writes nothing'; treating an empty
// active set as a readable board fails 'an EMPTY active set is not a board';
// judging only `first` for malformedness fails 'a half-written row reseeds';
// dropping `&& !v.out` from seasonDenominator fails 'a released sport leaves the
// denominator even though it has spent'.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

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

// A state carrying an OBSERVED quiet history, which is the only thing that can
// release a sport. `quiet` is the release clock — days we actually looked and saw
// the sport absent — and `obs` is the day it last counted, so a run today adds
// one: quietFor(15) plus today's observation IS 15 quiet days.
//
// Calendar age ALONE releases nothing, deliberately. Every fixture below that
// wants a released sport has to say how many days it was OBSERVED quiet, because
// an old `last` with no observations is exactly what an outage looks like, and
// the outage must not release anything (see 'an unobserved stretch...').
const quietFor = (days, lastActiveDaysAgo = days) => ({
  first: day(-200),
  last: lastActiveDaysAgo == null ? null : day(-lastActiveDaysAgo),
  in: true, quiet: days - 1, obs: day(-1),
});

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
  const quiet = (n) => run(keysOf('NHL'), { MLB: quietFor(n) }).verdicts.MLB;
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
  const state = { MLB: { ...quietFor(40), in: false } };
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
  const none = run(new Set(['soccer_brazil_serie_a']), { SOCCER: quietFor(40) });
  assert.equal(none.verdicts.SOCCER.in, false, 'a league we do not track is not our signal');
});

test('the football backstop holds football in after its grace has expired', () => {
  // D6 generalised, not dropped. Grace now gives every sport the protection
  // football was given by hand — so this term is redundant and stays anyway,
  // because it only ever holds a sport IN and it is the last line against D6's
  // measured failure if /sports ever reports football inactive for a fortnight.
  const dead = { NFL: quietFor(40), NCAAF: quietFor(40), MLB: quietFor(40) };
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
    run(new Set(), {}),
    run(keysOf('NBA'), { MLB: { ...quietFor(40), in: false }, NHL: quietFor(9) }, 0, 14, true),
    run(keysOf('NBA'), {}, 0, 0),
    // An inconsistent row: more observed quiet days than the calendar allows.
    // The secondary calendar condition holds it in, and the reason it reports
    // still has to be one of the authored shapes.
    run(keysOf('NBA'), { MLB: { first: day(-3), last: null, quiet: 40, obs: day(-1) } }),
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

// ── The release clock is OBSERVED, not elapsed ──────────────────
test('an unobserved stretch cannot age a sport out — the outage case', () => {
  // THE finding. The budget exhausts around day 13 of a 2.3x-oversubscribed
  // month (D87), and the agent used to return before this code ran — so ~17 days
  // a month passed with nothing watching. On a calendar clock the next
  // observation would find every sport ~18 days idle and release the lot at
  // once, which is D6's measured failure arriving on a schedule.
  //
  // Here: a sport last seen active 60 days ago, with only ONE quiet day ever
  // observed. It stays in, and the 59 unwatched days buy nothing.
  const state = { MLB: { first: day(-200), last: day(-60), in: true, quiet: 1, obs: day(-59) } };
  const { verdicts, nextState } = run(keysOf('NBA'), state);
  assert.equal(verdicts.MLB.in, true, 'an outage must not release a sport on resume');
  assert.equal(verdicts.MLB.reason, 'grace (60d ago)', 'the calendar age is REPORTED, just not acted on');
  assert.equal(nextState.MLB.quiet, 2, 'one run, one observed quiet day');
  // And it takes a full window of real observations to get there from here.
  let st = nextState;                                // 2 observed quiet days
  for (let d = 1; d <= 11; d++) st = run(keysOf('NBA'), st, d).nextState;
  assert.equal(st.MLB.quiet, 13);
  const d12 = run(keysOf('NBA'), st, 12);
  assert.equal(d12.verdicts.MLB.in, true, '14 observed quiet days is still inside the window');
  assert.equal(d12.nextState.MLB.quiet, 14);
  assert.equal(run(keysOf('NBA'), d12.nextState, 13).verdicts.MLB.in, false,
    'the 15th observed quiet day is the release — 72 calendar days after the last slate');
});

test('the quiet counter counts a DAY once, not a run — 20 runs an hour do not release anything', () => {
  // The agent runs every ~3 minutes. A counter that ticked per run would turn a
  // 14-day window into 42 minutes, which is a worse D6 than the one we started
  // with. `obs` is what pins the count to the calendar day.
  let st = { MLB: quietFor(5) };
  const first = run(keysOf('NBA'), st).nextState;
  assert.equal(first.MLB.quiet, 5, "today's first quiet observation counts");
  st = first;
  for (let i = 0; i < 20; i++) st = run(keysOf('NBA'), st).nextState;
  assert.equal(st.MLB.quiet, 5, 'and the next twenty runs the same day do not');
  assert.equal(st.MLB.obs, day(0));
  assert.equal(run(keysOf('NBA'), st, 1).nextState.MLB.quiet, 6, 'tomorrow counts once more');
});

test('one active observation zeroes the clock, not just the date', () => {
  const st = run(keysOf('MLB'), { MLB: quietFor(14) }).nextState;
  assert.equal(st.MLB.quiet, 0, 'presence resets the counter — that is the hysteresis');
  assert.equal(st.MLB.last, day(0));
  assert.equal(run(keysOf('NBA'), st, 1).verdicts.MLB.in, true, 'and the window starts over');
});

test('a state with no quiet counter starts the clock at zero, not at its calendar age', () => {
  // The upgrade path: rows written before the counter existed. Reading a missing
  // counter as "however old `last` is" would release every quiet sport on the
  // first run after deploy — the same shape as the outage above.
  const { verdicts, nextState } = run(keysOf('NBA'), { MLB: { first: day(-200), last: day(-90), in: true } });
  assert.equal(verdicts.MLB.in, true, 'a pre-upgrade row holds its sport in');
  assert.equal(nextState.MLB.quiet, 0, 'and cannot be counted as already past the window');
});

test('an EMPTY active set is not a board — it is folded into the unreadable path', () => {
  // `new Set()` is truthy, so a 200 carrying `[]` (or an upstream rename of the
  // `active` field) walked straight past the `!activeKeys` fail-safe and was
  // accepted as "nothing on earth is in season" — which releases the whole table
  // one window later. Zero active leagues across twelve sports is a broken read.
  const state = { MLB: quietFor(40), NBA: { first: day(-30), last: day(-1), in: true, quiet: 1, obs: day(-1) } };
  const snapshot = JSON.stringify(state);
  const { verdicts, nextState } = run(new Set(), state);
  assert.deepEqual(nextState, JSON.parse(snapshot), 'no stamp and no counter may move on an empty board');
  for (const s of NON_SKIP) {
    assert.equal(verdicts[s].in, true, `${s} must be held in when the board is empty`);
    assert.equal(verdicts[s].reason, 'feed-unreadable');
  }
});

test('a half-written row reseeds — a valid first with a malformed last is not half-trusted', () => {
  // A truncated by_sport jsonb: `{first: '2026-09-06', last: '2026-11'}`. Judging
  // only `first` took the seeded branch, threw the unparseable `last` away as
  // null, and then dated the release clock from `first` — 60 days, released on
  // the spot, every quiet sport in the table in one run.
  const { verdicts, nextState } = run(keysOf('NBA'), {
    MLB: { first: day(-60), last: '2026-11', in: true, quiet: 40, obs: day(-1) },
  }, 0, 14);
  assert.equal(verdicts.MLB.in, true, 'an unreadable row is an unknown, and unknowns are held IN');
  assert.equal(verdicts.MLB.reason, 'seeding (14d left)');
  assert.equal(nextState.MLB.first, day(0), 'the clock restarts rather than being read loosely');
  assert.equal(nextState.MLB.last, null);
  assert.equal(nextState.MLB.quiet, 1, 'and the quiet counter restarts with it');
  // An ABSENT last is legitimate — never seen active — and must NOT reseed.
  const kept = run(keysOf('NBA'), { MLB: { first: day(-9), last: null, in: true, quiet: 9, obs: day(-1) } });
  assert.equal(kept.nextState.MLB.first, day(-9), 'a sport we have simply never seen active keeps its clock');
  assert.equal(kept.nextState.MLB.quiet, 10);
});

test('a corrupted quiet counter cannot release a sport that was active yesterday', () => {
  // The secondary calendar condition, and the only thing it is for: the counter
  // is a number in a jsonb blob, and a hand-edited or half-written one must not
  // be able to retire a live sport.
  const { verdicts } = run(keysOf('NBA'), { MLB: { first: day(-200), last: day(-1), in: true, quiet: 9999, obs: day(-1) } });
  assert.equal(verdicts.MLB.in, true, 'last seen active yesterday — no counter may override that');
  assert.equal(verdicts.MLB.reason, 'grace (1d ago)');
});

// ── seasonDenominator: who the ceilings are priced against ──────
test('a released sport leaves the denominator even though it has spent', () => {
  // THE fix. `billed` alone put any sport with a single credit into the
  // denominator and never took it out — which is how MLB's 0.14 of the pool
  // survived its whole offseason on one credit (D86).
  const verdicts = run(keysOf('NBA'), { MLB: quietFor(40) }).verdicts;
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
  const verdicts = run(keysOf('NBA', 'NHL'), { MLB: quietFor(40) }).verdicts;
  const { season } = seasonDenominator(verdicts, { MLB: 1 });
  assert.deepEqual(Object.keys(season).sort(), Object.keys(SPORTS).sort());
  for (const [s, v] of Object.entries(season)) {
    assert.equal(typeof v.in, 'boolean', `${s} has no membership`);
    assert.equal(REASON_OK(v.reason), true, `${s}: ${v.reason} is not in the closed set`);
  }
});

// ── The configured grace has a production floor ─────────────────
test('the configured grace cannot be set below the floor, and 0 still means 0 to the rules', async () => {
  // This one env integer was the whole distance between the feature and the
  // shape it exists to prevent: ODDS_SEASON_GRACE_DAYS=0 or =1 releases every
  // quiet sport on the next run or two, which is D6. The floor is in config, not
  // in seasonVerdicts — the pure rules above are driven at 0 and 1 on purpose,
  // because the boundary itself has to be testable.
  //
  // A child process is the only way to vary the environment (the agent-blocked
  // precedent): config is read once per process.
  const read = async (value) => {
    const env = { ...process.env };
    if (value === undefined) delete env.ODDS_SEASON_GRACE_DAYS;
    else env.ODDS_SEASON_GRACE_DAYS = value;
    const { stdout } = await exec(process.execPath, ['-e',
      "import('./src/config/index.js').then((m) => console.log(JSON.stringify(m.default.oddsApi.seasonGraceDays)))"],
    { cwd: new URL('..', import.meta.url), env });
    return JSON.parse(stdout.trim());
  };

  assert.equal(await read(undefined), 14, 'unset is the documented default');
  assert.equal(await read(''), 14, "Number('') is a finite 0, so a blank variable is not a boundary (D80)");
  assert.equal(await read('21'), 21, 'a value above the floor is honoured as given');
  assert.equal(await read('7'), 7, 'the floor itself is a legal setting');
  assert.equal(await read('0'), 7, 'and 0 — the September shape, summoned by env — is not');
  assert.equal(await read('1'), 7);
  assert.equal(await read('3'), 7);
  // The floor is a production guard, not a rule of the mechanism: the pure
  // function must still release at 0, or the boundary tests above could not run.
  assert.equal(run(keysOf('NBA'), {}, 0, 0).verdicts.MLB.in, false);
});

// ── The boundaries, as a table ─────────────────────────────────
// Every edge of the rule in one place: each grace the floor and the tests care
// about (0, 1, 7, 14) against a sport seen today, 14 days ago, 15, never, or in
// the future; a `quiet` that is missing, 0, exactly graceDays, graceDays+1; an
// `obs` that is today or yesterday either side of a UTC midnight; and the rows a
// truncated jsonb write can leave behind. The expectation is the spec's
// sentence — "release after graceDays consecutive OBSERVED quiet days" — so a
// sport seen N days ago and observed quiet every day since is in iff N <= grace.
//
// `seen(N)`: last active N days ago, every day since observed quiet (quiet N-1
// as of yesterday). `never(N)`: seeded N days ago, never active, observed quiet
// every day since (the seeding day counts).
const seen = (n, extra = {}) => ({ first: day(-200), last: day(-n), in: true, quiet: n - 1, obs: day(-1), ...extra });
const never = (n, extra = {}) => ({ first: day(-n), last: null, in: true, quiet: n, obs: day(-1), ...extra });
const MIDNIGHT = (days, hhmm) => new Date(Date.parse(`${day(days)}T${hhmm}:00Z`));
const DAY_OK = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

test('the boundary table: grace x age x quiet x obs, each resolved exactly as the sentence says', () => {
  const cases = [
    // ── grace 14, the default ──
    { name: 'seen today, active now', g: 14, active: true, st: seen(0, { quiet: 0, obs: day(0) }), want: { in: true, reason: 'active-now', quiet: 0, last: day(0) } },
    { name: 'seen earlier today, absent this run', g: 14, st: seen(0, { quiet: 0, obs: day(0) }), want: { in: true, reason: 'grace (0d ago)', quiet: 0 } },
    { name: 'seen 1 day ago', g: 14, st: seen(1), want: { in: true, reason: 'grace (1d ago)', quiet: 1 } },
    { name: 'seen 13 days ago', g: 14, st: seen(13), want: { in: true, reason: 'grace (13d ago)', quiet: 13 } },
    { name: 'seen 14 days ago — the last day inside the window', g: 14, st: seen(14), want: { in: true, reason: 'grace (14d ago)', quiet: 14 } },
    { name: 'seen 15 days ago — the first day outside it', g: 14, st: seen(15), want: { in: false, reason: 'released (15d idle)', quiet: 15 } },
    { name: 'seen 100 days ago', g: 14, st: seen(100), want: { in: false, reason: 'released (100d idle)', quiet: 100 } },
    { name: 'never seen, seeded today', g: 14, st: undefined, want: { in: true, reason: 'seeding (14d left)', quiet: 1, last: null, first: day(0) } },
    { name: 'never seen, seeded 13 days ago', g: 14, st: never(13), want: { in: true, reason: 'seeding (1d left)', quiet: 14 } },
    { name: 'never seen, seeded 14 days ago — the 15th observation', g: 14, st: never(14), want: { in: false, reason: 'released (14d idle)', quiet: 15 } },
    { name: 'seen in the future (clock skew)', g: 14, st: seen(-3, { quiet: 50 }), want: { in: true, reason: 'grace (0d ago)', quiet: 51 } },
    { name: 'seeded in the future, never seen', g: 14, st: never(-3, { quiet: 50 }), want: { in: true, reason: 'seeding (0d left)', quiet: 51 } },
    // ── grace 7, the production floor ──
    { name: 'grace 7: seen 7 days ago', g: 7, st: seen(7), want: { in: true, reason: 'grace (7d ago)', quiet: 7 } },
    { name: 'grace 7: seen 8 days ago', g: 7, st: seen(8), want: { in: false, reason: 'released (8d idle)', quiet: 8 } },
    { name: 'grace 7: seen 14 days ago', g: 7, st: seen(14), want: { in: false, reason: 'released (14d idle)', quiet: 14 } },
    { name: 'grace 7: never seen, seeded 7 days ago', g: 7, st: never(7), want: { in: false, reason: 'released (7d idle)', quiet: 8 } },
    { name: 'grace 7: never seen, seeded 6 days ago', g: 7, st: never(6), want: { in: true, reason: 'seeding (1d left)', quiet: 7 } },
    // ── grace 1 ──
    { name: 'grace 1: seen yesterday', g: 1, st: seen(1), want: { in: true, reason: 'grace (1d ago)', quiet: 1 } },
    { name: 'grace 1: seen 2 days ago', g: 1, st: seen(2), want: { in: false, reason: 'released (2d idle)', quiet: 2 } },
    { name: 'grace 1: never seen, seeded today', g: 1, st: undefined, want: { in: true, reason: 'seeding (1d left)', quiet: 1 } },
    { name: 'grace 1: never seen, seeded yesterday', g: 1, st: never(1), want: { in: false, reason: 'released (1d idle)', quiet: 2 } },
    // ── grace 0, the boundary on demand ──
    { name: 'grace 0: active now', g: 0, active: true, st: seen(5), want: { in: true, reason: 'active-now', quiet: 0 } },
    { name: 'grace 0: seen earlier today is still in', g: 0, st: seen(0, { quiet: 0, obs: day(0) }), want: { in: true, reason: 'grace (0d ago)', quiet: 0 } },
    { name: 'grace 0: seen yesterday is out', g: 0, st: seen(1), want: { in: false, reason: 'released (1d idle)', quiet: 1 } },
    { name: 'grace 0: never seen is out on the seeding run', g: 0, st: undefined, want: { in: false, reason: 'released (0d idle)', quiet: 1 } },
    // ── quiet: missing, 0, exactly grace, grace+1 ──
    { name: 'quiet missing (a row from before the counter): starts at 0, not at calendar age', g: 14, st: { first: day(-200), last: day(-40), in: true }, want: { in: true, reason: 'grace (40d ago)', quiet: 0 } },
    { name: 'quiet 0, obs yesterday: counts to 1', g: 14, st: seen(40, { quiet: 0 }), want: { in: true, reason: 'grace (40d ago)', quiet: 1 } },
    { name: 'quiet exactly grace, obs yesterday, calendar agrees: released', g: 14, st: seen(14, { quiet: 14 }), want: { in: false, reason: 'released (14d idle)', quiet: 15 } },
    { name: 'quiet exactly grace, obs TODAY: not counted again, held', g: 14, st: seen(14, { quiet: 14, obs: day(0) }), want: { in: true, reason: 'grace (14d ago)', quiet: 14 } },
    { name: 'quiet exactly grace but seen 5 days ago (inconsistent row): the calendar half holds it', g: 14, st: seen(5, { quiet: 14 }), want: { in: true, reason: 'grace (5d ago)', quiet: 15 } },
    { name: 'quiet grace+1, obs yesterday', g: 14, st: seen(16, { quiet: 15 }), want: { in: false, reason: 'released (16d idle)', quiet: 16 } },
    { name: 'quiet grace+1, obs today, seen 13 days ago: calendar holds it', g: 14, st: seen(13, { quiet: 15, obs: day(0) }), want: { in: true, reason: 'grace (13d ago)', quiet: 15 } },
    // ── half-written rows ──
    { name: 'last truncated to a month: reseed', g: 14, st: { first: day(-200), last: '2026-11', in: false, quiet: 40, obs: day(-1) }, want: { in: true, reason: 'seeding (14d left)', quiet: 1, first: day(0), last: null } },
    { name: 'first truncated: reseed', g: 14, st: { first: '2026-1', last: day(-40), in: false, quiet: 40, obs: day(-1) }, want: { in: true, reason: 'seeding (14d left)', quiet: 1, first: day(0), last: null } },
    { name: 'last empty string: reseed', g: 14, st: { first: day(-200), last: '', in: false, quiet: 40, obs: day(-1) }, want: { in: true, reason: 'seeding (14d left)', quiet: 1 } },
    { name: 'last absent (never active) is a legitimate row, not a half-written one', g: 14, st: { first: day(-20), in: true, quiet: 19, obs: day(-1) }, want: { in: false, reason: 'released (20d idle)', quiet: 20 } },
    { name: 'quiet as a string: reads as 0', g: 14, st: seen(40, { quiet: '40' }), want: { in: true, reason: 'grace (40d ago)', quiet: 1 } },
    { name: 'quiet negative: reads as 0', g: 14, st: seen(40, { quiet: -3 }), want: { in: true, reason: 'grace (40d ago)', quiet: 1 } },
    { name: 'quiet fractional: reads as 0', g: 14, st: seen(40, { quiet: 14.5 }), want: { in: true, reason: 'grace (40d ago)', quiet: 1 } },
    { name: 'obs unparseable: today is treated as already counted', g: 14, st: seen(40, { quiet: 10, obs: 'garbage' }), want: { in: true, reason: 'grace (40d ago)', quiet: 10 } },
    { name: 'obs absent: today is treated as already counted', g: 14, st: seen(40, { quiet: 10, obs: undefined }), want: { in: true, reason: 'grace (40d ago)', quiet: 10 } },
    { name: 'the entry is not an object: reseed', g: 14, st: 'garbage', want: { in: true, reason: 'seeding (14d left)', quiet: 1 } },
    { name: 'the entry is null: reseed', g: 14, st: null, want: { in: true, reason: 'seeding (14d left)', quiet: 1 } },
  ];
  for (const c of cases) {
    const state = c.st === undefined ? {} : { MLB: c.st };
    const { verdicts, nextState } = run(c.active ? keysOf('MLB') : keysOf('NBA'), state, 0, c.g);
    const v = verdicts.MLB;
    const e = nextState.MLB;
    assert.equal(v.in, c.want.in, `${c.name}: in`);
    assert.equal(v.reason, c.want.reason, `${c.name}: reason`);
    assert.equal(e.quiet, c.want.quiet, `${c.name}: quiet`);
    assert.equal(e.obs, day(0), `${c.name}: obs is always stamped today`);
    if ('last' in c.want) assert.equal(e.last, c.want.last, `${c.name}: last`);
    if ('first' in c.want) assert.equal(e.first, c.want.first, `${c.name}: first`);
    assert.ok(REASON_OK(v.reason), `${c.name}: reason outside the closed set`);
    assert.ok(Number.isInteger(e.quiet) && e.quiet >= 0 && DAY_OK(e.first) && (e.last === null || DAY_OK(e.last)),
      `${c.name}: the rewritten row must always be clean`);
  }
});

test('obs across a UTC midnight: 23:30 and 00:30 are two observations, 00:30 and 23:30 are one', () => {
  const base = { first: day(-200), last: day(-5), in: true, quiet: 4, obs: day(-1) };
  // Yesterday 23:30Z counted day -1 (already in the row as obs = day(-1)); today
  // 00:30Z is a new calendar day and counts.
  const a = seasonVerdicts(keysOf('NBA'), { MLB: base }, SPORTS, MIDNIGHT(0, '00:30'), 14, false);
  assert.equal(a.nextState.MLB.quiet, 5);
  assert.equal(a.nextState.MLB.obs, day(0));
  // 23:30Z the same day: same calendar day, counted already.
  const b = seasonVerdicts(keysOf('NBA'), a.nextState, SPORTS, MIDNIGHT(0, '23:30'), 14, false);
  assert.equal(b.nextState.MLB.quiet, 5);
  // 00:30Z the next day: counts again — two observations an hour apart, which
  // is how a 14-day window is really 14 days plus a minute. The calendar half of
  // the rule (`idle < graceDays`) is what stops that minute from mattering.
  const c = seasonVerdicts(keysOf('NBA'), b.nextState, SPORTS, MIDNIGHT(1, '00:30'), 14, false);
  assert.equal(c.nextState.MLB.quiet, 6);
  assert.equal(c.verdicts.MLB.reason, 'grace (6d ago)');
  // And the release itself, straddling midnight: quiet 14 at 23:59 is held,
  // quiet 15 at 00:01 is released — only because the calendar also reads 15.
  const held = seasonVerdicts(keysOf('NBA'), { MLB: { ...base, last: day(-14), quiet: 13, obs: day(-1) } }, SPORTS, MIDNIGHT(0, '23:59'), 14, false);
  assert.equal(held.verdicts.MLB.reason, 'grace (14d ago)');
  const rel = seasonVerdicts(keysOf('NBA'), held.nextState, SPORTS, MIDNIGHT(1, '00:01'), 14, false);
  assert.equal(rel.verdicts.MLB.reason, 'released (15d idle)');
  assert.equal(rel.nextState.MLB.quiet, 15);
});
