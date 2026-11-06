// ══════════════════════════════════════════════════════════════
// sharp reads bounded line_movements history, and steam is SIMULTANEITY.
//
// The old agent read only the most recent odds run's in-memory array and said
// `no recent line movement` for 13,000+ runs. The reader fixes the blindness;
// the interval test keeps the fix from becoming D77's corruption at history
// scale: a per-row gap filter proves each row's own baseline was recent, not
// that three books moved at the same time as EACH OTHER. The decisive negative
// below — three books, small gaps, intervals that do not overlap — is the case
// a gap-filter-only reader calls steam.
//
// Asserted on query SHAPE as well as results (test/README.md): one select per
// game on the composite index, never `in: { game_id }`.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './helpers/fake-db.js';

const MIN = 60_000;
const H = 3600_000;
let now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// Postgres hands timestamps back with an offset, numerics as strings.
const pg = (ms) => iso(ms).replace('Z', '+00:00');

let fdb, orch, store, sharp, hist, odds, watchdog;
const warns = [], infos = [];

before(async () => {
  fdb = fakeDb({ line_movements: [] });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb, namedExports: { isMissingRelation: fdb.isMissingRelation },
  });
  // The orchestrator imports every agent, so the utils fixture has to carry
  // every export they reach for (agent-blocked.test.js pattern).
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: {
        info: (a, m) => infos.push(`${a}: ${m}`),
        warn: (a, m) => warns.push(`${a}: ${m}`),
        error: () => {},
      },
      notifyAll: async () => ({ total: 0 }),
      getFeed: () => [], getMetrics: () => ({}),
      getClaudeUsage: async () => ({ projectedMonthly: 0 }),
      hasClaude: () => false,
      claudeBlockReason: () => 'ANTHROPIC_API_KEY is not set in this deployment',
      detectModel: async () => null, parseJson: () => null,
      claude: async () => '', claudeJson: async () => null,
      sendSms: async () => ({ total: 0 }), sendEmail: async () => ({ total: 0 }),
    },
  });
  // Real config and store: the orchestrator's blocked path and the store's
  // degraded view are both under test.
  store = await import('../src/store/index.js');
  orch = await import('../src/orchestrator/index.js');
  odds = await import('../src/agents/odds/index.js');
  hist = await import('../src/agents/sharp/history.js');
  const s = await import('../src/agents/sharp/index.js');
  sharp = s.default;
  sharp.__reset = s.__resetSharp;
  watchdog = (await import('../src/agents/watchdog/index.js')).default;
});
after(() => { try { orch.stop(); } catch (_) { /* ignore */ } mock.reset(); });

const game = (id, offsetMs = 20 * MIN) => ({ game_id: id, sport: 'A', commence_time: iso(now + offsetMs) });
const row = (o = {}) => ({
  sport: 'A', game_id: 'g1', market: 'totals', side: 'Over', direction: 'down', book: 'draftkings',
  line_open: '44.5', line_current: '43.5', moved: '-1', gap_min: '10', detected_at: pg(now - 1 * MIN), ...o,
});
const BOOKS = ['draftkings', 'fanduel', 'betmgm'];
const sigInserts = () => fdb.calls.insert.filter((c) => c.table === 'sharp_signals');
const histSelects = () => fdb.calls.select.filter((c) => c.table === 'line_movements');

beforeEach(() => {
  now = Date.now();
  warns.length = 0; infos.length = 0;
  fdb.calls.select.length = 0; fdb.calls.insert.length = 0;
  fdb.fail = {};
  fdb.isConnected = () => true;
  fdb.setRows('line_movements', []);
  store.setGames([game('g1')]);
  store.setIntel('movements', []);
  store.setIntel('sharp', []);
  sharp.__reset();
  for (const d of store.getDegraded()) store.clearDegraded(d.key);
});

// ── Query shape ─────────────────────────────────────────────────
test('one bounded select per game on the composite index, capped at HIST_MAX_GAMES', async () => {
  store.setGames(Array.from({ length: 40 }, (_, i) => game(`g${i}`, (i + 1) * MIN)));
  const res = await sharp.run();
  const sel = histSelects();
  assert.equal(sel.length, 24, `40-game slate → exactly HIST_MAX_GAMES selects (${res.summary})`);
  assert.equal(hist.HIST_MAX_GAMES, 24);
  for (const c of sel) {
    assert.equal(c.table, 'line_movements');
    assert.ok(c.opts.match && typeof c.opts.match.game_id === 'string', 'match carries the game_id equality');
    assert.ok(c.opts.gte && c.opts.gte.detected_at, 'a lower bound on detected_at');
    assert.equal(c.opts.order.column, 'detected_at');
    assert.equal(c.opts.order.ascending, false, 'newest first');
    assert.equal(c.opts.limit, 400);
    assert.equal(c.opts.in, undefined, 'never in: { game_id: [...] } — cannot use the composite index (D71)');
    assert.ok(/\bgap_min\b/.test(c.cols), 'gap_min is selected — the reader checks it itself');
    assert.ok(!/baseline_source/.test(c.cols), 'a hand-run column in the projection fails the whole select');
  }
  assert.equal(new Set(sel.map((c) => c.opts.match.game_id)).size, 24, 'one select per distinct game');
  assert.equal(res.data.queried, 24);
  assert.equal(res.data.games, 24);
});

test('the slate is kickoff-windowed: upcoming soonest-first, then started freshest-first', () => {
  const games = [game('late', 30 * H), game('soon', 5 * MIN), game('later', 60 * MIN),
    game('started', -10 * MIN), game('old', -4 * H), game('justStarted', -1 * MIN), { game_id: 'nokick' }];
  assert.deepEqual(hist.selectSlate(games, now).map((g) => g.game_id), ['soon', 'later', 'justStarted', 'started']);
  assert.deepEqual(hist.selectSlate(games, now, 2).map((g) => g.game_id), ['soon', 'later']);
});

// ── The decisive negative ───────────────────────────────────────
test('three books with small gaps whose intervals do NOT overlap are not steam', async () => {
  // Each row's own baseline is recent (gap 10), but the three moves happened in
  // disjoint ten-minute intervals: [t-10,t], [t-25,t-15], [t-40,t-30]. Every
  // per-row test passes; a gap-filter-only reader calls this steam. It is not.
  fdb.setRows('line_movements', BOOKS.map((book, i) => row({ book, detected_at: pg(now - i * 15 * MIN) })));
  const res = await sharp.run();
  assert.match(res.summary, /^0 steam · 3 rows \/ 3 gap-eligible \/ 0 simultaneous clusters · 1 games · history\+memory$/, res.summary);
  assert.equal(res.data.clusters, 0);
  assert.equal(res.data.eligible, 3, 'every row passed the per-row bound — that is the point');
  assert.equal(sigInserts().length, 0, 'nothing fabricated into sharp_signals');
  assert.equal(store.getIntel('sharp').length, 0);
});

test('the pure test: gap 30 at three books two hours apart is not one market move', () => {
  const rows = BOOKS.map((book, i) => hist.normalizeRow(row({ book, gap_min: 30, detected_at: pg(now - i * 2 * H) })));
  assert.equal(hist.findSteamClusters(rows, { minBooks: 3 }).length, 0);
  // Same rows, same gaps, stamped together: steam. The gap is not the variable.
  const together = BOOKS.map((book) => hist.normalizeRow(row({ book, gap_min: 30 })));
  assert.equal(hist.findSteamClusters(together, { minBooks: 3 }).length, 1);
});

// ── The decisive positive ───────────────────────────────────────
test('three books, gap 10, within three minutes → one steam signal with its width', async () => {
  fdb.setRows('line_movements', BOOKS.map((book, i) => row({ book, detected_at: pg(now - i * MIN) })));
  const res = await sharp.run();
  assert.match(res.summary, /^1 steam · 3 rows \/ 3 gap-eligible \/ 1 markets · 1 games · history\+memory · window 45m$/, res.summary);
  const sg = store.getIntel('sharp');
  assert.equal(sg.length, 1);
  assert.equal(sg[0].signal_type, 'steam');
  assert.deepEqual(sg[0].books, [...BOOKS].sort());
  assert.equal(sg[0].side, 'Under', 'a coordinated DOWN move on a total is Under money');
  // Intersection of [t-11,t-1], [t-12,t-2], [t-13,t-3] is [t-11,t-3]: 8 minutes.
  assert.match(sg[0].detail, /^3 books moved totals Over down \(avg 1\.0\) within 8m · history$/, sg[0].detail);
  assert.equal(sigInserts().length, 1);
  assert.equal(sigInserts()[0].rows.length, 1);
  assert.equal(res.data.inserted, 1);
});

// ── Boundary ────────────────────────────────────────────────────
test('lo === hi is steam; one second apart is not', () => {
  // [t-10,t], [t-5,t+5], [t,t+10] share exactly the instant t.
  const t = now - 20 * MIN;
  const touching = [row({ book: 'a', detected_at: pg(t) }), row({ book: 'b', detected_at: pg(t + 5 * MIN) }),
    row({ book: 'c', detected_at: pg(t + 10 * MIN) })].map((r) => hist.normalizeRow(r));
  const c = hist.findSteamClusters(touching, { minBooks: 3 });
  assert.equal(c.length, 1);
  assert.equal(c[0].lo, c[0].hi);
  assert.equal(c[0].widthMin, 0);
  const apart = [row({ book: 'a', detected_at: pg(t) }), row({ book: 'b', detected_at: pg(t + 5 * MIN) }),
    row({ book: 'c', detected_at: pg(t + 10 * MIN + 1000) })].map((r) => hist.normalizeRow(r));
  assert.equal(hist.findSteamClusters(apart, { minBooks: 3 }).length, 0, 'lo is one second past hi');
});

// ── The per-row bound still governs the union ───────────────────
test('identical detected_at with gap 300 is not steam — the per-row bound is applied to the union', async () => {
  fdb.setRows('line_movements', BOOKS.map((book) => row({ book, gap_min: '300' })));
  const res = await sharp.run();
  assert.match(res.summary, /^0 steam · 3 rows \/ 0 gap-eligible \/ 0 simultaneous clusters/, res.summary);
  assert.equal(sigInserts().length, 0);
});

test('two books are not steam, and neither are two plus one the other way', async () => {
  fdb.setRows('line_movements', BOOKS.slice(0, 2).map((book) => row({ book })));
  assert.match((await sharp.run()).summary, /^0 steam · 2 rows/);
  fdb.setRows('line_movements', [...BOOKS.slice(0, 2).map((book) => row({ book })),
    row({ book: 'betmgm', direction: 'up', line_current: '45.5', moved: '1' })]);
  const res = await sharp.run();
  assert.match(res.summary, /^0 steam · 3 rows \/ 3 gap-eligible \/ 0 simultaneous clusters/, 'direction is in the key, not a vote');
  assert.equal(sigInserts().length, 0);
});

// ── Null and junk gaps ──────────────────────────────────────────
test('null and junk gap_min rows are counted as preFix, never aggregated', async () => {
  const junk = [null, '', '  ', [], false, true, -5, 'soon'];
  fdb.setRows('line_movements', [
    ...junk.map((g, i) => row({ book: `junk${i}`, gap_min: g })),
    ...BOOKS.map((book) => row({ book })),
  ]);
  const res = await sharp.run();
  assert.equal(res.data.preFix, junk.length, `every junk shape is dropped and counted (${res.summary})`);
  assert.equal(res.data.rows, junk.length + 3);
  assert.equal(res.data.eligible, 3);
  assert.equal(res.data.signals, 1, 'the three real rows are still steam');
  assert.deepEqual(store.getIntel('sharp')[0].books, [...BOOKS].sort(), 'no junk book joins the cluster');
  assert.equal(res.blocked, undefined);
});

test('a window where no row carries gap_min is a writer fault: blind, and blocked', async () => {
  fdb.setRows('line_movements', BOOKS.map((book) => row({ book, gap_min: null })));
  const res = await sharp.run();
  assert.equal(res.summary, 'blind — 3 rows in the last 45m, none carry gap_min (writer is stripping it — see odds log)');
  assert.equal(res.blocked, true);
  assert.equal(res.data.preFix, 3);
  assert.equal(sigInserts().length, 0);
});

// ── Read failure: the breaker, through the real orchestrator ────
test('a persistent read failure is reported as blocked after 3 runs, then probes one game', async () => {
  store.setGames([game('g1'), game('g2', 25 * MIN), game('g3', 30 * MIN)]);
  fdb.fail['select:line_movements'] = new Error('canceling statement due to statement timeout');
  const degraded = () => store.getDegraded().filter((d) => d.key === 'sharp|blocked');

  for (const n of [1, 2]) {
    await orch.runAgentOnceForTest(sharp);
    const h = orch.getHealth().find((x) => x.name === 'sharp');
    assert.equal(h.lastResult, 'blind — history read failed for 3/3 games', `run ${n} is visibly blind`);
    assert.equal(h.blockedRuns, 0, `run ${n} is not yet blocked — one timeout is transient`);
    assert.equal(degraded().length, 0);
  }
  await orch.runAgentOnceForTest(sharp);
  const h3 = orch.getHealth().find((x) => x.name === 'sharp');
  assert.equal(h3.lastResult, 'blind — history read failed for 3/3 games, 3 consecutive runs');
  assert.equal(h3.blockedRuns, 1, 'run 3 opts in via blocked: true');
  assert.equal(degraded().length, 1, 'the orchestrator reported it — no reportDegraded of sharp\'s own');
  assert.match(degraded()[0].detail, /not doing its job — blind — history read failed/);
  await watchdog.run();
  const issue = ((store.getWatchdog() || {}).issues || []).find((i) => i.key === 'data|sharp|blocked');
  assert.ok(issue, 'the watchdog sees it');
  assert.equal(issue.type, 'blocked');

  // Run 4: breaker open, exactly HIST_PROBE_GAMES selects.
  fdb.calls.select.length = 0;
  await orch.runAgentOnceForTest(sharp);
  assert.equal(histSelects().length, 1, 'a distressed table sees one probe, not 24');

  // A read succeeds: the next run clears everything.
  fdb.fail = {};
  fdb.calls.select.length = 0;
  await orch.runAgentOnceForTest(sharp);
  const h5 = orch.getHealth().find((x) => x.name === 'sharp');
  assert.match(h5.lastResult, /^0 steam · 0 movement rows in the last 45m across 3 games · history\+memory$/);
  assert.equal(h5.blockedRuns, 0);
  assert.equal(degraded().length, 0, 'retracted on the first unblocked run');
  assert.equal(histSelects().length, 1, 'the probe run is the one that succeeded; the full slate resumes next run');
  fdb.calls.select.length = 0;
  await sharp.run();
  assert.equal(histSelects().length, 3, 'breaker closed — the full slate again');
});

test('one game failing of three still emits, and the failure is printed', async () => {
  store.setGames([game('g1'), game('g2', 25 * MIN), game('g3', 30 * MIN)]);
  fdb.setRows('line_movements', BOOKS.map((book) => row({ book })));
  const orig = fdb.select;
  fdb.select = async (t, c, o) => {
    if (o.match && o.match.game_id === 'g2') throw new Error('timeout');
    return orig(t, c, o);
  };
  try {
    const res = await sharp.run();
    assert.match(res.summary, /^1 steam · 3 rows \/ 3 gap-eligible \/ 1 markets · 3 games · history\+memory · window 45m, 1 read failure$/, res.summary);
    assert.equal(res.blocked, undefined);
    assert.equal(res.data.failures, 1);
    assert.ok(warns.some((w) => /sharp: line_movements read failed for g2/.test(w)), 'each failure is logged');
  } finally { fdb.select = orig; }
});

// ── Merge and dedupe ────────────────────────────────────────────
test('the same move in history and the in-memory feed counts once', async () => {
  const rows = BOOKS.map((book) => row({ book }));
  fdb.setRows('line_movements', rows);
  // The memory row is what movementFrom publishes: numbers, an ISO stamp.
  store.setIntel('movements', rows.map((r) => ({ ...r, line_open: 44.5, line_current: 43.5, moved: -1, gap_min: 10, detected_at: iso(Date.parse(r.detected_at)) })));
  const res = await sharp.run();
  assert.equal(res.data.rows, 3, `deduped on the natural key (${res.summary})`);
  assert.equal(res.data.signals, 1);
  assert.match(store.getIntel('sharp')[0].detail, /· history$/, 'a row seen in both counts as history');
});

test('with no DB the memory feed alone forms a cluster, and the summary says so', async () => {
  fdb.isConnected = () => false;
  store.setIntel('movements', BOOKS.map((book) => ({ ...row({ book }), gap_min: 10, detected_at: iso(now - MIN) })));
  const res = await sharp.run();
  assert.equal(histSelects().length, 0);
  assert.match(res.summary, /^1 steam · 3 rows \/ 3 gap-eligible \/ 1 markets · 1 games · memory · window 45m$/, res.summary);
  assert.equal(res.data.source, 'memory');
  assert.match(store.getIntel('sharp')[0].detail, /· memory$/);
});

test('movementFrom stamps detected_at from the nowMs it is given', () => {
  const t = now - 7 * MIN;
  const cur = { sport: 'A', game_id: 'g1', market: 'totals', book: 'draftkings', side: 'Over', line: 43.5, price: -110 };
  const v = odds.movementFrom({ line: 44.5, price: -110, at: t - 4 * MIN, source: 'in-process' }, cur, t);
  assert.equal(v.move.detected_at, new Date(t).toISOString(), 'the memory row carries the same interval the Postgres row does');
  assert.equal(v.move.gap_min, 4);
});

// ── Re-emission ─────────────────────────────────────────────────
test('an unchanged window inserts once across runs; a fourth book re-emits', async () => {
  fdb.setRows('line_movements', BOOKS.map((book) => row({ book })));
  await sharp.run();
  const r2 = await sharp.run();
  assert.equal(sigInserts().length, 1, 'the second run re-derives the cluster but does not re-insert');
  assert.equal(r2.data.inserted, 0);
  assert.equal(store.getIntel('sharp').length, 1, 'but the live set is republished every run');

  fdb.setRows('line_movements', [...BOOKS, 'caesars'].map((book) => row({ book })));
  const r3 = await sharp.run();
  assert.equal(sigInserts().length, 2, 'a cluster that gains a book is a stronger claim and re-emits');
  assert.equal(r3.data.inserted, 1);
  assert.equal(store.getIntel('sharp')[0].books.length, 4);
});

// ── The seven states are seven different sentences ──────────────
test('all seven summaries are distinct, and no regex confuses "nothing moved" with "cannot see"', async () => {
  const out = {};
  store.setGames([]);
  out.dormant = (await sharp.run()).summary;

  store.setGames([game('g1')]);
  fdb.isConnected = () => false;
  out.noFeed = (await sharp.run()).summary;
  fdb.isConnected = () => true;

  sharp.__reset();
  fdb.fail['select:line_movements'] = new Error('timeout');
  await sharp.run(); await sharp.run();
  const rf = await sharp.run();
  out.readFailed = rf.summary;
  assert.equal(rf.blocked, true);
  fdb.fail = {}; sharp.__reset();

  fdb.setRows('line_movements', BOOKS.map((book) => row({ book, gap_min: null })));
  const ng = await sharp.run();
  out.nullGap = ng.summary;
  assert.equal(ng.blocked, true);

  fdb.setRows('line_movements', []);
  out.empty = (await sharp.run()).summary;

  fdb.setRows('line_movements', BOOKS.map((book, i) => row({ book, detected_at: pg(now - i * 15 * MIN) })));
  out.noCluster = (await sharp.run()).summary;

  fdb.setRows('line_movements', BOOKS.map((book) => row({ book })));
  out.success = (await sharp.run()).summary;

  const all = Object.values(out);
  assert.equal(new Set(all).size, 7, `seven distinct strings:\n${all.join('\n')}`);
  assert.ok(!all.includes('no recent line movement'), 'the old sentence is gone');
  const blind = ['noFeed', 'readFailed', 'nullGap'];
  for (const [k, s] of Object.entries(out)) {
    assert.equal(/^blind —/.test(s), blind.includes(k), `${k}: "${s}" — the dashboard keys on /^blind —/`);
    assert.equal(/^0 steam · /.test(s), ['empty', 'noCluster'].includes(k), `${k}: only a real zero starts "0 steam"`);
  }
  assert.ok(/^0 steam · 0 movement rows/.test(out.empty));
  assert.ok(/^0 steam · 3 rows/.test(out.noCluster));
  assert.ok(/^1 steam · /.test(out.success));
  assert.equal(out.dormant, 'dormant — empty slate');
  assert.equal(out.noFeed, 'blind — no DB and no in-memory feed');
});
