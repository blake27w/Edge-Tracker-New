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

// Relative so the suite doesn't rot out of the 10-day lookback, but the
// clock-time and date OFFSETS are the production ones.
const at = (daysAgo, h, m) => {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  d.setUTCHours(h, m, 0, 0);
  return d.toISOString();
};
const ymd = (iso, off = 0) =>
  new Date(new Date(iso).getTime() + off * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');

let db, degraded, lines, finals, box, grading;
const fetched = [];   // every (path, date) getFinals was asked for, in order

before(async () => {
  db = fakeDb({ monitor_scores: [], research_notes: [] });
  degraded = []; finals = {}; box = null;
  const fl = fakeLogger(); lines = fl.lines;
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger: fl.logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), { namedExports: { reportDegraded: (k, d) => degraded.push({ k, d }) } });
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: { rules: { unitDollars: 100 } } });
  mock.module(import.meta.resolve('../src/agents/shared/espn.js'), {
    namedExports: {
      getFinals: async (path, date) => { fetched.push(`${path}|${date}`); return finals[`${path}|${date}`] || []; },
      getBox: async () => box,
      getUfcResults: async () => [],
    },
  });
  grading = (await import('../src/agents/grading/index.js')).default;
});
after(() => mock.reset());

beforeEach(() => {
  degraded.length = 0; lines.error.length = 0; lines.warn.length = 0;
  db.calls.select.length = 0; db.calls.update.length = 0;
  finals = {}; box = null; fetched.length = 0;
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
  const old = at(6, 3, 27);
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
