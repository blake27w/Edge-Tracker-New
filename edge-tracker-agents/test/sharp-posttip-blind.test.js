// ══════════════════════════════════════════════════════════════
// Post-tip blindness is REPORTED, not hidden (D107).
//
// D102 shortened the odds agent's post-tip polling tail to 45 minutes for any
// sport with no in-play consumer. Past that tail a started game's sport sits at
// MID or IDLE × the pace governor, so every `line_movements` row it produces
// carries a gap of 45-720 minutes — and every one of those is beyond
// STEAM_MAX_GAP_MIN (35), so `steamSafeMovements` rejects all of them.
//
// The budget saving is kept. What is not acceptable is the sentence it printed:
// three books moving the same market the same way an hour after tip came out as
// `0 steam · 3 rows / 0 gap-eligible`, which is what a QUIET market prints. The
// verdict has to distinguish "nothing moved" from "I can no longer see this
// market move" — the house rule this agent already follows for its other six
// summaries.
//
// The bound itself is correct and is NOT widened here: a 45-minute gap genuinely
// cannot prove three books moved together (D92), and admitting governed-tier
// gaps would be the D77 conflation it exists to prevent.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './helpers/fake-db.js';

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const pg = (ms) => iso(ms).replace('Z', '+00:00');

let fdb, store, sharp;
const realNow = Date.now;
let clock = realNow();

before(async () => {
  Date.now = () => clock;
  fdb = fakeDb({ line_movements: [] });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb, namedExports: { isMissingRelation: fdb.isMissingRelation },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: { info: () => {}, warn: () => {}, error: () => {} }, notifyAll: async () => ({ total: 0 }) },
  });
  store = await import('../src/store/index.js');
  const s = await import('../src/agents/sharp/index.js');
  sharp = s.default;
  sharp.__reset = s.__resetSharp;
});
after(() => { Date.now = realNow; mock.reset(); });

beforeEach(() => {
  clock = realNow();
  fdb.fail = {};
  fdb.isConnected = () => true;
  fdb.setRows('line_movements', []);
  fdb.setRows('sharp_signals', []);
  store.setIntel('movements', []);
  store.setIntel('sharp', []);
  sharp.__reset();
});

const BOOKS = ['draftkings', 'fanduel', 'betmgm'];
// The one market move, as three books: same market/side/direction, same
// instant, so the ONLY thing separating steam from not-steam is the gap.
const triple = (gapMin, atMs, gameId = 'g1') => BOOKS.map((book) => ({
  book, sport: 'NBA', game_id: gameId, market: 'totals', side: 'Over', direction: 'down',
  line_open: '220.5', line_current: '220', moved: '-0.5',
  gap_min: String(gapMin), detected_at: pg(atMs),
}));

// `tipped` minutes ago (negative = starts in |tipped| minutes).
const gameTipped = (tipped, gameId = 'g1') => ({
  game_id: gameId, sport: 'NBA', commence_time: iso(clock - tipped * MIN),
});

test('three co-directional rows at gap 60 on a STARTED game: not steam, and the summary says why', async () => {
  // The exact post-D102 shape: NBA tipped 90 min ago, so the sport dropped to
  // MID 45 min after the tip and its rows now carry a 60-minute gap.
  store.setGames([gameTipped(90)]);
  fdb.setRows('line_movements', triple(60, clock - 5 * MIN));

  const r = await sharp.run();
  assert.equal(r.data.signals, 0, 'a 60-minute gap cannot prove simultaneity — the bound is right');
  assert.equal(r.data.rows, 3);
  assert.equal(r.data.eligible, 0);
  assert.equal(r.data.postTipBeyondBound, 3, 'the rows that exist and can never be steam, counted');
  assert.equal(r.data.postTipBlindGames, 1, 'and the started game left with nothing eligible');
  assert.match(r.summary, /1 started game beyond steam bound \(3 rows, post-tip tail\)/,
    'its OWN segment: `0 steam · 3 rows / 0 gap-eligible` alone is what a quiet market prints');
});

test('the same three rows PRE-tip at gap 10 are steam — nothing about the bound changed', async () => {
  store.setGames([gameTipped(-30)]);                       // starts in 30 min
  fdb.setRows('line_movements', triple(10, clock - 5 * MIN));

  const r = await sharp.run();
  assert.equal(r.data.signals, 1, 'three books, one instant, a STRIKE-tier gap: steam');
  assert.equal(r.data.eligible, 3);
  assert.equal(r.data.postTipBeyondBound, 0);
  assert.equal(r.data.postTipBlindGames, 0);
  assert.doesNotMatch(r.summary, /post-tip tail/, 'and no blindness to report');
});

test('a PRE-tip game with wide gaps is not post-tip blindness — the segment names the real cause only', async () => {
  // Rehydrated pre-game drift: beyond the bound, correctly rejected, but the
  // post-tip tail had nothing to do with it. Attributing it to the tail would
  // make the segment mean "some rows were wide", which is not a fault at all.
  store.setGames([gameTipped(-120)]);
  fdb.setRows('line_movements', triple(90, clock - 5 * MIN));

  const r = await sharp.run();
  assert.equal(r.data.eligible, 0);
  assert.equal(r.data.postTipBlindGames, 0);
  assert.doesNotMatch(r.summary, /post-tip tail/);
});

test('a started game still inside the 45-min tail reports nothing — the window is doing its job', async () => {
  store.setGames([gameTipped(20)]);
  fdb.setRows('line_movements', triple(4, clock - 2 * MIN));

  const r = await sharp.run();
  assert.equal(r.data.signals, 1, 'this is the post-tip steam the 45-minute tail is paid for');
  assert.equal(r.data.postTipBlindGames, 0);
  assert.doesNotMatch(r.summary, /post-tip tail/);
});

test('a started game with SOME eligible rows is not blind — it can still be seen', async () => {
  store.setGames([gameTipped(90)]);
  fdb.setRows('line_movements', [
    ...triple(60, clock - 30 * MIN),
    ...triple(4, clock - 2 * MIN),
  ]);

  const r = await sharp.run();
  assert.equal(r.data.postTipBlindGames, 0, 'eligible rows arrived for this game, so nothing is hidden');
  assert.equal(r.data.postTipBeyondBound, 0, 'and the wide rows are not a blind spot on their own');
  assert.doesNotMatch(r.summary, /post-tip tail/);
});

test('null-gap rows stay the WRITER fault they already were — two claims about one row is one too many', async () => {
  // A started game whose rows all carry gap_min null is the blind state the
  // no-gap summary already owns (D73/D93). Counting it as post-tip blindness
  // too would blame the tail for a column the writer stripped.
  store.setGames([gameTipped(90)]);
  fdb.setRows('line_movements', triple(60, clock - 5 * MIN).map((r) => ({ ...r, gap_min: null })));

  const r = await sharp.run();
  assert.match(r.summary, /none carry gap_min/);
  assert.equal(r.data.postTipBlindGames, 0);
  assert.equal(r.data.postTipBeyondBound, 0);
  assert.doesNotMatch(r.summary, /post-tip tail/);
});

test('two started games blinded the same way are counted as two, with their rows', async () => {
  store.setGames([gameTipped(90, 'g1'), gameTipped(120, 'g2')]);
  fdb.setRows('line_movements', [
    ...triple(60, clock - 5 * MIN, 'g1'),
    ...triple(300, clock - 5 * MIN, 'g2').slice(0, 2),     // IDLE × governor gaps
  ]);

  const r = await sharp.run();
  assert.equal(r.data.postTipBlindGames, 2);
  assert.equal(r.data.postTipBeyondBound, 5);
  assert.match(r.summary, /2 started games beyond steam bound \(5 rows, post-tip tail\)/);
});

test('the segment survives a failed history read — memory-only rows are blinded the same way', async () => {
  store.setGames([gameTipped(90)]);
  fdb.fail = { 'select:line_movements': new Error('canceling statement due to statement timeout') };
  store.setIntel('movements', triple(60, clock - 5 * MIN).map((r) => ({
    ...r, gap_min: 60, line_open: 220.5, line_current: 220, moved: -0.5, detected_at: iso(clock - 5 * MIN),
  })));

  const r = await sharp.run();
  assert.match(r.summary, /^blind — history read failed/, 'the read failure is still the headline');
  assert.match(r.summary, /1 started game beyond steam bound \(3 rows, post-tip tail\)/,
    'and the second blind spot is reported alongside it, not instead of it');
});

test('counters carry the two new keys as zeros even in the states that compute nothing', async () => {
  store.setGames([]);
  const r = await sharp.run();
  assert.equal(r.summary, 'dormant — empty slate');
  assert.equal(r.data.postTipBeyondBound, 0, 'a missing key and a zero must not be confused on /health');
  assert.equal(r.data.postTipBlindGames, 0);
});
