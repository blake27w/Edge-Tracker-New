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

let db, degraded, lines, finals, grading;

before(async () => {
  db = fakeDb({ monitor_scores: [], research_notes: [] });
  degraded = []; finals = [];
  const fl = fakeLogger(); lines = fl.lines;
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger: fl.logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), { namedExports: { reportDegraded: (k, d) => degraded.push({ k, d }) } });
  mock.module(import.meta.resolve('../src/config/index.js'), { defaultExport: { rules: { unitDollars: 100 } } });
  mock.module(import.meta.resolve('../src/agents/shared/espn.js'), {
    namedExports: { getFinals: async () => finals, getBox: async () => null, getUfcResults: async () => [] },
  });
  grading = (await import('../src/agents/grading/index.js')).default;
});
after(() => mock.reset());

beforeEach(() => {
  degraded.length = 0; lines.error.length = 0; lines.warn.length = 0;
  db.calls.select.length = 0; db.calls.update.length = 0;
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
test('alarms when ESPN had finals and nothing matched — a real matching bug', async () => {
  db.setRows('monitor_scores', Array.from({ length: 6 }, (_, i) => playRow({
    id: `p${i}`, game_id: `g${i}`, matchup: 'Mistyped Away @ Mistyped Home',
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

test('stays quiet below the sample floor', async () => {
  db.setRows('monitor_scores', [playRow({ matchup: 'Mistyped Away @ Mistyped Home' })]);
  finals = [RAVENS];
  await grading.run();
  assert.equal(degraded.length, 0, 'one unmatched play is not evidence of a bug');
});

test('an empty queue is reported as empty, not as a failure', async () => {
  db.setRows('monitor_scores', []);
  finals = [];
  const r = await grading.run();
  assert.match(r.summary, /no completed plays to grade/);
  assert.equal(degraded.length, 0);
});
