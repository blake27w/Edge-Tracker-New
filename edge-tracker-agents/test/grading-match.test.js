// ══════════════════════════════════════════════════════════════
// Grading — reproduction of the 2026-11-07 `grading|zero` slate.
//
// Production raised: "5 plays had finals available but 0 graded — none of 5
// plays matched a final, though ESPN returned finals for their sport+date
// (matchup ↔ ESPN nickname matching)". The alarm blames nickname matching.
// Nickname matching is fine for all five. The real faults, with the exact
// production strings, are below.
//
// The five plays in the queue at 2026-11-07T21:12Z were:
//   NHL   Chicago Blackhawks @ Carolina Hurricanes   prop  scored 11-07T15:41Z
//   NHL   Utah Mammoth @ Ottawa Senators             prop  scored 11-07T15:11Z (x2)
//   NCAAF Toledo Rockets @ Sacramento State Hornets  spread 25.5, scored 11-03T16:27Z
//   NHL   Ottawa Senators @ Anaheim Ducks            prop  scored 11-01T03:27Z
// The three 11-07 NHL games had not kicked off (7:00/8:00 PM EST starts).
//
// Unlike grading.test.js, getFinals here is keyed by (path, date) — the date
// window is itself one of the faults, so a mock that ignores the date cannot
// see it.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

// Pinned, not wall-clock. `at()`'s daysAgo/hour/minute math is relative to
// Date.now(), and Date.now() used to be the real clock — so after ~19:00
// Central, Date.now() had already rolled to the next UTC date and at(0, 15, 11)
// landed 13h in the FUTURE, pending's window selected 0 rows, and the
// zero-matched-games tests went red. Pinning Date.now() for the whole suite
// (D111 #2) makes every test's result independent of the hour this runs.
// 21:12 UTC — the production incident's own timestamp (see header). Chosen
// deliberately, not just "a safe hour": it is AFTER every `at(0, h, m)` fixture
// below (the latest is 15:11) by more than the 3.5h queue cutoff, so pinning it
// doesn't itself exclude today's-evening fixtures from the pending window —
// the exact trap that picking noon, or any hour before 18:41 UTC, would fall
// into on this file's fixtures.
const CLOCK_ANCHOR = Date.parse('2026-11-07T21:12:00.000Z');

// Relative so the suite doesn't rot out of the 10-day lookback, but the
// clock-time and date OFFSETS are the production ones.
const at = (daysAgo, h, m) => {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  d.setUTCHours(h, m, 0, 0);
  return d.toISOString();
};
const ymd = (iso, off = 0) =>
  new Date(new Date(iso).getTime() + off * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');

let db, degraded, lines, finals, schedule, box, slate, grading;
const fetched = [];   // every (path, date) getFinals was asked for, in order

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: CLOCK_ANCHOR });
  db = fakeDb({ monitor_scores: [], research_notes: [] });
  degraded = []; finals = {}; schedule = {}; box = null; slate = [];
  const fl = fakeLogger(); lines = fl.lines;
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger: fl.logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), { namedExports: { reportDegraded: (k, d) => degraded.push({ k, d }), getGames: () => slate } });
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: { rules: { unitDollars: 100 } } });
  mock.module(import.meta.resolve('../src/agents/shared/espn.js'), {
    namedExports: {
      getFinals: async (path, date) => { fetched.push(`${path}|${date}`); return finals[`${path}|${date}`] || []; },
      getSchedule: async (path, date) => schedule[`${path}|${date}`] || [],
      getBox: async () => box,
      getUfcResults: async () => [],
    },
  });
  grading = (await import('../src/agents/grading/index.js')).default;
});
after(() => { mock.timers.reset(); mock.reset(); });

beforeEach(() => {
  degraded.length = 0; lines.error.length = 0; lines.warn.length = 0;
  db.calls.select.length = 0; db.calls.update.length = 0;
  finals = {}; schedule = {}; box = null; slate = []; fetched.length = 0;
});

// ── Fault 1: the finals date window only looks BACKWARDS ─────────
// Plays are logged up to 36h before kickoff (the agent says so itself), but
// finals are only fetched for ymd(scored_at) and ymd(scored_at − 1 day). A play
// written the day before its game can never see its own final.
test('a play logged the day before kickoff still grades (NCAAF Tuesday MACtion)', async () => {
  const scored = at(4, 16, 27);                     // prod: 2026-11-03T16:27:02Z
  db.setRows('monitor_scores', [{
    id: 'ncaaf', game_id: 'g-toledo', sport: 'NCAAF', qualified: true, status: 'pending',
    market: 'spread', side: 'Sacramento State Hornets', line: 25.5,
    matchup: 'Toledo Rockets @ Sacramento State Hornets', scored_at: scored,
  }]);
  // The game was final on ESPN's 11-04 scoreboard, one day AFTER scored_at.
  finals[`football/college-football|${ymd(scored, 1)}`] = [{
    id: '401789', homeNick: 'hornets', awayNick: 'rockets',
    home_score: 17, away_score: 20, total: 37, overtime: false,
  }];
  // Same-day scoreboard had other games final — this is why the play counted as
  // "finals available" for its sport+date.
  finals[`football/college-football|${ymd(scored)}`] = [
    { id: '1', homeNick: 'zips', awayNick: 'bobcats', home_score: 20, away_score: 28, total: 48, overtime: false },
    { id: '2', homeNick: 'redhawks', awayNick: 'bulls', home_score: 31, away_score: 34, total: 65, overtime: true },
  ];

  const r = await grading.run();

  // Sac State +25.5, lost by 3 → covers.
  assert.equal(r.data.graded, 1, 'the final exists on ESPN; only the fetched date window missed it');
  assert.equal(db.rows('monitor_scores').find((x) => x.id === 'ncaaf').status, 'win');
});

// ── Fault 2: the alarm conflates "a finals list" with "these games" ──
// `withFinals` only asks whether the SPORT returned any finals across the
// fetched dates. On 11-07 NHL had returned the 11-06 slate plus two early
// 11-07 games, so three plays on 7:00/8:00 PM EST games that had not started
// counted as "finals available" — the exact daily false alert the alarm's own
// comment says it must not raise.
test('no alarm when the plays’ own games have not finished yet', async () => {
  const tonight = at(0, 15, 11);
  db.setRows('monitor_scores', [
    { id: 'n1', game_id: 'g1', sport: 'NHL', qualified: true, status: 'pending', market: 'prop', stat_type: 'player_shots_on_goal', player: 'Taylor Hall', side: 'OVER', line: 1.5, matchup: 'Chicago Blackhawks @ Carolina Hurricanes', scored_at: tonight },
    { id: 'n2', game_id: 'g2', sport: 'NHL', qualified: true, status: 'pending', market: 'prop', stat_type: 'player_shots_on_goal', player: 'Fabian Zetterlund', side: 'OVER', line: 1.5, matchup: 'Utah Mammoth @ Ottawa Senators', scored_at: tonight },
    { id: 'n3', game_id: 'g3', sport: 'NHL', qualified: true, status: 'pending', market: 'prop', stat_type: 'player_shots_on_goal', player: 'Barrett Hayton', side: 'UNDER', line: 2.5, matchup: 'Utah Mammoth @ Ottawa Senators', scored_at: tonight },
    { id: 'n4', game_id: 'g4', sport: 'NHL', qualified: true, status: 'pending', market: 'ml', side: 'Dallas Stars', matchup: 'San Jose Sharks @ Dallas Stars', scored_at: tonight },
    { id: 'n5', game_id: 'g5', sport: 'NHL', qualified: true, status: 'pending', market: 'ml', side: 'Colorado Avalanche', matchup: 'Detroit Red Wings @ Colorado Avalanche', scored_at: tonight },
  ]);
  // Yesterday's slate is final. None of these five games are in it.
  finals[`hockey/nhl|${ymd(tonight, -1)}`] = [
    { id: 'y1', homeNick: 'sabres', awayNick: 'blue jackets', home_score: 5, away_score: 2, total: 7, overtime: false },
    { id: 'y2', homeNick: 'wild', awayNick: 'sharks', home_score: 4, away_score: 1, total: 5, overtime: false },
    { id: 'y3', homeNick: 'flames', awayNick: 'ducks', home_score: 3, away_score: 5, total: 8, overtime: false },
  ];
  // Today's scoreboard: only the two afternoon games are final.
  finals[`hockey/nhl|${ymd(tonight)}`] = [
    { id: 't1', homeNick: 'capitals', awayNick: 'panthers', home_score: 4, away_score: 3, total: 7, overtime: false },
    { id: 't2', homeNick: 'predators', awayNick: 'blues', home_score: 3, away_score: 1, total: 4, overtime: false },
  ];

  const r = await grading.run();

  assert.equal(r.data.noFinal, 5, 'all five games are still scheduled');
  assert.deepEqual(degraded, [], 'games not having finished is not a grading defect');
  assert.equal(lines.error.length, 0);
});

// The alarm text is also stated as fact, so it has to be true. On 11-07 one of
// the five plays DID match its final (it failed later, in prop lookup), yet the
// alarm read "none of 5 plays matched a final".
test('the alarm never claims nothing matched when something did', async () => {
  // at(3), not at(6): the four unmatched plays have to be inside
  // UNRESOLVABLE_DAYS to be in the alarm population at all. Past that bound a
  // final that never arrived is a postponed game, not a matching bug — and a
  // play whose game is absent from every fetched date would otherwise re-raise
  // this same alarm on every run until the 30-day write-off. The test's intent
  // (a genuine matching failure alarms, and says truthfully what matched) is
  // unchanged; only the premise that it must alarm *forever* is dropped.
  const old = at(3, 3, 27);
  const rows = [{
    // Matches its final; prop stat lookup then fails → counted as noResult.
    id: 'm1', game_id: 'g-anaheim', sport: 'NHL', qualified: true, status: 'pending',
    market: 'prop', stat_type: 'player_shots_on_goal', player: 'Nobody Here', side: 'OVER', line: 1.5,
    matchup: 'Ottawa Senators @ Anaheim Ducks', scored_at: old,
  }];
  for (let i = 0; i < 4; i++) {
    rows.push({
      id: `x${i}`, game_id: `gx${i}`, sport: 'NHL', qualified: true, status: 'pending',
      market: 'ml', side: 'Mistyped Home', matchup: 'Mistyped Away @ Mistyped Home', scored_at: old,
    });
  }
  db.setRows('monitor_scores', rows);
  finals[`hockey/nhl|${ymd(old)}`] = [
    { id: '401892628', homeNick: 'ducks', awayNick: 'senators', home_score: 6, away_score: 3, total: 9, overtime: false },
  ];
  box = { players: [] };   // stat not found → gradeProp returns null

  const r = await grading.run();

  assert.equal(r.data.noResult, 1);
  assert.equal(r.data.noFinal, 4);
  const zero = degraded.find((d) => d.k === 'grading|zero');
  assert.ok(zero, 'this one IS a defect worth alarming on');
  assert.doesNotMatch(zero.d, /none of \d+ plays matched a final/,
    'one of the five matched its final — the alarm must not report otherwise');
});

// ── Fault 3: norm() lowercases but does not fold diacritics ──────
// The Odds API carries "Tim Stützle"; ESPN's boxscore displayName is
// "Tim Stutzle". nameMatch's surname fallback compares "stützle" to "stutzle"
// and fails, so the play is left pending forever rather than graded.
const NHL_SKATER_LABELS = ['BS', 'HT', 'TK', '+/-', 'TOI', 'PPTOI', 'SHTOI', 'ESTOI', 'SHFT', 'G', 'YTDG', 'A', 'S', 'SM', 'SOG', 'FW', 'FL', 'FO%', 'GV', 'PN', 'PIM'];
const skater = (displayName, stats) => ({ athlete: { displayName }, stats });

test('an accented player name matches ESPN’s unaccented displayName', async () => {
  const old = at(6, 3, 27);
  db.setRows('monitor_scores', [{
    id: 'stu', game_id: 'g-anaheim', sport: 'NHL', qualified: true, status: 'pending',
    market: 'prop', stat_type: 'player_shots_on_goal', player: 'Tim Stützle', side: 'OVER', line: 1.5,
    matchup: 'Ottawa Senators @ Anaheim Ducks', scored_at: old,
  }]);
  finals[`hockey/nhl|${ymd(old)}`] = [
    { id: '401892628', homeNick: 'ducks', awayNick: 'senators', home_score: 6, away_score: 3, total: 9, overtime: false },
  ];
  // Stützle's real line from ESPN event 401892628: S (shots on goal) = 1.
  box = { players: [{ statistics: [{ name: 'forwards', labels: NHL_SKATER_LABELS,
    athletes: [skater('Tim Stutzle', ['0', '3', '0', '0', '22:54', '4:06', '2:44', '16:04', '28', '0', '9', '0', '1', '2', '0', '9', '5', '64.3', '0', '1', '2'])] }] }] };

  const r = await grading.run();

  assert.equal(r.data.noResult, 0, 'the diacritic is the only thing between the play and its stat');
  assert.equal(r.data.graded, 1);
  assert.equal(db.rows('monitor_scores').find((x) => x.id === 'stu').status, 'loss', '1 shot, OVER 1.5');
});

// Stripping combining marks is only half the fold. Stroked and ligature
// letters (ø ł ß đ æ œ) are single precomposed code points — NFD leaves them
// exactly as they are — and the typographic apostrophe is a different code
// point from the ASCII quote. "Oliver Bjørkstrand" against ESPN's
// "Oliver Bjorkstrand" would therefore sit pending forever, with no diacritic
// anywhere in sight to explain why.
test('a stroked letter and a typographic apostrophe fold to ESPN’s spelling', async () => {
  const old = at(6, 3, 27);
  const prop = (id, player) => ({
    id, game_id: `g-${id}`, sport: 'NHL', qualified: true, status: 'pending',
    market: 'prop', stat_type: 'player_shots_on_goal', player, side: 'OVER', line: 1.5,
    matchup: 'Ottawa Senators @ Anaheim Ducks', scored_at: old,
  });
  db.setRows('monitor_scores', [
    prop('bjork', 'Oliver Bjørkstrand'),      // ESPN: "Oliver Bjorkstrand"
    prop('oreilly', 'Ryan O’Reilly'),         // U+2019; ESPN: "Ryan O'Reilly"
  ]);
  finals[`hockey/nhl|${ymd(old)}`] = [
    { id: '401892628', homeNick: 'ducks', awayNick: 'senators', home_score: 6, away_score: 3, total: 9, overtime: false },
  ];
  // S (shots on goal) = 4 for both.
  const line = ['0', '0', '1', '-1', '16:19', '3:27', '0:00', '12:52', '22', '0', '9', '1', '4', '0', '0', '0', '0', '0.0', '0', '0', '0'];
  box = { players: [{ statistics: [{ name: 'forwards', labels: NHL_SKATER_LABELS,
    athletes: [skater('Oliver Bjorkstrand', line), skater("Ryan O'Reilly", line)] }] }] };

  const r = await grading.run();

  assert.equal(r.data.noResult, 0, 'neither name has a combining mark NFD could strip');
  assert.equal(r.data.graded, 2);
  for (const id of ['bjork', 'oreilly']) {
    assert.equal(db.rows('monitor_scores').find((x) => x.id === id).status, 'win', `${id}: 4 shots, OVER 1.5`);
  }
});

// ── Fault 4 (separate, and worse — this one MIS-grades) ──────────
// In ESPN's NHL skater table 'S' is shotsTotal and 'SOG' is shootoutGoals
// (keys[14] === 'shootoutGoals'). STAT.player_shots_on_goal lists
// ['SOG', 'S', 'SH'] and statValue takes the FIRST label present, so every NHL
// shots-on-goal prop is graded against shootout goals — effectively always 0,
// so every OVER is written as a loss and every UNDER as a win.
test('NHL shots-on-goal grades against shots, not ESPN’s shootout-goals column', async () => {
  const old = at(6, 3, 27);
  db.setRows('monitor_scores', [{
    id: 'sog', game_id: 'g-anaheim', sport: 'NHL', qualified: true, status: 'pending',
    market: 'prop', stat_type: 'player_shots_on_goal', player: 'Drake Batherson', side: 'OVER', line: 1.5,
    matchup: 'Ottawa Senators @ Anaheim Ducks', scored_at: old,
  }]);
  finals[`hockey/nhl|${ymd(old)}`] = [
    { id: '401892628', homeNick: 'ducks', awayNick: 'senators', home_score: 6, away_score: 3, total: 9, overtime: false },
  ];
  // S = 4 shots on goal; SOG = 0 shootout goals.
  box = { players: [{ statistics: [{ name: 'forwards', labels: NHL_SKATER_LABELS,
    athletes: [skater('Drake Batherson', ['0', '0', '1', '-1', '16:19', '3:27', '0:00', '12:52', '22', '0', '9', '1', '4', '0', '0', '0', '0', '0.0', '0', '0', '0'])] }] }] };

  const r = await grading.run();

  assert.equal(r.data.graded, 1);
  assert.equal(db.rows('monitor_scores').find((x) => x.id === 'sog').status, 'win',
    '4 shots on goal beats OVER 1.5; reading the shootout column makes it a loss');
});

// ── The cost of the widened window ──────────────────────────────
// Reaching forwards is only acceptable because the fetch count is bounded by
// DISTINCT (sport, date) pairs, not by plays: the agent dedupes into a Map
// before fetching and shared/espn.js caches on that same `${path}|${date}` key.
// A whole evening's slate for one sport is therefore 4 requests, not 4 per play.
test('the widened date window costs 4 fetches per sport per slate, not 4 per play', async () => {
  const tonight = at(1, 23, 40);
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({
      id: `h${i}`, game_id: `gh${i}`, sport: 'NHL', qualified: true, status: 'pending',
      market: 'ml', side: `Home ${i}`, matchup: `Away ${i} @ Home ${i}`, scored_at: tonight,
    });
  }
  for (let i = 0; i < 20; i++) {
    rows.push({
      id: `c${i}`, game_id: `gc${i}`, sport: 'NCAAF', qualified: true, status: 'pending',
      market: 'ml', side: `Team ${i}`, matchup: `Visitor ${i} @ Team ${i}`, scored_at: tonight,
    });
  }
  db.setRows('monitor_scores', rows);

  await grading.run();

  assert.equal(fetched.length, new Set(fetched).size,
    'no (path, date) pair is ever fetched twice in one run');
  for (const path of ['hockey/nhl', 'football/college-football']) {
    const dates = fetched.filter((k) => k.startsWith(`${path}|`));
    assert.equal(dates.length, 4, `${path}: 50 plays on one slate cost 4 requests`);
  }
  // And they are the right four: two days forward (a play logged up to 36h
  // pre-kickoff, landing on the next UTC date) through one day back.
  assert.deepEqual(
    fetched.filter((k) => k.startsWith('hockey/nhl|')).sort(),
    [2, 1, 0, -1].map((off) => `hockey/nhl|${ymd(tonight, off)}`).sort(),
    'offsets are [+2, +1, 0, -1] from scored_at',
  );
});

// ── Fault 5 (the worst of the set — it writes WRONG results) ─────
// Finals are flattened per sport across all four fetched dates and matched by
// nickname with a bare `.find()`, so a matchup that appears on more than one
// board is a coin flip resolved by fetch order. DATE_OFFSETS starts at +2, the
// LATEST board, so the flip lands on the newest game in the window — and
// repeated matchups are routine, not exotic: an MLB series is the same two
// nicknames on three consecutive days, and NBA/NHL home-and-homes do it too.
// Reproduced before the fix: a game-1 Braves ML loss (2-3) sitting two days in
// the queue was written `win 4-2 +83.33` off game 3.
const mlbPlay = (over = {}) => ({
  id: 'mlb1', game_id: 'g-day1', sport: 'MLB', qualified: true, status: 'pending',
  market: 'ml', price: -120, side: 'Atlanta Braves',
  matchup: 'Atlanta Braves @ Cincinnati Reds', ...over,
});
const bravesAtReds = (id, away, home) => ({
  id, homeNick: 'reds', awayNick: 'braves',
  home_score: home, away_score: away, total: away + home, overtime: false,
});

test('a play in an MLB series grades against its OWN game, not a later one', async () => {
  const scored = at(4, 22, 0);
  db.setRows('monitor_scores', [mlbPlay({ scored_at: scored })]);
  finals[`baseball/mlb|${ymd(scored)}`] = [bravesAtReds('G1', 2, 3)];     // own game: Braves LOSE
  finals[`baseball/mlb|${ymd(scored, 1)}`] = [bravesAtReds('G2', 4, 2)];  // Braves win
  finals[`baseball/mlb|${ymd(scored, 2)}`] = [bravesAtReds('G3', 4, 2)];  // Braves win

  const r = await grading.run();
  const row = db.rows('monitor_scores').find((x) => x.id === 'mlb1');

  assert.equal(r.data.graded, 1);
  assert.equal(row.result_score, '2-3', 'game 1 is the play’s own game');
  assert.equal(row.status, 'loss', 'grading game 3 instead wrote a win and +83.33 of fictional P&L');
  assert.equal(row.pnl, -100);
});

// When the odds slate still holds the game, its commence_time is the real
// answer and beats the scored_at heuristic. This is the pre-kickoff case the
// [+2,+1,0,-1] window exists for: the play was logged the evening BEFORE its
// game, so same-day-as-scored_at is the wrong board even though it has the
// matchup on it.
test('the slate’s own commence_time decides which game in the series is the play’s', async () => {
  const scored = at(3, 23, 30);
  db.setRows('monitor_scores', [mlbPlay({ scored_at: scored })]);
  slate = [{ game_id: 'g-day1', sport: 'MLB', commence_time: new Date(Date.parse(scored) + 86400_000).toISOString() }];
  finals[`baseball/mlb|${ymd(scored)}`] = [bravesAtReds('G1', 4, 2)];     // night before: Braves won
  finals[`baseball/mlb|${ymd(scored, 1)}`] = [bravesAtReds('G2', 1, 7)];  // the play's game
  finals[`baseball/mlb|${ymd(scored, 2)}`] = [bravesAtReds('G3', 4, 2)];

  const r = await grading.run();
  const row = db.rows('monitor_scores').find((x) => x.id === 'mlb1');

  assert.equal(r.data.graded, 1);
  assert.equal(row.result_score, '1-7', 'the slate said the game is tomorrow');
  assert.equal(row.status, 'loss');
});

// An MLB doubleheader is two different games with one matchup on one date, and
// nothing left in the row distinguishes them. A guess is right half the time,
// which is worse than useless in a track record — so the play stays pending and
// is counted, not silently dropped.
test('two equally close finals leave the play pending and are counted, never guessed', async () => {
  const scored = at(4, 22, 0);
  db.setRows('monitor_scores', [mlbPlay({ scored_at: scored })]);
  finals[`baseball/mlb|${ymd(scored)}`] = [
    bravesAtReds('DH1', 2, 3),   // game 1: Braves lose
    bravesAtReds('DH2', 7, 1),   // game 2: Braves win
  ];

  const r = await grading.run();
  const row = db.rows('monitor_scores').find((x) => x.id === 'mlb1');

  assert.equal(row.status, 'pending', 'honest pending beats a 50/50 W or L');
  assert.equal(r.data.graded, 0);
  assert.equal(r.data.ambiguousFinal, 1, 'and it is counted, so it cannot hide');
  assert.match(r.summary, /1 ambiguous final/);
  assert.deepEqual(degraded, [], 'declining to guess is a decision, not a failure to alarm on');
});

// ── Fault 6a (D111 #1) — the slate still knows the kickoff, and it disagrees ──
// When the play's game is still on the odds slate, its real commence_time is
// ground truth. A final whose own start time is hours away from that is not
// this play's game at all — checkable directly, no need for the schedule
// fallback below (which only applies once the slate no longer has the game).
test('a final whose kickoff is hours from the play’s own slate time is rejected, not guessed', async () => {
  const scored = at(4, 22, 0);
  const day = scored.slice(0, 10);
  const g1Start = `${day}T17:10:00.000Z`, g2Start = `${day}T23:10:00.000Z`;
  db.setRows('monitor_scores', [mlbPlay({ game_id: 'g-day2', scored_at: scored })]);
  // The play's OWN game (game 2) is still on the slate — its real kickoff is known.
  slate = [{ game_id: 'g-day2', sport: 'MLB', commence_time: g2Start }];
  // Only game 1 has a final, and it started 6h before the play's own kickoff.
  finals[`baseball/mlb|${ymd(scored)}`] = [{ ...bravesAtReds('G1', 2, 3), startTime: g1Start }];

  const r = await grading.run();
  const row = db.rows('monitor_scores').find((x) => x.id === 'mlb1');

  assert.equal(r.data.graded, 0, 'the only final on offer started 6h away from this play’s real kickoff');
  assert.equal(r.data.wrongSlot, 1);
  assert.equal(row.status, 'pending');
  assert.deepEqual(degraded, [], 'declining to guess is a decision, not a failure to alarm on');
});

// ── Fault 6b (D111 #1) — a doubleheader where only game 1 is final ──
// getFinals filters to `comp.status.type.completed`, so a doubleheader with
// game 2 still in progress yields exactly ONE completed event for the
// matchup — hits.length === 1, which the pre-D111 code treated as "no
// ambiguity" and graded straight through. Reproduced in prod: a game-2 play
// (game_id 'g-day2') silently graded off game 1's score, 'ambiguousFinal: 0'.
// Unlike 6a, the play's game has already rolled OFF the odds slate by the
// time grading runs (routine for an in-progress game) — no commence_time to
// check directly, so this is the scheduled-count fallback (D111 #1 part b).
test('a game-2 play rolled off the slate is left pending, not graded off game 1’s score', async () => {
  const scored = at(4, 22, 0);
  const day = scored.slice(0, 10);
  const g1Start = `${day}T17:10:00.000Z`, g2Start = `${day}T23:10:00.000Z`;
  db.setRows('monitor_scores', [mlbPlay({ game_id: 'g-day2', scored_at: scored })]);
  // Only game 1 has gone final; game 2 is still live, so getFinals never
  // surfaces it — exactly the production shape.
  finals[`baseball/mlb|${ymd(scored)}`] = [{ ...bravesAtReds('G1', 2, 3), startTime: g1Start }];
  // The board DOES know about two scheduled games for this matchup today —
  // this is what tells pickFinal "one final" isn't "one game".
  schedule[`baseball/mlb|${ymd(scored)}`] = [
    { homeNick: 'reds', awayNick: 'braves', startTime: g1Start, completed: true },
    { homeNick: 'reds', awayNick: 'braves', startTime: g2Start, completed: false },
  ];

  const r = await grading.run();
  const row = db.rows('monitor_scores').find((x) => x.id === 'mlb1');

  assert.equal(r.data.graded, 0, 'game 1’s final must not be written onto the game-2 play');
  assert.equal(r.data.wrongSlot, 1, 'and it is counted, so it cannot hide');
  assert.equal(row.status, 'pending');
  assert.deepEqual(degraded, [], 'declining to guess is a decision, not a failure to alarm on');
});

// Same doubleheader, same board — but THIS play is game 1's own play, and the
// odds slate still knows its real kickoff. The start-time match lets it grade
// normally even though the schedule shows two games for the matchup.
test('the game-1 play in the same doubleheader still grades, off its own start time', async () => {
  const scored = at(4, 22, 0);
  const day = scored.slice(0, 10);
  const g1Start = `${day}T17:10:00.000Z`, g2Start = `${day}T23:10:00.000Z`;
  db.setRows('monitor_scores', [mlbPlay({ game_id: 'g-day1', scored_at: scored })]);
  slate = [{ game_id: 'g-day1', sport: 'MLB', commence_time: g1Start }];
  finals[`baseball/mlb|${ymd(scored)}`] = [{ ...bravesAtReds('G1', 2, 3), startTime: g1Start }];
  schedule[`baseball/mlb|${ymd(scored)}`] = [
    { homeNick: 'reds', awayNick: 'braves', startTime: g1Start, completed: true },
    { homeNick: 'reds', awayNick: 'braves', startTime: g2Start, completed: false },
  ];

  const r = await grading.run();
  const row = db.rows('monitor_scores').find((x) => x.id === 'mlb1');

  assert.equal(r.data.graded, 1, 'the slate’s own kickoff confirms this really is game 1');
  assert.equal(row.result_score, '2-3');
  assert.equal(row.status, 'loss');
});

// research_notes had the identical bug on the identical finals, writing the
// wrong game into a second, separately published track record.
test('research picks get the same date-aware pick, not the newest board', async () => {
  const created = at(4, 22, 0);
  db.setRows('monitor_scores', []);
  db.setRows('research_notes', [{
    id: 'r1', type: 'pick', status: 'pending', sport: 'MLB', market: 'ml', odds: -120,
    side: 'Atlanta Braves', matchup: 'Atlanta Braves @ Cincinnati Reds', created_at: created,
  }]);
  finals[`baseball/mlb|${ymd(created)}`] = [bravesAtReds('G1', 2, 3)];
  finals[`baseball/mlb|${ymd(created, 1)}`] = [bravesAtReds('G2', 4, 2)];
  finals[`baseball/mlb|${ymd(created, 2)}`] = [bravesAtReds('G3', 4, 2)];

  const r = await grading.run();
  const row = db.rows('research_notes').find((x) => x.id === 'r1');

  assert.equal(r.data.research, 1);
  assert.equal(row.result_score, '2-3');
  assert.equal(row.status, 'loss');
});
