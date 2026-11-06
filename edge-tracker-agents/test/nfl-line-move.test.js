// ══════════════════════════════════════════════════════════════
// Open→close line movement for every sport on the slate (D95).
//
// The agent is named `nfl-line-move` and the table `nfl_line_moves` on
// purpose — run history, the durable blocked fields on /health and an env
// override all key on the name. What these pin is the BEHAVIOUR: sports come
// from the slate, a null move is never a 0 move, the query shapes stay
// bounded and never touch the 7M-row snapshot table, and the two blocked
// conditions surface as constant literals through the orchestrator.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const T = (minsFromNow) => new Date(Date.now() + minsFromNow * 60_000).toISOString();
const DAYS = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

// One book is enough for computeMarkets: the consensus is the median of one.
const game = (sport, id, { total, spread, ml, kick = 180 } = {}) => {
  const mk = {};
  if (total != null) { mk['totals:Over'] = { line: total, price: -110 }; mk['totals:Under'] = { line: total, price: -110 }; }
  if (spread != null) mk['spreads:HOME'] = { line: spread, price: -110 };
  if (ml != null) { mk['h2h:HOME'] = { price: ml }; mk['h2h:AWAY'] = { price: -ml }; }
  return { sport, game_id: id, home: 'HOME', away: 'AWAY', commence_time: T(kick), books: { dk: { label: 'DK', markets: mk } } };
};
// Postgres hands numerics back as STRINGS — the fixture does too.
const opener = (game_id, market, line) => ({ game_id, market, line: line == null ? null : String(line) });

let db, slate, published, mod, OPENERS_BLOCKED, SCHEMA_BLOCKED;

before(async () => {
  db = fakeDb();
  const { logger } = fakeLogger();
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: { getGames: () => slate, setNflLineMove: (r) => { published = r; } },
  });
  mod = await import('../src/agents/nfl-line-move/index.js');
  ({ OPENERS_BLOCKED, SCHEMA_BLOCKED } = mod);
});
after(() => mock.reset());
beforeEach(() => {
  slate = []; published = undefined; db.fail = {};
  db.setRows('opening_lines', []); db.setRows('nfl_line_moves', []);
  for (const k of Object.keys(db.calls)) db.calls[k].length = 0;
});

const selectsOn = (t) => db.calls.select.filter((c) => c.table === t);

// ── 1. Sports come from the slate ───────────────────────────────
test('three sports on the slate → rows carry sport, bySport has three entries, UFC is ML-only', async () => {
  slate = [
    game('NFL', 'nfl1', { total: 45.5, spread: -3, ml: -150 }),
    game('NBA', 'nba1', { total: 222.5, spread: -5.5, ml: -200 }),
    game('UFC', 'ufc1', { ml: -130 }),
  ];
  db.setRows('opening_lines', [
    opener('nfl1', 'total', 44), opener('nfl1', 'spread', -2.5), opener('nfl1', 'ml', -140),
    opener('nba1', 'total', 224), opener('nba1', 'spread', -6), opener('nba1', 'ml', -210),
    opener('ufc1', 'ml', -110),
  ]);
  db.setRows('nfl_line_moves', [
    { sport: 'NFL', total_move: -1, spread_move: 0.5, ml_move: null, captured_at: DAYS(1) },
    { sport: 'NBA', total_move: 2, spread_move: null, ml_move: 1.2, captured_at: DAYS(2) },
    { sport: 'UFC', total_move: null, spread_move: null, ml_move: -3, captured_at: DAYS(3) },
  ]);
  const r = await mod.default.run();
  assert.equal(r.blocked, undefined);
  assert.match(r.summary, /^3 games · 3 sports \(0 new closes\) · 3 in history$/);
  assert.deepEqual(published.live.map((x) => x.sport).sort(), ['NBA', 'NFL', 'UFC']);
  assert.deepEqual(published.bySport.map((b) => b.sport).sort(), ['NBA', 'NFL', 'UFC']);
  const ufc = published.live.find((x) => x.sport === 'UFC');
  assert.equal(ufc.open_total, null); assert.equal(ufc.total_move, null);
  assert.equal(ufc.open_spread, null); assert.equal(ufc.spread_move, null);
  assert.equal(ufc.open_ml, -110); assert.equal(ufc.close_ml, -130);
  assert.ok(ufc.ml_move > 0, 'home shortened from -110 to -130 → positive');
  const nfl = published.live.find((x) => x.sport === 'NFL');
  assert.equal(nfl.total_move, 1.5); assert.equal(nfl.spread_move, -0.5);
  assert.equal(published.agg.n, 3);
  assert.equal(published.bySport.find((b) => b.sport === 'UFC').ml_avg_abs, 3);
});

// ── 2. ml_move in implied-probability points; null never 0 ──────
test('ml_move: -110 → -130 is ≈ +4.1 pp; a null opener yields null, never 0', async () => {
  slate = [game('NHL', 'a', { ml: -130 }), game('NHL', 'b', { ml: -130 })];
  db.setRows('opening_lines', [opener('a', 'ml', -110), opener('b', 'ml', null)]);
  await mod.default.run();
  const a = published.live.find((x) => x.game_id === 'a');
  const b = published.live.find((x) => x.game_id === 'b');
  assert.equal(a.ml_move, 4.1);
  assert.equal(b.open_ml, null);
  assert.equal(b.ml_move, null, 'impliedProb(null) is silently 0 — the call site must guard');
});

test('an opener that is null or an empty string is a null move, not a 0 move', async () => {
  slate = [game('MLB', 'm', { total: 8.5, spread: -1.5 })];
  db.setRows('opening_lines', [opener('m', 'total', null), { game_id: 'm', market: 'spread', line: '' }]);
  await mod.default.run();
  const m = published.live[0];
  assert.equal(m.open_total, null); assert.equal(m.total_move, null);
  assert.equal(m.open_spread, null); assert.equal(m.spread_move, null);
});

// ── 3. History: a null move is excluded from every aggregate ────
test('history rows with a null total_move do not count toward total_down_pct or total_avg_abs', async () => {
  slate = [game('NFL', 'x', { total: 40 })];
  db.setRows('nfl_line_moves', [
    { sport: 'NFL', total_move: '-2', spread_move: null, ml_move: null, captured_at: DAYS(1) },
    { sport: 'NFL', total_move: null, spread_move: null, ml_move: null, captured_at: DAYS(1) },
    { sport: 'NFL', total_move: null, spread_move: null, ml_move: null, captured_at: DAYS(1) },
  ]);
  await mod.default.run();
  assert.equal(published.agg.n, 3);
  assert.equal(published.agg.total_down_pct, 100, 'one real move, down — not 33.3% with two phantom zeros');
  assert.equal(published.agg.total_avg_abs, 2, 'not 0.7');
  assert.equal(published.agg.spread_avg_abs, null);
  assert.equal(published.agg.ml_avg_abs, null);
});

test('legacy history rows with no sport are bucketed as NFL', async () => {
  slate = [game('NFL', 'x', { total: 40 })];
  db.setRows('nfl_line_moves', [{ total_move: -1, spread_move: 1, captured_at: DAYS(1) }]);
  await mod.default.run();
  assert.deepEqual(published.bySport.map((b) => b.sport), ['NFL']);
});

// ── 4. Query shape ──────────────────────────────────────────────
test('history query is bounded (gte captured_at, desc, limit ≤ 4000); openers are chunked; no movement table is read', async () => {
  slate = Array.from({ length: 250 }, (_, i) => game('NCAAB', `g${i}`, { total: 140 }));
  await mod.default.run();
  const hist = selectsOn('nfl_line_moves').find((c) => c.opts.order);
  assert.ok(hist, 'a history read happened');
  assert.ok(hist.opts.gte && hist.opts.gte.captured_at, 'lower bound present');
  assert.ok(Date.now() - new Date(hist.opts.gte.captured_at).getTime() <= 181 * 86_400_000, '~180d window');
  assert.equal(hist.opts.order.column, 'captured_at');
  assert.equal(hist.opts.order.ascending, false);
  assert.ok(hist.opts.limit <= 4000, `limit ${hist.opts.limit}`);
  assert.match(hist.cols, /sport/); assert.match(hist.cols, /ml_move/);
  const opens = selectsOn('opening_lines');
  assert.equal(opens.length, 3, '250 ids → 3 calls of ≤100');
  for (const c of opens) assert.ok(c.opts.in.game_id.length <= 100, `chunk of ${c.opts.in.game_id.length}`);
  assert.equal(new Set(opens.flatMap((c) => c.opts.in.game_id)).size, 250, 'every id asked once');
  assert.equal(selectsOn('line_snapshots').length, 0);
  assert.equal(selectsOn('line_movements').length, 0);
});

// ── 5. Openers unreadable → blocked, constant literal ───────────
test('opening_lines unreadable → blocked === OPENERS_BLOCKED and the store is cleared', async () => {
  slate = [game('NBA', 'n', { total: 220 })];
  published = { stale: true };
  db.fail['select:opening_lines'] = new Error('fetch failed');
  const r = await mod.default.run();
  assert.equal(r.blocked, OPENERS_BLOCKED);
  assert.equal(OPENERS_BLOCKED, 'opening_lines could not be read');
  assert.equal(published, null);
  assert.equal(db.calls.insert.length, 0);
});

// ── 6. Missing columns → strip-and-retry, blocked === SCHEMA_BLOCKED ──
test('a "column does not exist" insert error retries once without the four new columns and reports SCHEMA_BLOCKED', async () => {
  slate = [game('NFL', 'k', { total: 47, spread: -3, ml: -120, kick: 10 })]; // ≤30m to kickoff → a close
  db.setRows('opening_lines', [opener('k', 'total', 45), opener('k', 'spread', -2.5), opener('k', 'ml', -110)]);
  let n = 0;
  const realInsert = db.insert;
  db.insert = async (t, rows) => {
    db.calls.insert.push({ table: t, rows });
    if (++n === 1) throw new Error('column "sport" of relation "nfl_line_moves" does not exist');
    return realInsert.call(db, t, rows);
  };
  try {
    const r = await mod.default.run();
    assert.equal(r.blocked, SCHEMA_BLOCKED);
    assert.equal(SCHEMA_BLOCKED, 'nfl_line_moves is missing the all-sports columns — run the schema.sql block');
    assert.equal(db.calls.insert.length, 3, 'first attempt, the retry, and the fake-db re-entry');
    const first = db.calls.insert[0].rows[0], retry = db.calls.insert[1].rows[0];
    assert.equal(first.sport, 'NFL'); assert.equal(first.ml_move, 2.2, '-110 → -120 is +2.2 pp');
    for (const c of ['sport', 'open_ml', 'close_ml', 'ml_move']) assert.ok(!(c in retry), `${c} must be stripped`);
    assert.equal(retry.total_move, 2); assert.equal(retry.game_id, 'k');
    assert.ok(published && published.live, 'the run still publishes');
  } finally { db.insert = realInsert; }
});

test('a non-column insert error is logged, not retried, and does not block', async () => {
  slate = [game('NFL', 'k2', { total: 47, kick: 10 })];
  db.setRows('opening_lines', [opener('k2', 'total', 45)]);
  db.fail['insert:nfl_line_moves'] = new Error('network timeout');
  const r = await mod.default.run();
  assert.equal(r.blocked, undefined);
  assert.equal(db.calls.insert.length, 1);
});

test('a close is persisted once with sport and the ML leg; a second run does not re-insert', async () => {
  slate = [game('SOCCER', 's', { total: 2.5, ml: +150, kick: 5 })];
  db.setRows('opening_lines', [opener('s', 'total', 2.5), opener('s', 'ml', 130)]);
  await mod.default.run();
  assert.equal(db.calls.insert.length, 1);
  const row = db.calls.insert[0].rows[0];
  assert.equal(row.sport, 'SOCCER'); assert.equal(row.open_ml, 130); assert.equal(row.close_ml, 150);
  assert.ok(row.ml_move < 0, '+130 → +150 is home lengthening');
  await mod.default.run();
  assert.equal(db.calls.insert.length, 1, 'in-memory dedup');
});

// ── 7. Empty slate ──────────────────────────────────────────────
test('empty slate → dormant, no blocked, nothing read', async () => {
  slate = [];
  const r = await mod.default.run();
  assert.equal(r.summary, 'dormant — empty slate');
  assert.equal(r.blocked, undefined);
  assert.equal(published, null);
  assert.equal(db.calls.select.length, 0);
});

test('games without a sport or a start time are not on the slate', async () => {
  slate = [{ ...game('NFL', 'q', { total: 40 }), sport: null }, { ...game('NFL', 'w', { total: 40 }), commence_time: null }];
  const r = await mod.default.run();
  assert.equal(r.summary, 'dormant — empty slate');
});
