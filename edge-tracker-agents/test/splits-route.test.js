// ══════════════════════════════════════════════════════════════
// /splits — the join (percentages + consensus opener + current line) and the
// bounded DB fallback behind it (docs/specs/splits-tab.md).
//
// Memory wins whenever the public-splits slot has rows and the route then
// reads NOTHING from the DB. When memory is empty (post-restart) the route
// makes ONE bounded select — newest 300 by fetched_at desc — keeps each game's
// newest batch, counts off-slate games, and caches both a result and a
// failure for the TTL so the 30-s poll cannot hammer a timing-out table.
// A null percentage or opener stays null — never 0 (D96/D97).
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const T = (minsFromNow) => new Date(Date.now() + minsFromNow * 60_000).toISOString();
const game = (sport, id, { total, spread, ml, kick = 180 } = {}) => {
  const mk = {};
  if (total != null) { mk['totals:Over'] = { line: total, price: -110 }; mk['totals:Under'] = { line: total, price: -110 }; }
  if (spread != null) mk['spreads:HOME'] = { line: spread, price: -110 };
  if (ml != null) { mk['h2h:HOME'] = { price: ml }; mk['h2h:AWAY'] = { price: -ml }; }
  return {
    sport, game_id: id, home: 'HOME', away: 'AWAY', commence_time: T(kick),
    books: { draftkings: { label: 'DraftKings', markets: mk }, fanduel: { label: 'FanDuel', markets: mk } },
  };
};
// Postgres hands numerics back as STRINGS — the DB fixture does too.
const dbRow = (game_id, market, side, bets, handle, fetched_at) => ({
  game_id, sport: 'NBA', market, side, bets_pct: bets == null ? null : String(bets), handle_pct: handle == null ? null : String(handle),
  divergence: bets != null && handle != null ? String(handle - bets) : null, rlm: null, freeze: null, pileon: false, net_move: null,
  line_open: null, line_current: null, fetched_at,
});

let db, store, mod, warns;
const url = (sport) => new URL(`http://x/splits${sport ? `?sport=${sport}` : ''}`);

before(async () => {
  db = fakeDb();
  const { logger, lines } = fakeLogger();
  warns = lines.warn;
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger, hasClaude: () => false, claudeBlockReason: () => 'x', claudeJson: async () => [] },
  });
  store = await import('../src/store/index.js');
  mod = await import('../src/games/splits.js');
});
after(() => mock.reset());
beforeEach(() => {
  mod.__resetSplitsCache();
  db.fail = {}; warns.length = 0;
  db.setRows('public_splits', []);
  for (const k of Object.keys(db.calls)) db.calls[k].length = 0;
  store.setGames([
    game('NBA', 'g1', { total: 220.5, spread: -4.5, ml: -180 }),
    game('NBA', 'g2', { total: 44.5, spread: 3, ml: 130, kick: -30 }), // started
  ]);
  store.setNflLineMove({ openers: { g1: { total: 218, spread: -3, ml: -150 }, g2: { total: 45.5, spread: null, ml: 120 } } });
  store.setIntel('splits', []);
});

const memRows = () => [
  { sport: 'NBA', game_id: 'g1', market: 'spread', side: 'Home -4.5', bets_pct: 71, handle_pct: 58, divergence: -13, rlm: true, freeze: false, pileon: false, net_move: -1.5, fetched_at: T(-10) },
  { sport: 'NBA', game_id: 'g1', market: 'total', side: 'Over', bets_pct: 64, handle_pct: null, divergence: null, rlm: null, freeze: null, pileon: false, net_move: null, fetched_at: T(-10) },
  { sport: 'NBA', game_id: 'g2', market: 'ml', side: 'AWAY', bets_pct: null, handle_pct: 55, divergence: null, rlm: false, freeze: false, pileon: false, net_move: null, fetched_at: T(-10) },
];

// ── (a) memory ────────────────────────────────────────────────
test('memory rows → source memory, open/current joined, public_side resolved, zero selects', async () => {
  store.setIntel('splits', memRows());
  const r = await mod.buildSplits(url());
  assert.equal(r.splits_meta.source, 'memory');
  assert.equal(r.splits_meta.rows, 3);
  assert.equal(db.calls.select.length, 0, 'memory wins — nothing is read from the DB');
  const g1 = r.games.find((g) => g.game_id === 'g1');
  assert.deepEqual(g1.open, { total: 218, spread: -3, ml: -150 });
  assert.deepEqual(g1.current, { total: 220.5, spread: -4.5, ml: -180 });
  const sp = g1.splits.find((s) => s.market === 'spread');
  assert.equal(sp.public_side, 'home');
  assert.equal(sp.rlm, true); assert.equal(sp.net_move, -1.5);
  assert.equal(g1.splits.find((s) => s.market === 'total').public_side, 'over');
  const g2 = r.games.find((g) => g.game_id === 'g2');
  assert.equal(g2.live, true, 'the started game is on the board too');
  assert.equal(g2.splits[0].public_side, 'away');
  assert.equal(g2.open.spread, null, 'a missing opener market is null');
  assert.ok(r.splits_meta.at, 'newest fetched_at is published');
});

// ── (b) DB fallback ───────────────────────────────────────────
test("empty memory → source==='db' via ONE bounded select (desc, limit 300); newest batch per game; offslate counted", async () => {
  const older = T(-300), newer = T(-60);
  db.setRows('public_splits', [
    dbRow('g1', 'spread', 'Home -3', 60, 70, older),
    dbRow('g1', 'spread', 'Home -4.5', 71, 58, newer),
    dbRow('g1', 'total', 'Over', 64, 52, newer),
    dbRow('g2', 'ml', 'AWAY', 55, 61, older),
    dbRow('gone', 'total', 'Under', 80, 75, newer), // not on the slate
  ]);
  const r = await mod.buildSplits(url());
  assert.equal(db.calls.select.length, 1, 'exactly one select');
  const q = db.calls.select[0];
  assert.equal(q.table, 'public_splits');
  assert.equal(q.opts.order.column, 'fetched_at');
  assert.equal(q.opts.order.ascending, false, 'newest first');
  assert.equal(q.opts.limit, 300);
  assert.equal(q.opts.in, undefined, 'no in:'); assert.equal(q.opts.gte, undefined, 'no gte');
  assert.equal(r.splits_meta.source, 'db');
  assert.equal(r.splits_meta.offslate, 1);
  assert.equal(r.splits_meta.db_error, false);
  const g1 = r.games.find((g) => g.game_id === 'g1');
  assert.equal(g1.splits.length, 2, 'only the newest batch for g1');
  assert.equal(g1.splits.find((s) => s.market === 'spread').bets_pct, 71, 'the newer batch, as a number');
  const g2 = r.games.find((g) => g.game_id === 'g2');
  assert.equal(g2.splits.length, 1, "g2's newest batch is the older stamp — per game, not global");
  assert.equal(g2.splits[0].handle_pct, 61);
  assert.equal(r.splits_meta.at, newer);
});

// ── (c) TTL ───────────────────────────────────────────────────
test('a second call inside the TTL makes no second select; past the TTL it re-reads', async () => {
  db.setRows('public_splits', [dbRow('g1', 'total', 'Over', 64, 52, T(-60))]);
  const now = Date.now();
  await mod.buildSplits(url(), { now });
  await mod.buildSplits(url('NBA'), { now: now + 9 * 60_000 });
  assert.equal(db.calls.select.length, 1, 'the 30-s poll must not become a 30-s DB read');
  const r = await mod.buildSplits(url(), { now: now + 11 * 60_000 });
  assert.equal(db.calls.select.length, 2);
  assert.equal(r.splits_meta.source, 'db');
});

// ── (d) failure cached ────────────────────────────────────────
test('a failed read → source null, db_error true, games still carry lines; the failure is cached for the TTL', async () => {
  db.fail['select:public_splits'] = new Error('canceling statement due to statement timeout');
  const now = Date.now();
  const r = await mod.buildSplits(url(), { now });
  assert.equal(r.splits_meta.source, null);
  assert.equal(r.splits_meta.db_error, true);
  assert.equal(r.games.length, 2, 'lines are in memory and free — a dead table does not blank the board');
  assert.deepEqual(r.games.find((g) => g.game_id === 'g1').current, { total: 220.5, spread: -4.5, ml: -180 });
  assert.equal(r.games.every((g) => g.splits.length === 0), true);
  assert.equal(warns.length, 1);
  await mod.buildSplits(url(), { now: now + 60_000 });
  assert.equal(db.calls.select.length, 1, 'a timing-out table is not hammered 120×/hour');
});

// ── (e) never 0 ───────────────────────────────────────────────
test('a null bets_pct stays null and a missing opener is null — never 0', async () => {
  store.setIntel('splits', memRows());
  store.setNflLineMove(null); // post-restart: no slot, no openers
  const r = await mod.buildSplits(url());
  const g2 = r.games.find((g) => g.game_id === 'g2');
  assert.equal(g2.splits[0].bets_pct, null);
  assert.notEqual(g2.splits[0].bets_pct, 0);
  assert.equal(g2.open, null, 'no line-move slot → open is null, not {0,0,0}');
  const g1 = r.games.find((g) => g.game_id === 'g1');
  const tot = g1.splits.find((s) => s.market === 'total');
  assert.equal(tot.handle_pct, null); assert.equal(tot.divergence, null);
  assert.equal(tot.rlm, null); assert.equal(tot.freeze, null); assert.equal(tot.net_move, null);
  // A DB row with a blank numeric is the same claim.
  store.setIntel('splits', []);
  db.setRows('public_splits', [{ ...dbRow('g1', 'ml', 'HOME', null, null, T(-5)), bets_pct: '' }]);
  const r2 = await mod.buildSplits(url());
  assert.equal(r2.games.find((g) => g.game_id === 'g1').splits[0].bets_pct, null, "Number('') is 0 — type-check first");
});

// ── (f) row shape ─────────────────────────────────────────────
test('no row gains a field the table does not have; line_open is untouched', async () => {
  store.setIntel('splits', memRows());
  const r = await mod.buildSplits(url());
  const keys = Object.keys(r.games.find((g) => g.game_id === 'g1').splits[0]).sort();
  assert.deepEqual(keys, ['bets_pct', 'divergence', 'fetched_at', 'freeze', 'handle_pct', 'market', 'net_move', 'pileon', 'public_side', 'rlm', 'side']);
  assert.ok(!('line_open' in r.games[0].splits[0]), 'line_open/line_current are left to the agent (null there by design)');
  assert.equal(db.calls.insert.length, 0); assert.equal(db.calls.update.length, 0);
});

// ── (g) books carry a key; splits carry no book ───────────────
test('every books[] entry carries key (the slate book key) and book (its label); no splits[] row carries a book field', async () => {
  store.setIntel('splits', memRows());
  const r = await mod.buildSplits(url());
  for (const g of r.games) {
    assert.deepEqual(g.books.map((b) => b.key).sort(), ['draftkings', 'fanduel']);
    assert.deepEqual(g.books.map((b) => b.book).sort(), ['DraftKings', 'FanDuel']);
    for (const b of g.books) assert.equal(b.spread_line, g.current.spread);
    for (const s of g.splits) assert.ok(!('book' in s), 'percentages are market-wide (D53/D22) — a splits row is never keyed by book');
  }
});

// ── per-game age ──────────────────────────────────────────────
// The fallback keeps each game's NEWEST batch across ~5 batches, so one board
// can carry a 16-h-old game beside a 10-min-old one while `at` is the newest.
test("each game publishes its own splits_at; a game with no rows has null; memory path too", async () => {
  const older = T(-16 * 60), newer = T(-10);
  db.setRows('public_splits', [dbRow('g1', 'spread', 'Home -3', 60, 70, older), dbRow('g2', 'ml', 'AWAY', 55, 61, newer)]);
  const r = await mod.buildSplits(url());
  assert.equal(r.splits_meta.at, newer);
  assert.equal(r.games.find((g) => g.game_id === 'g1').splits_at, older, "g1's rows are 16 h old even though the board's `at` is 10 min");
  assert.equal(r.games.find((g) => g.game_id === 'g2').splits_at, newer);
  store.setGames([game('NBA', 'g1', { total: 220.5 }), game('NBA', 'g2', { total: 44.5 }), game('NBA', 'g3', { total: 200 })]);
  const mem = memRows(); // one array: memRows() stamps T(-10) at call time
  store.setIntel('splits', mem);
  const r2 = await mod.buildSplits(url());
  assert.equal(r2.games.find((g) => g.game_id === 'g3').splits_at, null, 'no rows → null, never a borrowed stamp');
  assert.equal(r2.games.find((g) => g.game_id === 'g1').splits_at, mem[0].fetched_at);
});

// ── truncation is said, not hidden ────────────────────────────
test('a read that fills SPLITS_DB_LIMIT publishes truncated:true; a smaller one false; memory never', async () => {
  const many = [];
  for (let i = 0; i < 300; i++) many.push(dbRow(`x${i}`, 'total', 'Over', 60, 55, T(-5)));
  db.setRows('public_splits', many);
  const r = await mod.buildSplits(url());
  assert.equal(r.splits_meta.truncated, true, 'games may be missing — say so rather than drop them silently');
  mod.__resetSplitsCache();
  db.setRows('public_splits', many.slice(0, 50));
  assert.equal((await mod.buildSplits(url())).splits_meta.truncated, false);
  store.setIntel('splits', memRows());
  assert.equal((await mod.buildSplits(url())).splits_meta.truncated, false);
});

// ── in-flight dedupe ──────────────────────────────────────────
test('two clients polling in the same instant after a restart share ONE in-flight select', async () => {
  db.setRows('public_splits', [dbRow('g1', 'total', 'Over', 64, 52, T(-60))]);
  const now = Date.now();
  const [a, b] = await Promise.all([mod.buildSplits(url(), { now }), mod.buildSplits(url('NBA'), { now })]);
  assert.equal(db.calls.select.length, 1, 'the second caller awaits the first select instead of issuing its own');
  assert.equal(a.splits_meta.source, 'db'); assert.equal(b.splits_meta.source, 'db');
  assert.equal(b.games.find((g) => g.game_id === 'g1').splits.length, 1, 'and sees its rows');
});

test('?sport= filters the board but off-slate is counted against the whole slate', async () => {
  store.setGames([game('NBA', 'g1', { total: 220.5 }), game('NFL', 'n1', { total: 44.5 })]);
  db.setRows('public_splits', [dbRow('n1', 'total', 'Over', 70, 60, T(-5)), dbRow('zz', 'total', 'Over', 70, 60, T(-5))]);
  const r = await mod.buildSplits(url('NBA'));
  assert.deepEqual(r.games.map((g) => g.sport), ['NBA']);
  assert.equal(r.splits_meta.offslate, 1, 'n1 is on the slate even though the request filtered it out');
});
