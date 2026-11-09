// ══════════════════════════════════════════════════════════════
// Opportunity grading — the same wrong-game defect D109.1 fixed in `grading`,
// reproduced in its sibling.
//
// opp-grading fetched finals for [0, −1, +1] around each flag's own date and
// flattened them per sport with no date kept, then matched with a bare
// `.find()` on nicknames. A matchup that repeats inside that window — an MLB
// series, an NBA/NHL home-and-home — was therefore settled against whichever
// game happened to be fetched first, which is fetch order, not the flag's
// game. These rows feed the Record tab's "what works" rubric, so a wrong
// settle does not just mis-state one flag: it credits or blames the wrong
// scanner.
//
// The flag rows carry a BETTER date than grading's plays do (`when` is
// commence_time where the opportunity row has one), so the fix is to reuse
// grading's pickFinal rather than re-derive it.
//
// Line 80 also lowercased the matchup with raw `.toLowerCase()` while
// shared/espn.js folds its nicknames, so a nickname whose Odds API spelling
// carries a stroked letter or a typographic apostrophe could never meet the
// ESPN side of the `includes()` at all.
//
// getFinals is keyed by (path, date) here, as in grading-match.test.js: the
// whole defect is which board a final came from, so a mock that ignores the
// date cannot see it.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

// Relative so the suite doesn't rot out of the 30h lookback. `fetched_at` has
// to be inside that window; `commence_time` is independent of it and is what
// decides which board is the flag's own.
const day = (off, h = 23, m = 10) => {
  const d = new Date(Date.now() + off * 86400_000);
  d.setUTCHours(h, m, 0, 0);
  return d.toISOString();
};
const ymd = (iso) => new Date(iso).toISOString().slice(0, 10).replace(/-/g, '');

let db, lines, finals, slate, opp;

before(async () => {
  db = fakeDb({ ev_opportunities: [], line_signals: [], opp_results: [] });
  finals = {}; slate = [];
  const fl = fakeLogger(); lines = fl.lines;
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger: fl.logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), { namedExports: { reportDegraded: () => {}, getGames: () => slate } });
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: { rules: { unitDollars: 100 } } });
  mock.module(import.meta.resolve('../src/agents/shared/espn.js'), {
    namedExports: {
      getFinals: async (path, date) => finals[`${path}|${date}`] || [],
      getSchedule: async () => [],
      getBox: async () => null,
      getUfcResults: async () => [],
    },
  });
  opp = (await import('../src/agents/opp-grading/index.js')).default;
});
after(() => mock.reset());

beforeEach(() => {
  lines.warn.length = 0; lines.error.length = 0;
  db.setRows('ev_opportunities', []); db.setRows('line_signals', []); db.setRows('opp_results', []);
  db.calls.insert.length = 0;
  finals = {}; slate = [];
});

// A +EV flag row, as ev_opportunities stores it. `fetched_at` is now (inside
// LOOKBACK_H); `commence_time` is the game's real start, which fromEv passes
// through as the flag's `when`.
const evFlag = (game_id, commence_time) => ({
  sport: 'MLB', game_id, matchup: 'Atlanta Braves @ Cincinnati Reds',
  market: 'ml', side: 'Atlanta Braves', price: -120, ev_pct: 4.2, book: 'fanduel',
  fair_price: -140, fetched_at: day(0, 12, 0), commence_time,
});
const bravesAtReds = (id, away, home) => ({
  id, homeNick: 'reds', awayNick: 'braves',
  home_score: home, away_score: away, total: away + home, overtime: false,
});
const resultFor = (game_id) => db.rows('opp_results').find((r) => r.game_id === game_id);

// ── The defect: a repeated matchup settled by fetch order ────────
// Two flags on the same two nicknames, two days apart — games 1 and 3 of a
// series. The game-3 flag is listed first, so its board is fetched first and
// the flattened list leads with game 3's final. Under the bare `.find()` the
// game-1 flag was settled against game 3: Braves lost game 1 by one run and
// would have been credited a win.
test('each flag in an MLB series settles against its OWN game, not the first board fetched', async () => {
  const g3when = day(1), g1when = day(-1);
  db.setRows('ev_opportunities', [evFlag('g-day3', g3when), evFlag('g-day1', g1when)]);
  finals[`baseball/mlb|${ymd(g1when)}`] = [bravesAtReds('G1', 2, 3)];   // game 1: Braves LOSE
  finals[`baseball/mlb|${ymd(day(0))}`] = [bravesAtReds('G2', 4, 2)];   // game 2: Braves win
  finals[`baseball/mlb|${ymd(g3when)}`] = [bravesAtReds('G3', 4, 2)];   // game 3: Braves win

  const r = await opp.run();

  assert.equal(r.data.graded, 2);
  assert.equal(r.data.ambiguousFinal, 0, 'the series games are on different dates — nothing is ambiguous');
  assert.equal(resultFor('g-day1').status, 'loss', 'game 1 is the game-1 flag’s own game (2-3)');
  assert.equal(resultFor('g-day1').pnl, -100);
  assert.equal(resultFor('g-day3').status, 'win', 'and game 3 is the game-3 flag’s (4-2)');
});

// An MLB doubleheader is two games with one matchup on one date, and nothing
// in the flag row distinguishes them. Picking either is right half the time,
// which is worse than useless in a record published as "what works" — so the
// flag goes unsettled and is COUNTED, not silently dropped.
test('two equally close finals leave the flag ungraded and counted, never guessed', async () => {
  const when = day(-1);
  db.setRows('ev_opportunities', [evFlag('g-dh', when)]);
  finals[`baseball/mlb|${ymd(when)}`] = [
    bravesAtReds('DH1', 2, 3),   // game 1: Braves lose
    bravesAtReds('DH2', 7, 1),   // game 2: Braves win
  ];

  const r = await opp.run();

  assert.equal(r.data.graded, 0, 'honest ungraded beats a 50/50 W or L');
  assert.equal(r.data.ambiguousFinal, 1, 'and it is counted, so it cannot hide');
  assert.match(r.summary, /1 matched two finals equally closely/);
  assert.deepEqual(db.calls.insert, [], 'nothing is written to opp_results');
  assert.equal(lines.error.length, 0, 'declining to guess is a decision, not a failure');
});

// ── The second half: the nickname match skipped the fold ─────────
// shared/espn.js folds its team nicknames (ø→o, U+2019→'), so the ESPN side of
// the `includes()` arrives folded while the Odds API matchup does not. Raw
// `.toLowerCase()` on this side therefore made the comparison unsatisfiable:
// "bjørkstrand ..." can never contain "bjorkstrand ...". These are the exact
// two code points D109.3 names, exercised where opp-grading actually matches —
// the team nickname.
test('a stroked letter and a typographic apostrophe fold on both sides of the nickname match', async () => {
  const when = day(-1);
  db.setRows('ev_opportunities', [{
    sport: 'NHL', game_id: 'g-fold', matchup: 'Bjørkstrand Islanders @ O’Reilly Kings',
    market: 'ml', side: 'O’Reilly Kings', price: -150, ev_pct: 3.1, book: 'draftkings',
    fair_price: -175, fetched_at: day(0, 12, 0), commence_time: when,
  }]);
  // As shared/espn.js yields them: already folded.
  finals[`hockey/nhl|${ymd(when)}`] = [{
    id: '401892628', homeNick: "o'reilly kings", awayNick: 'bjorkstrand islanders',
    home_score: 4, away_score: 2, total: 6, overtime: false,
  }];

  const r = await opp.run();

  assert.equal(r.data.graded, 1, 'neither character has a combining mark NFD could strip');
  assert.equal(resultFor('g-fold').status, 'win', 'the Kings won 4-2');
});
