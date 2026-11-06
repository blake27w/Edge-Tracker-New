// ══════════════════════════════════════════════════════════════
// Per-book openers inside book-move (docs/specs/splits-tab.md).
//
// A book's opener is THAT BOOK'S OWN oldest line_snapshots row on file for
// that game × market — never "the rows sharing the oldest stamp": fetched_at
// is per INSERT statement and a chunked run (D99) carries several. What these
// pin: the query shape (D22 — equality on the index prefix, fetched_at ASC,
// limit 60, no `in:`, no `gte`), that each book's oldest row counts whatever
// batch it sits in, that a book absent from the whole window is absent from
// the object (never 0, never the consensus opener), that a non-empty result is
// memoised for the process lifetime, and that a failed OR empty read writes no
// memo so it is retried.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const T = (minsFromNow) => new Date(Date.now() + minsFromNow * 60_000).toISOString();
const g = () => ({ sport: 'NFL', game_id: 'g1', home: 'Kansas City Chiefs', away: 'Denver Broncos', commence_time: T(180), books: {} });

// Two batches: DraftKings opens -3 and moves to -3.5; FanDuel first appears
// in the second batch (so ITS opener is -3.5); BetMGM's only line is blank;
// Caesars never posts (Postgres numerics come back as strings — the fixture
// uses them too).
const B1 = T(-600), B2 = T(-300);
const snap = (book, market, side, line, price, fetched_at) => ({ game_id: 'g1', book, market, side, line, price, fetched_at });
const rows = () => [
  snap('draftkings', 'spreads', 'Kansas City Chiefs', '-3', -110, B1),
  snap('draftkings', 'spreads', 'Denver Broncos', '3', -110, B1),
  snap('betmgm', 'spreads', 'Kansas City Chiefs', '', -110, B1),
  snap('draftkings', 'spreads', 'Kansas City Chiefs', '-3.5', -110, B2),
  snap('fanduel', 'spreads', 'Kansas City Chiefs', '-3.5', -110, B2),
  snap('draftkings', 'totals', 'Over', '44.5', -110, B1),
  snap('draftkings', 'totals', 'Under', '44.5', -110, B1),
  snap('draftkings', 'totals', 'Over', '45.5', -110, B2),
  snap('draftkings', 'h2h', 'Kansas City Chiefs', null, '-150', B1),
  snap('draftkings', 'h2h', 'Denver Broncos', null, '130', B1),
  snap('fanduel', 'h2h', 'Denver Broncos', null, '135', B1), // away only — no home price → no ml
];

let db, mod, store, warns;
before(async () => {
  db = fakeDb();
  const { logger, lines } = fakeLogger();
  warns = lines.warn;
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger } });
  store = await import('../src/store/index.js');
  mod = await import('../src/agents/book-move/index.js');
});
after(() => mock.reset());
beforeEach(() => {
  mod.__resetOpeners();
  db.fail = {}; warns.length = 0;
  db.setRows('line_snapshots', rows());
  for (const k of Object.keys(db.calls)) db.calls[k].length = 0;
  store.setNflLineMove(null);
});

const snapSelects = () => db.calls.select.filter((c) => c.table === 'line_snapshots');

// ── (a) query shape ───────────────────────────────────────────
test('one select per market in spreads/totals/h2h: match {game_id, market}, fetched_at ascending===true, limit===60, no in:, no gte', async () => {
  const r = await mod.openersFor(g());
  assert.equal(r.failed, false);
  assert.equal(r.selects, 3);
  const qs = snapSelects();
  assert.deepEqual(qs.map((q) => q.opts.match.market), ['spreads', 'totals', 'h2h']);
  for (const q of qs) {
    assert.equal(q.opts.match.game_id, 'g1', 'equality on the index prefix (D22)');
    assert.equal(q.opts.order.column, 'fetched_at');
    assert.equal(q.opts.order.ascending, true, 'the first batch is the OLDEST — asc, or the limit truncates it away');
    assert.equal(q.opts.limit, 60, 'one run is ≤ 22 rows per market (11 books × 2 sides) — 60 holds a chunk-split first run');
    assert.equal(q.opts.in, undefined, 'no in:');
    assert.equal(q.opts.gte, undefined, 'no gte — the opener may be older than any window');
  }
});

// ── (b) each book's own oldest row ────────────────────────────
test("each book's OWN oldest row counts: DraftKings -3 in batch 1, -3.5 in batch 2 → spread === -3; FanDuel's first row is batch 2 → -3.5", async () => {
  const { books } = await mod.openersFor(g());
  assert.equal(books.draftkings.spread, -3);
  assert.equal(books.draftkings.total, 44.5);
  assert.equal(books.draftkings.ml, -150, 'h2h opener is the HOME price');
  assert.equal(books.fanduel.spread, -3.5, 'a book first seen in a later batch gets its own first line, not nothing');
});

// The D99 case: one odds run written in SNAPSHOT_CHUNK inserts, each with its
// own default-now() stamp, splits a game × market across two stamps. Every
// book in that run has its opener on file — none is "absent until kickoff".
test('a chunk-split first run (two stamps 800 ms apart) yields an opener for EVERY book in it', async () => {
  const base = Date.now() - 600 * 60_000;
  const s1 = new Date(base + 100).toISOString(), s2 = new Date(base + 900).toISOString();
  db.setRows('line_snapshots', [
    snap('draftkings', 'spreads', 'Kansas City Chiefs', '-3', -110, s1),
    snap('draftkings', 'spreads', 'Denver Broncos', '3', -110, s1),
    snap('fanduel', 'spreads', 'Kansas City Chiefs', '-3.5', -110, s2),
    snap('betmgm', 'spreads', 'Kansas City Chiefs', '-3', -115, s2),
    snap('fanduel', 'spreads', 'Kansas City Chiefs', '-4', -110, T(-300)), // a later move — not the opener
  ]);
  const { books } = await mod.openersFor(g());
  assert.deepEqual(books, { draftkings: { spread: -3 }, fanduel: { spread: -3.5 }, betmgm: { spread: -3 } },
    'books after the chunk boundary must not read as absent');
});

// ── (c) absent is absent — never 0 ────────────────────────────
test('a book absent from the whole window is not a key, and a blank line yields no field — never 0', async () => {
  const { books } = await mod.openersFor(g());
  assert.equal('caesars' in books, false, 'Caesars never posted → no opener on file');
  assert.ok(!('betmgm' in books) || !('spread' in books.betmgm), "Number('') is 0 — a blank line is no opener");
  for (const b of Object.values(books)) for (const v of Object.values(b)) assert.notEqual(v, 0);
  assert.notEqual(books.draftkings.spread, 0);
});

// ── (d) no consensus leak ─────────────────────────────────────
test('with a consensus opener seeded on the line-move slot, a book with no snapshot row still has no spread', async () => {
  store.setNflLineMove({ openers: { g1: { spread: -2.5, total: 44, ml: -140 } } });
  const { books } = await mod.openersFor(g());
  assert.equal('caesars' in books, false, 'the consensus opener never appears in the per-book object');
  assert.equal(books.draftkings.spread, -3, 'DraftKings keeps its OWN first line, not the consensus -2.5');
  for (const b of Object.values(books)) assert.notEqual(b.spread, -2.5);
});

// ── (e) memo ──────────────────────────────────────────────────
test('a second openersFor(g) makes no select', async () => {
  const a = await mod.openersFor(g());
  assert.equal(snapSelects().length, 3);
  const b = await mod.openersFor(g());
  assert.equal(snapSelects().length, 3, 'an opener never changes — the game is memoised for the process lifetime');
  assert.equal(b.selects, 0);
  assert.deepEqual(b.books, a.books);
});

// ── (f) failure → no memo ─────────────────────────────────────
test('a failed select → failed:true, no memo, and the next call selects again', async () => {
  db.fail['select:line_snapshots'] = new Error('canceling statement due to statement timeout');
  const r = await mod.openersFor(g());
  assert.equal(r.failed, true);
  assert.equal(r.books, null);
  assert.equal(warns.length, 1);
  db.fail = {};
  const r2 = await mod.openersFor(g());
  assert.equal(r2.failed, false);
  assert.ok(snapSelects().length > 1, 'retried — a failure writes no memo');
  assert.equal(r2.books.draftkings.spread, -3);
});

// A lost snapshot chunk (the D68/D99 timeout path) leaves 0 rows at THIS run
// and the rows land minutes later; memoising {} would hide them until kickoff.
test('a game with no snapshot rows yet is NOT memoised: seed [] → {} → seed a row → the row appears', async () => {
  db.setRows('line_snapshots', []);
  const { books, failed } = await mod.openersFor(g());
  assert.equal(failed, false);
  assert.deepEqual(books, {}, 'no books, no zeros');
  assert.equal(snapSelects().length, 3);
  db.setRows('line_snapshots', [snap('draftkings', 'spreads', 'Kansas City Chiefs', '-3', -110, T(-5))]);
  const r2 = await mod.openersFor(g());
  assert.equal(snapSelects().length, 6, 'an empty read is retried next run — bounded by the per-run cap');
  assert.equal(r2.books.draftkings.spread, -3, 'the late-landing chunk is seen');
  await mod.openersFor(g());
  assert.equal(snapSelects().length, 6, 'and the non-empty result IS memoised');
});
