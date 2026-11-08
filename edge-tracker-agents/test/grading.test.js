// ══════════════════════════════════════════════════════════════
// Grading — the queue shape, and that "graded 0" explains itself.
//
// The fault these cover is a head-of-line block, not a matching bug: the
// pending select had an upper bound but no LOWER bound and took `limit: 80`
// oldest-first, so once 80 never-gradeable rows accumulated they held the head
// of the queue permanently and no newer play was ever reached. opp-grading was
// unaffected only because it windows on a 30h lookback.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const D = (daysAgo) => new Date(Date.now() - daysAgo * 86400_000).toISOString();

// ESPN returns a final for the Falcons @ Ravens game only.
const RAVENS = { id: '1', homeNick: 'ravens', awayNick: 'falcons', home_score: 24, away_score: 17, total: 41, overtime: false };

// `slate` stands in for the in-memory odds slate: grading reads it to learn
// a play's own game date when the matchup repeats inside the fetch window.
let db, degraded, lines, finals, slate, grading;

before(async () => {
  db = fakeDb({ monitor_scores: [], research_notes: [] });
  degraded = []; finals = []; slate = [];
  const fl = fakeLogger(); lines = fl.lines;
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger: fl.logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), { namedExports: { reportDegraded: (k, d) => degraded.push({ k, d }), getGames: () => slate } });
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: { rules: { unitDollars: 100 } } });
  mock.module(import.meta.resolve('../src/agents/shared/espn.js'), {
    namedExports: {
      getFinals: async () => finals, getSchedule: async () => [],
      getBox: async () => null, getUfcResults: async () => [],
    },
  });
  grading = (await import('../src/agents/grading/index.js')).default;
});
after(() => mock.reset());

beforeEach(() => {
  degraded.length = 0; lines.error.length = 0; lines.warn.length = 0;
  db.calls.select.length = 0; db.calls.update.length = 0;
  slate = [];
});

const playRow = (over = {}) => ({
  id: 'p', game_id: 'g', sport: 'NFL', qualified: true, status: 'pending', market: 'total',
  side: 'Under', line: 44.5, matchup: 'Atlanta Falcons @ Baltimore Ravens', scored_at: D(1), ...over,
});

// ── The head-of-line block ──────────────────────────────────────
test('80 ungradeable rows no longer starve a fresh, gradeable play', async () => {
  const blockers = Array.from({ length: 80 }, (_, i) => playRow({
    id: `old${i}`, game_id: `g${i}`, sport: 'MLB',
    matchup: 'Ghost Team @ Phantom Club', scored_at: D(60 + i),   // ESPN serves nothing this old
  }));
  const fresh = playRow({ id: 'fresh', game_id: 'fresh-g' });
  db.setRows('monitor_scores', [...blockers, fresh]);
  finals = [RAVENS];

  const r = await grading.run();

  assert.equal(r.data.graded, 1, 'the fresh play must be graded');
  assert.equal(db.rows('monitor_scores').find((x) => x.id === 'fresh').status, 'win');
  assert.equal(r.data.expired, 80, 'and the blockers retired out of the pool');
});

test('the queue is windowed and ordered newest-first', async () => {
  db.setRows('monitor_scores', [playRow()]);
  finals = [RAVENS];
  await grading.run();

  const q = db.calls.select.find((c) => c.table === 'monitor_scores' && c.opts.order && c.opts.lte);
  assert.ok(q.opts.gte, 'a lower bound is what stops the queue stalling forever');
  assert.equal(q.opts.order.ascending, false, 'newest-first guarantees fresh plays are reached');
  assert.ok(q.opts.in?.sport?.includes('NFL'), 'sports with no grading track are excluded in the QUERY');
});

test('expired rows never outrank a fresh pending row when deduping', async () => {
  // A rescheduled game: the original play aged out and was retired, then a new
  // pending row was written for the same game/market/side. Keeping the expired
  // one would delete the only gradeable copy.
  db.setRows('monitor_scores', [
    playRow({ id: 'old', status: 'expired', scored_at: D(20) }),
    playRow({ id: 'new', status: 'pending', scored_at: D(1) }),
  ]);
  finals = [RAVENS];
  await grading.run();

  const survivors = db.rows('monitor_scores');
  assert.ok(survivors.some((r) => r.id === 'new'), 'the pending row must survive dedupe');
  assert.equal(survivors.find((r) => r.id === 'new').status, 'win');
});

// ── "graded 0" has to explain itself ────────────────────────────
test('the summary carries per-stage counters even when nothing grades', async () => {
  db.setRows('monitor_scores', [playRow({ matchup: 'Mistyped Away @ Mistyped Home' })]);
  finals = [RAVENS];
  const r = await grading.run();
  assert.match(r.summary, /1 queued/, 'queued count is always visible');
  assert.match(r.summary, /1 no final/, 'and why each play was skipped');
  assert.equal(r.data.noFinal, 1);
});

// ── Alarm precision: the thing that decides whether this is useful ──
// D(3), not D(1): the alarm population is no longer "the sport returned some
// finals" (true every day — that fired daily as a false positive) but "this
// play's own game is certainly over". The odds slate reaches 36h ahead
// (odds/index.js:1098), so a play logged 24h ago may still be 12h PRE-kickoff
// and cannot be evidence of anything. Past the 48h settle window it can.
test('alarms when ESPN had finals and nothing matched — a real matching bug', async () => {
  db.setRows('monitor_scores', Array.from({ length: 6 }, (_, i) => playRow({
    id: `p${i}`, game_id: `g${i}`, matchup: 'Mistyped Away @ Mistyped Home', scored_at: D(3),
  })));
  finals = [RAVENS];
  await grading.run();
  assert.ok(degraded.some((d) => d.k === 'grading|zero'));
  assert.equal(lines.error.length, 1);
});

test('stays quiet when ESPN has no finals yet — the normal afternoon run', async () => {
  // Plays are logged up to 36h before kickoff while the queue cutoff is only
  // scored_at-3.5h, so "queued but 0 graded" is the ORDINARY state. Alarming on
  // it would mean a false alert every single day.
  db.setRows('monitor_scores', Array.from({ length: 6 }, (_, i) => playRow({ id: `p${i}`, game_id: `g${i}` })));
  finals = [];
  await grading.run();
  assert.equal(degraded.length, 0, 'games simply have not finished — not a defect');
});

// The floor has to bind on the SIZE of the population, not on the population
// being empty. This test used to pass with plays at D(1), i.e. still inside the
// 48h settle window — suspect was 0, so ZERO_ALARM_MIN was never consulted and
// the assertion held no matter what the constant was set to. Ageing the fixture
// past SETTLED_HOURS puts the plays genuinely in the alarm population, and the
// two halves straddle the floor so the constant is what decides the outcome.
test('the sample floor binds: 4 unmatched plays stay quiet, 5 alarm', async () => {
  // Distinct game_ids, or dedupe would collapse them before the floor is reached.
  const unmatched = (n) => Array.from({ length: n }, (_, i) => playRow({
    id: `f${i}`, game_id: `gf${i}`, matchup: 'Mistyped Away @ Mistyped Home', scored_at: D(3),
  }));

  db.setRows('monitor_scores', unmatched(4));
  finals = [RAVENS];
  let r = await grading.run();
  assert.equal(r.data.noFinalSettled, 4, 'all four really are in the alarm population');
  assert.equal(degraded.length, 0, 'four is below ZERO_ALARM_MIN — quiet, but not vacuously');

  degraded.length = 0; lines.error.length = 0;
  db.setRows('monitor_scores', unmatched(5));
  r = await grading.run();
  assert.equal(r.data.noFinalSettled, 5);
  assert.ok(degraded.some((d) => d.k === 'grading|zero'), 'the fifth crosses the floor');
});

// ── Postponed games must leave the alarm population ─────────────
// A play whose game is absent from every fetched date is noFinalSettled on
// every run from 48h until the 30-day write-off. For a postponed or cancelled
// game the final never arrives, so that is the same daily false alarm the
// settle window was introduced to remove, just 25 days long instead.
test('a play with no final anywhere stops being an alarm once it is clearly postponed', async () => {
  db.setRows('monitor_scores', Array.from({ length: 6 }, (_, i) => playRow({
    id: `ppd${i}`, game_id: `gp${i}`, matchup: 'Postponed Away @ Postponed Home', scored_at: D(7),
  })));
  finals = [RAVENS];
  const r = await grading.run();

  assert.equal(r.data.unresolvable, 6, 'past the bound, a permanently missing final is not evidence');
  assert.equal(r.data.noFinalSettled, 0);
  assert.deepEqual(degraded, [], 'six postponed games must not re-alarm every run for 25 days');
  assert.match(r.summary, /6 unresolvable/, 'and they stay visible rather than vanishing');
  assert.equal(db.rows('monitor_scores').find((x) => x.id === 'ppd0').status, 'pending',
    'honestly pending — not written off');
});

test('an empty queue is reported as empty, not as a failure', async () => {
  db.setRows('monitor_scores', []);
  finals = [];
  const r = await grading.run();
  assert.match(r.summary, /no completed plays to grade/);
  assert.equal(degraded.length, 0);
});

test('plays are abandoned on a much longer clock than they stop being attempted', async () => {
  // A grader outage between the two thresholds must lose nothing. 20 days is
  // past the 10-day attempt window but well inside the 30-day write-off.
  db.setRows('monitor_scores', [playRow({ id: 'midway', scored_at: D(20) })]);
  finals = [RAVENS];
  await grading.run();
  assert.equal(db.rows('monitor_scores').find((r) => r.id === 'midway').status, 'pending',
    'not attempted, but not written off either');
});

test('a bulk write-off is reported, not just warned', async () => {
  // The one destructive thing this agent does. Expected once as cleanup; if it
  // recurs, real results are being abandoned.
  db.setRows('monitor_scores', Array.from({ length: 30 }, (_, i) => playRow({
    id: `ancient${i}`, game_id: `g${i}`, scored_at: D(90 + i),
  })));
  finals = [];
  await grading.run();
  assert.ok(degraded.some((d) => d.k === 'grading|expired-bulk'), 'writing off 30 plays must be loud');
  assert.equal(lines.error.length, 1);
});
