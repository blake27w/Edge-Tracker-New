// ══════════════════════════════════════════════════════════════
// One day of the Splits tab's backend, through the REAL agents and the REAL
// route against a scripted db (docs/specs/splits-tab.md, D101):
//
//   odds run 1 ─ 288 snapshots in 100-row chunks, one default-now() stamp per
//                INSERT statement (#144/D99 semantics); the LAST chunk times
//                out twice and is lost — it held the tail of game g2 and all
//                of g3.
//   nfl-line-move ─ publishes consensus openers (sentinel values from
//                opening_lines so a leak into a per-book opener is visible).
//   book-move run 1 ─ per-book openers: g0 whole, g1 chunk-split across two
//                stamps and whole, g2 PARTIAL and memoised (the residual the
//                review flagged), g3 empty → NOT memoised.
//   public-splits batch 1 ─ percentages for g0, g1, g2 (one null handle).
//   /splits ─ source memory, per-game splits_at, null stays null.
//   odds run 2 ─ the lost rows' successors land with run-2 stamps; lines move.
//   book-move run 2 ─ g3 now has openers (its own first rows, run 2); g0/g1
//                keep run-1 openers; g2's lost-tail books STILL absent (memo).
//   public-splits batch 2, +4h ─ g1 missing from this batch.
//   /splits ─ memory holds only the newest batch: g1 has no rows now.
//   restart (+4h10m) ─ memory empty → ONE bounded select → source db, g1
//                comes back from batch 1 with its OWN older splits_at; a
//                second poll inside the TTL makes no select.
//   book-move run 3 (post-restart, memo empty) ─ re-reads 60 asc: g0/g1
//                openers identical to run 1 (first row on file, not the
//                newest); g2's tail books now present from run 2.
//   odds run 3 ─ 72 rows per market on file, > the 60 limit; book-move run 4
//                is a memo hit and makes no opener select.
//   public-splits batch 3, +8h ─ memory refills → source memory, no select.
//
// The clock is pinned (mock.timers, Date only) so stamps, the 10-min TTL and
// the 4-hour cadence are deterministic.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const MIN = 60_000, H = 3600_000;
const T0 = Date.parse('2026-11-06T14:00:00.000Z');
const KICK = T0 + 10 * H; // every game kicks off after the whole day, inside book-move's +24h window
const iso = (ms) => new Date(ms).toISOString();
const BOOKS = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbet', 'betrivers', 'wynnbet', 'unibet', 'bovada', 'betonline', 'lowvig', 'mybookie'];
const LABELS = Object.fromEntries(BOOKS.map((b) => [b, b.toUpperCase()]));
const N_GAMES = 4;
const CHUNK = 100;              // 4 games × 12 books × 6 rows = 288 → chunks of 100, 100, 88
const OPEN = { spread: -77.5, total: 177.5, ml: -777 }; // consensus sentinels — must never appear per book

// Every book posts a DISTINCT line so an opener can be traced to its book and
// run: spread = -(3 + b/2) - run/2, total = 220 + b + run, ML home = -(120+5b+5run).
let run = 0;
const spreadOf = (b, r) => -(3 + b * 0.5) - r * 0.5;
const totalOf = (b, r) => 220 + b + r;
const mlOf = (b, r) => -(120 + b * 5 + r * 5);
const ev = (i) => ({
  id: `g${i}`, home_team: `Home${i} Hawks`, away_team: `Away${i} Owls`, commence_time: iso(KICK + i * MIN),
  bookmakers: BOOKS.map((key, b) => ({
    key, last_update: iso(Date.now()),
    markets: [
      { key: 'h2h', last_update: iso(Date.now()), outcomes: [{ name: `Home${i} Hawks`, price: mlOf(b, run) }, { name: `Away${i} Owls`, price: -mlOf(b, run) - 20 }] },
      // mybookie posts NO spread point in run 1 (a blank line is no opener, never 0).
      { key: 'spreads', last_update: iso(Date.now()), outcomes: [
        { name: `Home${i} Hawks`, point: key === 'mybookie' && run === 1 ? undefined : spreadOf(b, run), price: -110 },
        { name: `Away${i} Owls`, point: key === 'mybookie' && run === 1 ? undefined : -spreadOf(b, run), price: -110 }] },
      { key: 'totals', last_update: iso(Date.now()), outcomes: [{ name: 'Over', point: totalOf(b, run), price: -110 }, { name: 'Under', point: totalOf(b, run), price: -110 }] },
    ],
  })),
});

let fdb, odds, splitsAgent, bookMove, lineMove, store, route, logs;
let batch = [];              // what claudeJson returns to public-splits
let losePlan = null;         // (ordinal, attempt) → Error | null, for line_snapshots chunks
const lost = [];             // rows the lost chunk(s) carried, by run
const chunkOrdinal = new WeakMap(), chunkTries = new WeakMap();
let chunksThisRun = 0;
const tick = () => new Promise((r) => setTimeout(r, 5));
const timeout = () => Object.assign(new Error('insert line_snapshots: canceling statement due to statement timeout'), { code: '57014' });

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  process.env.ODDS_SNAPSHOT_CHUNK = String(CHUNK);
  process.env.ODDS_HYDRATE_COLD_MAX = '2';
  process.env.ODDS_HYDRATE_MAX_GAMES = '2';
  for (const k of ['ODDS_STRIKE_MIN', 'ODDS_NEAR_MIN', 'ODDS_MID_MIN', 'ODDS_IDLE_MIN']) process.env[k] = '0.000001';

  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: { allocation: { NBA: 1 }, monthlyBudget: 20000, tier: 'starter', key: 'test-key',
        footballSports: [], footballPriority: 'false', footballPriorityOn: () => false,
        base: 'https://api.the-odds-api.com/v4' },
      SPORTS: { NBA: { key: 'basketball_nba' } },
      BOOKS, BOOK_LABELS: LABELS,
      rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: false,
    },
  });

  fdb = fakeDb({});
  const realInsert = fdb.insert.bind(fdb);
  fdb.insert = async (table, rows, options) => {
    if (table !== 'line_snapshots') return realInsert(table, rows, options);
    assert.ok(rows.length <= CHUNK, `chunk of ${rows.length}`);
    if (!chunkOrdinal.has(rows[0])) chunkOrdinal.set(rows[0], chunksThisRun++);
    const ordinal = chunkOrdinal.get(rows[0]);
    const attempt = (chunkTries.get(rows[0]) || 0) + 1;
    chunkTries.set(rows[0], attempt);
    const err = losePlan ? losePlan(ordinal, attempt) : null;
    if (err) {
      if (attempt === 2) lost.push({ run, rows });
      throw err;
    }
    // `fetched_at default now()` — ONE stamp per INSERT statement, so a
    // chunk-split game straddles two stamps; successive statements are
    // 800 ms apart (D99 measured ~0.8 s a chunk).
    mock.timers.setTime(Date.now() + 800);
    const at = iso(Date.now());
    assert.ok(rows.every((r) => !('fetched_at' in r)), 'the agent leaves the stamp to the table default');
    return realInsert(table, rows.map((r) => ({ ...r, fetched_at: at })), options);
  };
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb, namedExports: { isConnected: fdb.isConnected, isMissingRelation: fdb.isMissingRelation },
  });
  const fl = fakeLogger();
  logs = fl.lines;
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: fl.logger, notifyAll: async () => ({ total: 0 }),
      hasClaude: () => true, claudeBlockReason: () => 'x', claudeJson: async () => batch,
    },
  });
  global.fetch = async (url) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => (String(url).includes('/sports?') ? [{ key: 'basketball_nba', active: true }] : Array.from({ length: N_GAMES }, (_, i) => ev(i))),
  });

  store = await import('../src/store/index.js');
  odds = (await import('../src/agents/odds/index.js')).default;
  splitsAgent = (await import('../src/agents/public-splits/index.js')).default;
  bookMove = await import('../src/agents/book-move/index.js');
  lineMove = (await import('../src/agents/nfl-line-move/index.js')).default;
  route = await import('../src/games/splits.js');
  // Consensus openers come from opening_lines through nfl-line-move; sentinels.
  fdb.setRows('opening_lines', Array.from({ length: N_GAMES }, (_, i) => [
    { game_id: `g${i}`, market: 'spread', line: String(OPEN.spread) },
    { game_id: `g${i}`, market: 'total', line: String(OPEN.total) },
    { game_id: `g${i}`, market: 'ml', line: String(OPEN.ml) },
  ]).flat());
});
after(() => { mock.timers.reset(); mock.reset(); });

const runOdds = async () => { await tick(); run++; chunksThisRun = 0; const r = await odds.run(); await tick(); return r; };
const url = () => new URL('http://x/splits');
const openSelects = () => fdb.calls.select.filter((c) => c.table === 'line_snapshots' && c.opts.order && c.opts.order.ascending === true && !c.opts.gte);
const splitsSelects = () => fdb.calls.select.filter((c) => c.table === 'public_splits' && c.opts.limit === 300);
const openersOf = () => (store.getBookMoves() || {}).openers || {};
const game = (r, id) => r.games.find((g) => g.game_id === id);
const row = (id, market, side, bets, handle) => ({ game_id: id, sport: 'NBA', market, side, bets_pct: bets, handle_pct: handle });

// Every per-book opener value, flattened, for the never-0 / never-consensus sweep.
const allOpenerValues = (op) => Object.values(op).flatMap((bk) => Object.values(bk).flatMap((o) => Object.values(o)));
function assertOpenersHonest(op) {
  for (const v of allOpenerValues(op)) {
    assert.equal(typeof v, 'number');
    assert.notEqual(v, 0, 'a blank line is never a 0 opener');
    assert.ok(![OPEN.spread, OPEN.total, OPEN.ml].includes(v), `the consensus opener ${v} leaked into a per-book opener`);
  }
}
function assertPercentagesHonest(r, published) {
  // Every percentage on the route is exactly what the agent published for
  // that game × market; a null published is a null served — never 0.
  for (const g of r.games) for (const s of g.splits) {
    const p = published.find((x) => x.game_id === g.game_id && x.market === s.market);
    assert.ok(p, `${g.game_id}/${s.market} was never published`);
    assert.equal(s.bets_pct, p.bets_pct); assert.equal(s.handle_pct, p.handle_pct);
    if (p.bets_pct == null) assert.notEqual(s.bets_pct, 0);
    if (p.handle_pct == null) assert.notEqual(s.handle_pct, 0);
  }
}
const lostBooks = (gameId, market) => new Set(lost.flatMap((l) => l.rows).filter((x) => x.game_id === gameId && x.market === market).map((x) => x.book));

let batch1Rows, batch2Rows, b1At, b2At, run1Openers;

test('odds run 1: 288 snapshots in three stamped chunks; the last chunk is lost twice (g2 tail + all of g3)', async () => {
  losePlan = (ordinal, attempt) => (ordinal === 2 ? timeout() : null);
  const r = await runOdds();
  losePlan = null;
  assert.equal(r.data.snapshots, N_GAMES * BOOKS.length * 6, r.summary);
  assert.equal(r.data.snapshotsLost, 88, 'the 88-row tail chunk is counted lost');
  assert.equal(r.data.snapshotsWritten, 200);
  const snaps = fdb.rows('line_snapshots');
  assert.equal(snaps.length, 200);
  assert.equal(new Set(snaps.map((s) => s.fetched_at)).size, 2, 'two landed statements → two stamps');
  const g1Stamps = new Set(snaps.filter((s) => s.game_id === 'g1' && s.market === 'spreads').map((s) => s.fetched_at));
  assert.equal(g1Stamps.size, 2, 'g1 is chunk-split across two stamps (#144)');
  assert.equal(snaps.filter((s) => s.game_id === 'g3').length, 0, 'g3 has nothing on file yet');
  assert.ok(lostBooks('g2', 'spreads').size >= 2 && lostBooks('g2', 'spreads').size < BOOKS.length, `g2 lost a TAIL of books: ${[...lostBooks('g2', 'spreads')]}`);
  assert.equal(store.getGames().length, N_GAMES, 'the slate is in memory regardless');
  assert.equal(Object.keys(store.getGames()[0].books).length, BOOKS.length);
});

test('nfl-line-move publishes the consensus openers for all four games', async () => {
  const r = await lineMove.run();
  assert.equal(r.blocked, undefined, r.summary);
  const op = store.getNflLineMove().openers;
  assert.deepEqual(Object.keys(op).sort(), ['g0', 'g1', 'g2', 'g3']);
  assert.deepEqual(op.g3, OPEN);
});

test('book-move run 1: g0 whole, g1 whole across the chunk boundary, g2 partial (memoised — the residual), g3 empty (not memoised)', async () => {
  const r = await bookMove.default.run();
  assert.ok(!/dormant|skipped/.test(r.summary), r.summary);
  const op = openersOf();
  assertOpenersHonest(op);
  assert.equal(openSelects().length, N_GAMES * 3, 'three opener selects per slate game');
  for (const q of openSelects()) assert.equal(q.opts.limit, 60);
  // g0 and g1: every book's own run-1 line, g1 straddling two stamps.
  for (const id of ['g0', 'g1']) {
    for (const [b, key] of BOOKS.entries()) {
      if (key === 'mybookie') { assert.ok(!('spread' in (op[id][key] || {})), 'mybookie posted no spread point in run 1 — no opener, not 0'); continue; }
      assert.equal(op[id][key].spread, spreadOf(b, 1), `${id}/${key} spread opener is its run-1 line`);
      assert.equal(op[id][key].total, totalOf(b, 1));
      assert.equal(op[id][key].ml, mlOf(b, 1), 'ML opener is the HOME price');
    }
  }
  // g2: the books whose spreads rode the lost chunk are absent — and the game IS memoised.
  const lostG2 = lostBooks('g2', 'spreads');
  for (const key of BOOKS) {
    if (lostG2.has(key)) assert.ok(!('spread' in (op.g2[key] || {})), `${key} spread rode the lost chunk → absent, not 0, not consensus`);
    else if (key !== 'mybookie') assert.equal(op.g2[key].spread, spreadOf(BOOKS.indexOf(key), 1));
  }
  assert.ok(!('g3' in op), 'g3 had 0 rows → {} → not published and not memoised');
  assert.equal(store.getBookMoves().openers_meta.games, 3);
  run1Openers = JSON.parse(JSON.stringify(op));
});

test('public-splits batch 1 → /splits reads memory: per-game splits_at, null stays null, zero selects', async () => {
  batch = [row('g0', 'spread', 'Home0 Hawks -3', 71, 58), row('g0', 'total', 'Over', 64, null), row('g1', 'ml', 'Away1 Owls', 55, 61), row('g2', 'total', 'Under', 80, 66)];
  const s = await splitsAgent.run();
  assert.match(s.summary, /4 splits/, s.summary);
  batch1Rows = store.getIntel('splits');
  b1At = batch1Rows[0].fetched_at;
  assert.equal(b1At, iso(Date.now()));
  fdb.calls.select.length = 0;
  const r = await route.buildSplits(url());
  assert.equal(r.splits_meta.source, 'memory');
  assert.equal(r.splits_meta.at, b1At);
  assert.equal(r.splits_meta.db_error, false); assert.equal(r.splits_meta.truncated, false);
  assert.equal(fdb.calls.select.length, 0, 'the memory path reads nothing');
  assert.deepEqual(r.games.map((g) => g.game_id), ['g0', 'g1', 'g2', 'g3']);
  assert.deepEqual(r.games.map((g) => g.splits.length), [2, 1, 1, 0]);
  assert.deepEqual(r.games.map((g) => g.splits_at), [b1At, b1At, b1At, null]);
  assertPercentagesHonest(r, batch1Rows);
  assert.equal(game(r, 'g0').splits.find((x) => x.market === 'total').handle_pct, null);
  assert.deepEqual(game(r, 'g3').open, OPEN, 'the consensus opener is on the route (line-move slot)');
  assert.equal(game(r, 'g0').splits[0].public_side, 'home');
  assert.equal(game(r, 'g2').splits[0].public_side, 'under');
  for (const g of r.games) {
    assert.equal(g.books.length, BOOKS.length);
    for (const b of g.books) { assert.ok(BOOKS.includes(b.key)); assert.equal(b.book, LABELS[b.key]); }
    for (const sp of g.splits) assert.ok(!('book' in sp));
  }
});

test('odds run 2 lands the lost rows\' successors; book-move run 2: g3 gains run-2 openers, g0/g1 keep run 1, g2\'s lost tail is STILL absent (memo — characterised, not endorsed)', async () => {
  mock.timers.setTime(T0 + 30 * MIN);
  const r = await runOdds();
  assert.equal(r.data.snapshotsLost, 0, r.summary);
  assert.equal(fdb.rows('line_snapshots').length, 200 + 288);
  const before = openSelects().length;
  await bookMove.default.run();
  const op = openersOf();
  assertOpenersHonest(op);
  assert.equal(openSelects().length - before, 3, 'only g3 (never memoised) is re-read; the three memoised games cost nothing');
  assert.deepEqual(op.g0, run1Openers.g0, 'an opener never changes');
  assert.deepEqual(op.g1, run1Openers.g1);
  assert.deepEqual(op.g2, run1Openers.g2, 'the partially landed first run stays memoised: lost-tail books remain absent until kickoff+6h — the flagged residual');
  for (const key of lostBooks('g2', 'spreads')) assert.ok(!('spread' in (op.g2[key] || {})), `${key} still has no g2 spread opener although its run-2 row is on file`);
  for (const [b, key] of BOOKS.entries()) {
    assert.equal(op.g3[key].spread, spreadOf(b, 2), `g3/${key}: its OWN first row on file is run 2, not nothing and not consensus`);
    assert.equal(op.g3[key].ml, mlOf(b, 2));
  }
  assert.equal(store.getBookMoves().openers_meta.games, 4);
});

test('public-splits batch 2 at +4h, g1 missing → memory serves ONLY the newest batch: g1 has no rows and a null splits_at', async () => {
  mock.timers.setTime(T0 + 4 * H);
  batch = [row('g0', 'spread', 'Home0 Hawks -3.5', 74, 52), row('g2', 'total', 'Under', null, 70), row('g3', 'ml', 'Home3 Hawks', 60, 65)];
  await splitsAgent.run();
  batch2Rows = store.getIntel('splits');
  b2At = batch2Rows[0].fetched_at;
  assert.ok(b2At > b1At);
  assert.equal(fdb.rows('public_splits').length, 7, 'both batches are in Postgres');
  fdb.calls.select.length = 0;
  const r = await route.buildSplits(url());
  assert.equal(r.splits_meta.source, 'memory');
  assert.equal(fdb.calls.select.length, 0);
  assert.deepEqual(r.games.map((g) => g.splits_at), [b2At, null, b2At, b2At], 'the memory slot is the newest batch only — g1 reads as no rows, honestly');
  assert.equal(game(r, 'g1').splits.length, 0);
  assertPercentagesHonest(r, batch2Rows);
  assert.equal(game(r, 'g2').splits[0].bets_pct, null, 'null bets_pct through the memory path');
});

test('restart at +4h10m: memory empty → ONE bounded select → source db; g1 is back from batch 1 with its own older splits_at; a second poll inside the TTL makes no select', async () => {
  mock.timers.setTime(T0 + 4 * H + 10 * MIN);
  // What a Railway restart leaves: no in-memory slots, the table intact.
  route.__resetSplitsCache();
  store.setIntel('splits', []);
  bookMove.__resetOpeners();
  store.setBookMoves(null);
  fdb.calls.select.length = 0;
  const [a, b] = await Promise.all([route.buildSplits(url()), route.buildSplits(url())]);
  assert.equal(splitsSelects().length, 1, 'two concurrent polls share one in-flight select');
  assert.equal(a.splits_meta.source, 'db'); assert.equal(b.splits_meta.source, 'db');
  assert.equal(a.splits_meta.at, b2At);
  assert.equal(a.splits_meta.rows, 4, 'newest batch per game: g0 and g2 drop their batch-1 rows (3 rows), g1 keeps its only batch — 7 → 4');
  assert.deepEqual(a.games.map((g) => g.splits_at), [b2At, b1At, b2At, b2At], 'g1 carries batch 1\'s stamp beside batch-2 games');
  assert.equal(game(a, 'g1').splits[0].handle_pct, 61);
  assertPercentagesHonest(a, [...batch2Rows, ...batch1Rows.filter((x) => x.game_id === 'g1')]);
  assert.equal(game(a, 'g2').splits[0].bets_pct, null, 'null survives the DB round trip — never 0');
  assert.equal(game(a, 'g0').splits.length, 1, 'g0 batch-2 only (its batch-1 total row is gone)');
  assert.equal(a.splits_meta.offslate, 0);
  // Inside the TTL: cached.
  mock.timers.setTime(T0 + 4 * H + 15 * MIN);
  const c = await route.buildSplits(url());
  assert.equal(splitsSelects().length, 1);
  assert.equal(c.splits_meta.source, 'db');
  // The route's per-request cost on the memory path is zero selects; on the db
  // path it is at most one per TTL — never per game.
  assert.equal(fdb.calls.select.length, 1);
});

test('book-move run 3 post-restart (memo empty): openers re-derived from the 60-row window — g0/g1 identical to run 1, g2\'s lost-tail books now from run 2', async () => {
  const before = openSelects().length;
  await bookMove.default.run();
  assert.equal(openSelects().length - before, N_GAMES * 3);
  const op = openersOf();
  assertOpenersHonest(op);
  const sansMyb = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'mybookie'));
  assert.deepEqual(sansMyb(op.g0), sansMyb(run1Openers.g0), 'first row on file is still run 1 (48 rows ≤ 60, asc)');
  assert.deepEqual(sansMyb(op.g1), sansMyb(run1Openers.g1));
  for (const key of lostBooks('g2', 'spreads')) assert.equal(op.g2[key].spread, spreadOf(BOOKS.indexOf(key), 2), `${key}'s g2 opener is its own first row on file — run 2`);
  // mybookie posted a blank spread in run 1: in run 1's memo it had no spread
  // opener; the re-read finds its run-2 row as its first USABLE one. Its
  // total was never blank, so that opener is still run 1.
  const myb = BOOKS.indexOf('mybookie');
  for (const id of ['g0', 'g1', 'g2']) {
    assert.ok(!('spread' in (run1Openers[id].mybookie || {})), 'run 1: blank → no spread opener');
    assert.equal(op[id].mybookie.spread, spreadOf(myb, 2), 'post-restart: its first usable row (run 2), never 0');
    // g2's mybookie block rode the lost chunk, so there its first total on file is run 2 too.
    assert.equal(op[id].mybookie.total, totalOf(myb, lostBooks(id, 'totals').has('mybookie') ? 2 : 1));
  }
});

test('odds run 3 puts 72 rows per market on file (> the 60 limit); book-move run 4 is a memo hit and reads nothing', async () => {
  mock.timers.setTime(T0 + 4 * H + 30 * MIN);
  await runOdds();
  const g0 = fdb.rows('line_snapshots').filter((s) => s.game_id === 'g0' && s.market === 'spreads');
  assert.equal(g0.length, 72);
  const before = openSelects().length;
  const snap = JSON.parse(JSON.stringify(openersOf()));
  await bookMove.default.run();
  assert.equal(openSelects().length - before, 0, 'all four games memoised');
  assert.deepEqual(openersOf(), snap);
  assertOpenersHonest(openersOf());
});

test('public-splits batch 3 at +8h refills memory → source memory, no select; the whole day never logged an error', async () => {
  mock.timers.setTime(T0 + 8 * H);
  batch = [row('g0', 'spread', 'Home0 Hawks -4', 77, 50), row('g1', 'total', 'Over', 52, 48)];
  await splitsAgent.run();
  const before = fdb.calls.select.length;
  const r = await route.buildSplits(url());
  assert.equal(r.splits_meta.source, 'memory');
  assert.equal(fdb.calls.select.length, before);
  assert.equal(r.splits_meta.at, iso(T0 + 8 * H));
  assertPercentagesHonest(r, store.getIntel('splits'));
  assert.deepEqual(r.games.map((g) => g.splits.length), [1, 1, 0, 0]);
  assert.equal(logs.error.filter((l) => !/line_snapshots/.test(l)).length, 0, `only the lost chunk logged at error: ${logs.error}`);
});

// Scenario 6 (backend half): the memory path costs no select per game, and the
// join over a 300-game slate is cheap.
test('memory path over a 300-game slate: zero selects, bounded time', async () => {
  const big = [];
  for (let i = 0; i < 300; i++) big.push({ ...store.getGames()[i % N_GAMES], game_id: `big${i}`, commence_time: iso(KICK + i * MIN) });
  const saved = store.getGames();
  store.setGames(big);
  store.setIntel('splits', big.map((g) => row(g.game_id, 'spread', 'Home -3', 60, 55)).map((x) => ({ ...x, fetched_at: iso(Date.now()) })));
  const before = fdb.calls.select.length;
  const t = process.hrtime.bigint();
  const r = await route.buildSplits(url());
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  store.setGames(saved);
  assert.equal(r.count, 300);
  assert.equal(fdb.calls.select.length, before);
  assert.ok(ms < 500, `buildSplits over 300 games × 12 books took ${ms.toFixed(1)} ms`);
});
