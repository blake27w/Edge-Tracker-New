// ══════════════════════════════════════════════════════════════
// A whole season, in one process, through the REAL run().
//
// The spec admits the live proof arrives in instalments months apart (MLB's
// release ~19 Nov, football's after the Super Bowl). This file makes that proof
// deterministic: the wall clock is replaced, so `new Date()` inside the agent
// is the simulated day, and `/sports` is a scripted calendar — MLB finishing on
// Oct 31, NFL playing only Sun/Mon/Thu, NCAAF on Saturdays, UFC every second
// Saturday, BOXING once a month, WNBA never — then one run() per day for 132
// days (20 Oct 2026 → 28 Feb 2027) with a 20-day outage where run() is never
// invoked, a month that exhausts on the 13th, two month rollovers, a window of
// failing sentinel writes, and a process restart (a fresh module instance
// re-reading the sentinel row from the fake DB).
//
// Two kinds of assertion. An ORACLE — the spec's rules re-implemented here in
// a dozen lines with no row-validation, no `obs` bookkeeping — is compared to
// the agent's published membership for every sport on every day, so any
// divergence anywhere in the 112 observed days is caught without being
// anticipated. Then hand-computed CHECKPOINTS pin the days that matter (the
// first release, the outage not ageing anyone out, the exhausted month still
// watching, the backstop lifting on Feb 1, MLB back in on Feb 20) so a reader
// can see the mechanism rather than trust a diff of two models.
//
// Own file and own process: node:test cannot re-mock within a file, and the
// fake clock must be installed before the agent is imported.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ALLOC = { NFL: 0.32, NCAAF: 0.16, MLB: 0.14, NBA: 0.10, NCAAB: 0.06, NHL: 0.06,
  SOCCER: 0.03, UFC: 0.04, BOXING: 0.02, WNBA: 0.02, TENNIS: 0.03, GOLF: 0.02 };
const BUDGET = 20000;
const POOL = 0.85;
const GRACE = 14;
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
const FOOTBALL = ['NFL', 'NCAAF'];
const keysOf = (s) => SPORTS[s].leagues || [SPORTS[s].key];

// ── The clock ──────────────────────────────────────────────────
// Every `new Date()` and `Date.now()` inside the agent reads the simulated
// instant; explicit arguments still construct real dates. 15:00Z keeps each
// simulated run well inside its calendar day.
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-20T15:00:00Z');            // day 0, a Tuesday
const RealDate = Date;
let simNow = T0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(simNow); }
  static now() { return simNow; }
}
const dateOf = (d) => new RealDate(T0 + d * DAY);
const ymd = (d) => dateOf(d).toISOString().slice(0, 10);
const dayOf = (iso) => Math.round((RealDate.parse(`${iso}T15:00:00Z`) - T0) / DAY);
const dow = (d) => dateOf(d).getUTCDay();                  // 0 Sun … 6 Sat
const monthOf = (d) => dateOf(d).getUTCMonth();            // 0 Jan … 11 Dec
const firstSaturdayOfMonth = (d) => dow(d) === 6 && dateOf(d).getUTCDate() <= 7;
// Production's rule (config.footballPriorityOn, FOOTBALL_PRIORITY=auto): Sep–Jan.
const footballOn = (d) => [8, 9, 10, 11, 0].includes(monthOf(d));

// ── The calendar ───────────────────────────────────────────────
// Dates are day indices from T0. Named so the checkpoints below read as dates.
const OCT31 = dayOf('2026-10-31'), NOV1 = dayOf('2026-11-01'), NOV4 = dayOf('2026-11-04');
const OUTAGE_FROM = dayOf('2026-11-09'), OUTAGE_TO = dayOf('2026-11-28');   // run() never invoked
const DEC12 = dayOf('2026-12-12'), DEC13 = dayOf('2026-12-13'), DEC31 = dayOf('2026-12-31');
const JAN1 = dayOf('2027-01-01'), JAN11 = dayOf('2027-01-11'), JAN31 = dayOf('2027-01-31');
const FEB1 = dayOf('2027-02-01'), FEB4 = dayOf('2027-02-04'), FEB7 = dayOf('2027-02-07');
const FEB20 = dayOf('2027-02-20'), LAST = dayOf('2027-02-28');
const WRITE_FAIL_FROM = dayOf('2027-01-14'), WRITE_FAIL_TO = dayOf('2027-01-16');
const RESTART_DAY = dayOf('2027-01-20');

function activeOn(d) {
  const out = new Set();
  const add = (s, ...ks) => { for (const k of (ks.length ? ks : keysOf(s))) out.add(k); };
  if (d <= OCT31 || d >= FEB20) add('MLB');                         // World Series, then spring training
  if ([0, 1, 4].includes(dow(d)) && d <= FEB7) add('NFL');          // Sun/Mon/Thu, Super Bowl Feb 7
  if ((dow(d) === 6 && d <= DEC12) || d === JAN1 || d === JAN11) add('NCAAF');  // Saturdays, a bowl, the title game
  if (d >= NOV4) add('NCAAB');
  if (d >= 1 && d <= JAN31) add('NBA');                            // opens Oct 21, "ends" Jan 31 for this sim
  if (d <= FEB4 - 1) add('NHL');                                    // "ends" Feb 3
  if ([6, 0].includes(dow(d))) add('SOCCER', 'soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga');
  if ([2, 3].includes(dow(d))) add('SOCCER', 'soccer_uefa_champs_league');  // MLS is in its offseason all sim
  if (dow(d) === 6 && Math.floor(d / 7) % 2 === 0) add('UFC');       // every second Saturday: 13-day gaps
  if (firstSaturdayOfMonth(d)) add('BOXING');                       // once a month: released and re-entered
  return out;                                                       // WNBA: never
}

// ── The fake api_usage table ───────────────────────────────────
// Stateful, keyed on the unique (provider, month) — so a month rollover and a
// restart read back exactly what the last run wrote, as production does.
const table = new Map();
const rowKey = (r) => `${r.provider}|${r.month}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const writes = [];
let sentinelWritable = true;
const db = {
  isConnected: () => true,
  select: async (tbl, cols, opts) => {
    if (tbl !== 'api_usage') return [];
    const r = table.get(rowKey((opts && opts.match) || {}));
    return r ? [clone(r)] : [];
  },
  upsert: async (tbl, row) => {
    if (tbl !== 'api_usage') return { count: 1 };
    if (row.provider === 'odds-season' && !sentinelWritable) throw new Error('permission denied for table api_usage');
    writes.push({ day: curDay, row: clone(row) });
    table.set(rowKey(row), clone(row));
    return { count: 1 };
  },
  insert: async () => ({ count: 1 }),
};

// ── The feed ───────────────────────────────────────────────────
let curDay = 0;
let board = new Set();
let remainingHdr = null;     // x-requests-remaining when set; null = header absent
const oddsCalls = [];        // { day, key }
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/sports?')) {
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => [...board].map((k) => ({ key: k, active: true })) };
  }
  const key = u.match(/\/sports\/([^/]+)\/odds/)[1];
  oddsCalls.push({ day: curDay, key });
  return { ok: true, status: 200,
    headers: { get: (h) => (h === 'x-requests-remaining' ? remainingHdr : null) },
    json: async () => [] };
};

const cfg = {
  oddsApi: { allocation: ALLOC, monthlyBudget: BUDGET, tier: 'starter', key: 'test-key',
    seasonGraceDays: GRACE, footballSports: FOOTBALL, footballPriority: 'auto',
    footballPriorityOn: () => footballOn(curDay), base: 'https://api.the-odds-api.com/v4' },
  SPORTS, BOOKS: ['draftkings'], BOOK_LABELS: { draftkings: 'DK' },
  rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: true,
};
const logs = [];

// ── The oracle: the spec's rules, independently ────────────────
// in(S) iff active today, or fewer than graceDays+1 CONSECUTIVE OBSERVED quiet
// days, or the football backstop. Denominator = in ∪ (billed ∧ ¬released).
const oracle = Object.fromEntries(NON_SKIP.map((s) => [s, { quiet: 0, in: true }]));
function oracleStep(d, bySport) {
  const keys = activeOn(d);
  for (const s of NON_SKIP) {
    const o = oracle[s];
    if (keysOf(s).some((k) => keys.has(k))) { o.quiet = 0; o.in = true; }
    else { o.quiet += 1; o.in = o.quiet <= GRACE || (footballOn(d) && FOOTBALL.includes(s)); }
  }
  const denom = new Set(NON_SKIP.filter((s) => oracle[s].in));
  for (const s of Object.keys(SPORTS)) {
    if ((bySport[s] || 0) > 0 && !(NON_SKIP.includes(s) && !oracle[s].in)) denom.add(s);
  }
  return [...denom].sort();
}

// ── The run log ────────────────────────────────────────────────
const log = new Map();       // day -> snapshot
let mod;
let restarts = 0;
const fresh = async () => import(`../src/agents/odds/index.js?restart=${++restarts}`);

before(async () => {
  global.Date = FakeDate;
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: cfg });
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isMissingRelation: () => false } });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: { info: (a, m) => logs.push({ day: curDay, m }), warn: (a, m) => logs.push({ day: curDay, m }), error() {} },
      notifyAll: async () => ({ total: 0 }) },
  });
  mod = await import('../src/agents/odds/index.js');

  for (let d = 0; d <= LAST; d++) {
    curDay = d;
    simNow = T0 + d * DAY;
    board = activeOn(d);
    if (d >= OUTAGE_FROM && d <= OUTAGE_TO) continue;             // nobody is running
    remainingHdr = (d >= DEC13 && d <= DEC31) ? '0' : null;       // the API says the month is spent
    sentinelWritable = !(d >= WRITE_FAIL_FROM && d <= WRITE_FAIL_TO);
    if (d === RESTART_DAY) mod = await fresh();                    // a redeploy: new process, same DB
    const r = await mod.default.run();
    const p = mod.getOddsCeilings();
    const b = mod.getOddsBudget();
    log.set(d, {
      day: d, date: ymd(d), summary: r.summary,
      denom: p.denom.slice().sort(), season: clone(p.season), ceilings: clone(p.ceilings), sumAlloc: p.sumAlloc,
      bySport: clone(b.bySport), used: b.used, remaining: b.remaining, month: b.month,
      oracle: oracleStep(d, b.bySport),
      sentinel: clone(table.get('odds-season|state')?.by_sport || null),
      hasBudget: Object.fromEntries(Object.keys(SPORTS).map((s) => [s, mod.hasOddsBudget(0, s)])),
    });
  }
});
after(() => { global.Date = RealDate; global.fetch = realFetch; mock.reset(); });

const days = () => [...log.values()];
const at = (d) => { const s = log.get(d); assert.ok(s, `no run on day ${d} (${ymd(d)})`); return s; };
const reason = (d, s) => at(d).season[s].reason;
const inDenom = (d, s) => at(d).denom.includes(s);

// ── 0. The simulation is what it claims to be ──────────────────
test('the calendar ran: 112 observed days, a 20-day hole, two rollovers', () => {
  assert.equal(log.size, LAST + 1 - (OUTAGE_TO - OUTAGE_FROM + 1));
  assert.equal(log.size, 112);
  for (let d = OUTAGE_FROM; d <= OUTAGE_TO; d++) assert.equal(log.has(d), false);
  assert.equal(at(0).date, '2026-10-20');
  assert.equal(at(LAST).date, '2027-02-28');
  assert.equal(at(DEC31).month, '2026-12');
  assert.equal(at(JAN1).month, '2027-01');
  // The scenario the task names: NFL absent on more days than it is present.
  const nflAbsent = days().filter((s) => s.season.NFL.reason !== 'active-now' && s.day <= FEB7).length;
  const nflDays = days().filter((s) => s.day <= FEB7).length;
  assert.ok(nflAbsent / nflDays > 0.5, `NFL must be absent most days to mean anything (${nflAbsent}/${nflDays})`);
});

// ── 1. Membership equals the oracle, every sport, every day ────
test('the published denominator equals the spec rules on every one of the 112 days', () => {
  for (const s of days()) {
    assert.deepEqual(s.denom, s.oracle, `day ${s.day} (${s.date}): agent ${s.denom} vs oracle ${s.oracle}`);
    assert.equal(s.sumAlloc, Math.round(s.denom.reduce((t, x) => t + ALLOC[x], 0) * 1000) / 1000,
      `day ${s.day}: sumAlloc must be the raw sum over the denominator — the floor never binds on a real board`);
    assert.ok(s.sumAlloc > 0.15, `day ${s.day}: the MIN_SUM_ALLOC floor must not bind on a believable board (${s.sumAlloc})`);
    assert.match(s.summary, /denom \d+\/12 \(/);
  }
});

// ── 2. Seeding day ─────────────────────────────────────────────
test('day 1: every non-skip sport is in, nothing is released, and a changed denom would be a defect', () => {
  const s = at(0);
  assert.deepEqual(s.denom, NON_SKIP.slice().sort(), 'TENNIS and GOLF have no spend, every other sport is held in');
  assert.equal(reason(0, 'MLB'), 'active-now');
  assert.equal(reason(0, 'NFL'), 'seeding (14d left)', 'a Tuesday: NFL is absent and the clock starts at seeding');
  assert.equal(reason(0, 'NBA'), 'seeding (14d left)');
  assert.equal(reason(0, 'WNBA'), 'seeding (14d left)');
  assert.equal(reason(0, 'SOCCER'), 'active-now', 'Champions League on a Tuesday is enough — some(), not every()');
  assert.equal(reason(0, 'TENNIS'), 'skip (ODDS_SKIP_SPORTS)');
  assert.equal(reason(1, 'NBA'), 'active-now', 'entry is immediate: opening night, in');
});

// ── 3. NFL never leaves during its season — on grace alone ─────
test('NFL is in the denominator on every observed day through the Super Bowl, never by the backstop', () => {
  for (const s of days()) {
    if (s.day > FEB7) break;
    assert.ok(s.denom.includes('NFL'), `day ${s.day} (${s.date}, dow ${dow(s.day)}): NFL left the denominator`);
    assert.notEqual(s.season.NFL.reason, 'football-backstop', `day ${s.day}: grace alone must hold NFL, the backstop is a backstop`);
    assert.ok(/^(active-now|seeding \(\d+d left\)|grace \([1-3]d ago\))$/.test(s.season.NFL.reason)
      || (s.day >= OUTAGE_TO && s.day <= OUTAGE_TO + 3),   // the first days back read a 20-day calendar age
    `day ${s.day}: ${s.season.NFL.reason}`);
  }
  // The weekly rhythm is visible: a Tuesday after a Monday game is 1d, a Saturday is 2d.
  const tue = days().find((s) => s.day > NOV1 && s.day < OUTAGE_FROM && dow(s.day) === 2);
  assert.equal(tue.season.NFL.reason, 'grace (1d ago)');
  const sat = days().find((s) => s.day > NOV1 && s.day < OUTAGE_FROM && dow(s.day) === 6);
  assert.equal(sat.season.NFL.reason, 'grace (2d ago)');
  // And after the Super Bowl it goes, 15 quiet days later, with the backstop off in February.
  assert.equal(reason(FEB7, 'NFL'), 'active-now');
  assert.equal(inDenom(FEB7 + 14, 'NFL'), true, 'held on the 14th quiet day');
  assert.equal(reason(FEB7 + 14, 'NFL'), 'grace (14d ago)');
  assert.equal(reason(FEB7 + 15, 'NFL'), 'released (15d idle)', 'the 15th consecutive observed quiet day releases');
  assert.equal(inDenom(FEB7 + 15, 'NFL'), false);
  assert.equal(inDenom(LAST, 'NFL'), false);
});

test('UFC, with 13-day gaps, is never released; BOXING, with monthly ones, is released and re-enters', () => {
  for (const s of days()) assert.ok(s.denom.includes('UFC'), `day ${s.day}: UFC released across a fortnight gap`);
  const ufcMax = Math.max(...days().map((s) => +(s.season.UFC.reason.match(/grace \((\d+)d/) || [0, 0])[1]));
  assert.ok(ufcMax >= 13, `the fortnight gap was actually exercised (max grace age ${ufcMax}d)`);
  const boxing = days().map((s) => s.denom.includes('BOXING'));
  assert.ok(boxing.some((x) => x) && boxing.some((x) => !x), 'BOXING is both in and out across the season');
  // Each re-entry is immediate (the first Saturday) and each release is exactly
  // 15 observed quiet days after it — never a flap in between.
  for (const s of days()) {
    if (firstSaturdayOfMonth(s.day)) assert.equal(s.season.BOXING.reason, 'active-now', `day ${s.day}`);
  }
});

// ── 4. The first releases: WNBA on day 14, MLB 35 days after its last game ──
test('a never-seen sport is released on the 15th observation, which is calendar day 14 after seeding', () => {
  assert.equal(reason(13, 'WNBA'), 'seeding (1d left)');
  assert.equal(inDenom(13, 'WNBA'), true);
  assert.equal(reason(14, 'WNBA'), 'released (14d idle)');
  assert.equal(inDenom(14, 'WNBA'), false);
  for (const s of days()) if (s.day >= 14) assert.equal(s.denom.includes('WNBA'), false, `day ${s.day}: WNBA back in`);
  assert.equal(logs.filter((l) => /season: WNBA released/.test(l.m)).length, 1, 'logged once, on the transition');
});

test('MLB: active to Oct 31, graced through November, NOT aged out by the outage, released Dec 5', () => {
  assert.equal(reason(OCT31, 'MLB'), 'active-now');
  assert.equal(reason(NOV1, 'MLB'), 'grace (1d ago)');
  assert.equal(reason(OUTAGE_FROM - 1, 'MLB'), 'grace (8d ago)');
  assert.equal(at(OUTAGE_FROM - 1).sentinel.MLB.quiet, 8, 'eight observed quiet days going into the outage');
  // 20 unobserved days: the calendar says 29, the counter says 9. The counter decides.
  const back = OUTAGE_TO + 1;
  assert.equal(reason(back, 'MLB'), 'grace (29d ago)', 'held: 29 calendar days idle but only 9 OBSERVED');
  assert.equal(at(back).sentinel.MLB.quiet, 9);
  assert.equal(inDenom(back, 'MLB'), true);
  // Nothing else was aged out by the hole either.
  for (const s of NON_SKIP) if (s !== 'WNBA') assert.ok(inDenom(back, s), `${s} aged out during the outage`);
  // The 15th observed quiet day is Dec 5.
  const release = back + 6;
  assert.equal(ymd(release), '2026-12-05');
  assert.equal(reason(release - 1, 'MLB'), 'grace (34d ago)');
  assert.equal(reason(release, 'MLB'), 'released (35d idle)');
  assert.equal(inDenom(release, 'MLB'), false);
  assert.equal(logs.filter((l) => /season: MLB released/.test(l.m)).length, 1);
  // The point of the feature: the winter ceilings rise when the dead share goes.
  for (const s of ['NBA', 'NHL', 'NCAAB']) {
    assert.ok(at(release).ceilings[s] > at(release - 1).ceilings[s], `${s}: ${at(release - 1).ceilings[s]} -> ${at(release).ceilings[s]}`);
  }
});

// ── 5. The exhausted month keeps watching, and cannot spend ────
test('Dec 14–31 is exhausted: no odds call, no spend, the clock still counts, the row is still written', () => {
  assert.doesNotMatch(at(DEC13).summary, /budget exhausted/, 'the 13th is the run that learns the month is spent');
  assert.equal(at(DEC13).remaining, 0);
  const spentAtExhaustion = at(DEC13).bySport;
  for (let d = DEC13 + 1; d <= DEC31; d++) {
    assert.match(at(d).summary, /budget exhausted .* still watching · denom \d+\/12/, `day ${d}`);
    assert.equal(oddsCalls.filter((c) => c.day === d).length, 0, `day ${d}: a billable call on an exhausted month`);
    assert.deepEqual(at(d).bySport, spentAtExhaustion, `day ${d}: spend moved on an exhausted month`);
    assert.ok(writes.some((w) => w.day === d && w.row.provider === 'odds-season'), `day ${d}: the sentinel was not written`);
    for (const s of Object.keys(SPORTS)) assert.equal(at(d).hasBudget[s], false, `day ${d}: ${s} discretionary spend allowed on an exhausted month`);
  }
  // NCAAF's last Saturday is Dec 12. Its quiet count advances through the
  // exhausted days and crosses the window on Dec 27 — inside the exhaustion —
  // where December's backstop catches it. The exhausted path observed that.
  const dec27 = DEC12 + 15;
  assert.equal(reason(dec27 - 1, 'NCAAF'), 'grace (14d ago)');
  assert.equal(reason(dec27, 'NCAAF'), 'football-backstop');
  assert.equal(at(dec27).sentinel.NCAAF.quiet, 15);
  assert.equal(inDenom(dec27, 'NCAAF'), true);
});

// ── 6. Month rollover: the credit counter resets, the season clock does not ──
test('Jan 1: spend resets, MLB stays released, TENNIS/GOLF-style billed entries lapse', () => {
  const s = at(JAN1);
  assert.doesNotMatch(s.summary, /budget exhausted/);
  assert.equal(s.used, oddsCalls.filter((c) => c.day === JAN1).length * 3, 'January starts from zero');
  assert.equal(s.season.MLB.reason, 'released (62d idle)', 'the sentinel is month-independent');
  assert.equal(s.denom.includes('MLB'), false);
  assert.equal(s.sentinel.MLB.quiet, at(DEC31).sentinel.MLB.quiet + 1, 'the counter carried across the month');
  assert.equal(s.season.NCAAF.reason, 'active-now', 'a bowl on New Year\'s Day');
});

// ── 7. The backstop lifts on Feb 1 and NCAAF goes; NBA and NHL end ──
test('Feb 1: the football month range ends and a long-quiet NCAAF is released on the spot', () => {
  assert.equal(reason(JAN11, 'NCAAF'), 'active-now');
  assert.equal(reason(JAN31, 'NCAAF'), 'football-backstop', 'quiet 20 > 14 but January is a football month');
  assert.equal(reason(FEB1, 'NCAAF'), 'released (21d idle)');
  assert.equal(inDenom(FEB1, 'NCAAF'), false);
  assert.equal(logs.filter((l) => /season: NCAAF released/.test(l.m)).length, 1, 'the backstop lifting is a transition, logged once');
  // NBA's last game Jan 31, NHL's Feb 3: released on their 15th quiet day each.
  assert.equal(reason(JAN31 + 15, 'NBA'), 'released (15d idle)');
  assert.equal(reason(JAN31 + 14, 'NBA'), 'grace (14d ago)');
  assert.equal(reason(FEB4 - 1 + 15, 'NHL'), 'released (15d idle)');
  assert.equal(reason(FEB4 - 1 + 14, 'NHL'), 'grace (14d ago)');
});

test('Feb 20: MLB returns on one observation, and the final board is exactly the spring one', () => {
  assert.equal(reason(FEB20 - 1, 'MLB'), 'released (111d idle)');
  assert.equal(reason(FEB20, 'MLB'), 'active-now');
  assert.equal(inDenom(FEB20, 'MLB'), true);
  assert.equal(logs.filter((l) => /season: MLB back in the denominator/.test(l.m)).length, 1);
  assert.deepEqual(at(LAST).denom, ['MLB', 'NCAAB', 'SOCCER', 'UFC'],
    'football, basketball, hockey, WNBA and BOXING are all released by the end of February');
  assert.equal(reason(LAST, 'TENNIS'), 'skip (ODDS_SKIP_SPORTS)');
});

// ── 8. Transitions: one per real change, no flapping ───────────
test('every sport changes membership only as often as its season does', () => {
  const flips = {};
  let prev = null;
  for (const s of days()) {
    if (prev) for (const x of NON_SKIP) if (prev.denom.includes(x) !== s.denom.includes(x)) flips[x] = (flips[x] || 0) + 1;
    prev = s;
  }
  assert.deepEqual(flips, {
    WNBA: 1,            // released Nov 3
    NCAAB: 2,           // seeded quiet Oct 20, released Nov 3, its season opened Nov 4 — one day out, back on one observation
    MLB: 2,             // released Dec 5, back Feb 20
    NCAAF: 1,           // released Feb 1, when the backstop lifted
    NFL: 1,             // released Feb 22
    NBA: 1, NHL: 1,     // released Feb 15 / Feb 18
    // One fight on the first Saturday of each month, 15 quiet days, released,
    // repeat: out Nov 3, in Nov 7, (Dec 5 lands before the Nov 7 clock reaches
    // 15 because of the outage) out Dec 20, in Jan 2, out Jan 17, in Feb 6, out Feb 21.
    BOXING: 7,
  });
  // NCAAB is the one surprise worth naming: a sport whose season opens more
  // than graceDays after deploy is released for the days between, then re-enters
  // on its first slate. Harmless — entry is the tightening direction — and gone
  // once the sentinel row has a real history.
  assert.equal(inDenom(NOV4 - 1, 'NCAAB'), false);
  assert.equal(reason(NOV4, 'NCAAB'), 'active-now');
});

// ── 9. The billed gate and spend accounting ────────────────────
test('a released sport never accrues spend; an active sport is billed exactly 3 per key per run', () => {
  let prev = null;
  for (const s of days()) {
    if (prev && prev.month === s.month) {
      for (const x of NON_SKIP) {
        if (/^released/.test(s.season[x].reason)) {
          assert.equal(s.bySport[x] || 0, prev.bySport[x] || 0, `day ${s.day}: released ${x} accrued spend`);
          assert.equal(oddsCalls.some((c) => c.day === s.day && keysOf(x).includes(c.key)), false, `day ${s.day}: released ${x} was fetched`);
        }
      }
    }
    // Credits = 3 per call (no x-requests-last header), and `used` is their sum.
    const callsToday = oddsCalls.filter((c) => c.day === s.day);
    const base = (prev && prev.month === s.month) ? prev.used : 0;
    if (s.remaining > 0 || s.day === DEC13) {
      assert.equal(s.used, base + callsToday.length * 3, `day ${s.day}: used ${s.used} vs ${base} + 3 x ${callsToday.length}`);
    }
    assert.equal(s.used, Object.values(s.bySport).reduce((a, b) => a + b, 0), `day ${s.day}: used must equal the sum of bySport`);
    prev = s;
  }
  // A live sport is fetched on exactly its active keys: SOCCER's weekend is three leagues, its midweek one.
  const sat = days().find((s) => dow(s.day) === 6 && s.day > NOV4 && s.day < OUTAGE_FROM);
  assert.equal(oddsCalls.filter((c) => c.day === sat.day && c.key.startsWith('soccer_')).length, 3);
  assert.equal(sat.bySport.SOCCER - at(sat.day - 1).bySport.SOCCER, 9);
  assert.equal(at(LAST).bySport.WNBA, undefined, 'WNBA never spent a credit all season');
  assert.equal(at(LAST).bySport.TENNIS, undefined);
});

// ── 10. The sentinel row, end to end ───────────────────────────
test('the sentinel is written on every run day, is month-independent, and is never accounting', () => {
  for (const s of days()) {
    const w = writes.filter((x) => x.day === s.day && x.row.provider === 'odds-season');
    if (s.day >= WRITE_FAIL_FROM && s.day <= WRITE_FAIL_TO) { assert.equal(w.length, 0, `day ${s.day}: the write was meant to fail`); continue; }
    assert.equal(w.length, 1, `day ${s.day}: ${w.length} sentinel writes`);
    assert.deepEqual({ month: w[0].row.month, used: w[0].row.used, budget: w[0].row.budget }, { month: 'state', used: 0, budget: 0 });
    assert.equal(w[0].row.by_sport.TENNIS, undefined, 'oddsSkip sports accumulate no season state');
    for (const [sp, e] of Object.entries(w[0].row.by_sport)) {
      assert.match(e.first, /^\d{4}-\d{2}-\d{2}$/, `${sp}.first`);
      assert.ok(e.last === null || /^\d{4}-\d{2}-\d{2}$/.test(e.last), `${sp}.last`);
      assert.ok(Number.isInteger(e.quiet) && e.quiet >= 0, `${sp}.quiet`);
      assert.equal(e.obs, s.date, `${sp}.obs must be the day it last counted`);
      assert.equal(typeof e.in, 'boolean');
    }
    const m = writes.filter((x) => x.day === s.day && x.row.provider === 'odds');
    assert.equal(m.length, 1);
    assert.equal(m[0].row.month, s.month);
    for (const v of Object.values(m[0].row.by_sport)) assert.equal(typeof v, 'number', 'the month row carries credits only');
  }
  assert.equal(table.get('odds-season|state').provider, 'odds-season');
  assert.equal(table.has('odds|state'), false);
  assert.equal(table.has('odds-season|2026-12'), false, 'the sentinel never lands on a real month');
});

test('three failed sentinel writes report a degradation, the fourth run clears it, and the state survives', async () => {
  const { getDegraded } = await import('../src/store/index.js');
  const degradedLog = logs.filter((l) => /season state has failed to persist/.test(l.m));
  assert.equal(degradedLog.length, 1, 'warned once, on the third consecutive failure');
  assert.equal(degradedLog[0].day, WRITE_FAIL_TO, 'the third run of the window');
  assert.match(degradedLog[0].m, /3 consecutive runs/);
  const recovered = logs.find((l) => /persisted again after 3 failed write/.test(l.m));
  assert.ok(recovered && recovered.day === WRITE_FAIL_TO + 1);
  assert.equal(getDegraded().some((d) => d.key === 'odds|season-state'), false, 'cleared by the next successful write');
  // In-memory state kept counting through the window; the DB caught up on the next write.
  assert.equal(at(WRITE_FAIL_TO + 1).sentinel.MLB.quiet, at(WRITE_FAIL_FROM - 1).sentinel.MLB.quiet + 4);
});

test('a process restart reads the sentinel back and continues the clock — nothing reseeds', () => {
  const before = at(RESTART_DAY - 1);
  const s = at(RESTART_DAY);
  assert.equal(s.season.MLB.reason, 'released (81d idle)', 'a fresh process does not meet MLB as a stranger');
  assert.equal(s.sentinel.MLB.quiet, before.sentinel.MLB.quiet + 1);
  assert.equal(s.sentinel.MLB.first, before.sentinel.MLB.first, 'the seeding day is the original one');
  for (const x of NON_SKIP) assert.doesNotMatch(s.season[x].reason, /^seeding/, `${x} reseeded on restart`);
  assert.deepEqual(s.denom, s.oracle);
  assert.equal(s.used, before.used + oddsCalls.filter((c) => c.day === RESTART_DAY).length * 3, 'the month row was re-read too');
});

// ── 11. The ceilings themselves ────────────────────────────────
test('every member ceiling is its share of the pool over the live denominator, and the sum never exceeds the pool', () => {
  for (const s of days()) {
    const sum = s.denom.reduce((t, x) => t + ALLOC[x], 0);
    let total = 0;
    for (const x of s.denom) {
      const want = Math.max(s.bySport[x] || 0, Math.floor(BUDGET * POOL * Math.min(ALLOC[x] / Math.max(0.15, sum), 0.6)));
      // Within one credit: the agent sums the shares in its own order, and
      // floor() over a float sum can differ by one from a sum taken in another.
      assert.ok(Math.abs(s.ceilings[x] - want) <= 1, `day ${s.day} ${x}: ${s.ceilings[x]} vs ${want}`);
      total += Math.floor(BUDGET * POOL * Math.min(ALLOC[x] / Math.max(0.15, sum), 0.6));
    }
    assert.ok(total <= BUDGET * POOL, `day ${s.day}: ${total}`);
    for (const x of Object.keys(ALLOC)) {
      if (s.denom.includes(x)) continue;
      const d = [...s.denom, x];
      const sum2 = d.reduce((t, y) => t + ALLOC[y], 0);
      const want2 = Math.max(s.bySport[x] || 0, Math.floor(BUDGET * POOL * Math.min(ALLOC[x] / Math.max(0.15, sum2), 0.6)));
      assert.ok(Math.abs(s.ceilings[x] - want2) <= 1, `day ${s.day} ${x}: a non-member is priced against denom + itself (${s.ceilings[x]} vs ${want2})`);
    }
  }
});
