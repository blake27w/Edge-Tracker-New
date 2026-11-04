// ══════════════════════════════════════════════════════════════
// The movement baseline — rehydrated from line_snapshots, bounded by a
// staleness rule, and read with a query shape that rides an index.
//
// Why it exists: `lastLines` is process-local, so movement detection used to
// need two consecutive fetches BY THE SAME PROCESS. Every redeploy wiped it and
// the next fetch of each key detected nothing — `line_movements` was sparse as a
// function of deploy timing rather than market behaviour (D71).
//
// Three things here are load-bearing and none of them is visible in a passing
// run: that the baseline comparison lives in ONE function rather than inlined in
// normalize(), that a gap wider than the bound reseeds instead of emitting a
// fabricated magnitude (D72), and that every snapshot read carries `market` in
// its equality match — without it the composite index prefix stops at `game_id`
// and Postgres sorts every snapshot row the game ever accumulated.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';
// Not mocked: the degradation channel is the thing being asserted about, and a
// fake would not prove the real one ends up empty.
import { reportDegraded, getDegraded } from '../src/store/index.js';

const ALLOC = { A: 0.5, B: 0.5 };
const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Three games, deliberately out of kickoff order: the cap must take the two
// SOONEST, not the first two the API happened to list.
const KICKOFF = { g_late: now + 8 * 3600_000, g_soon: now + 30 * MIN, g_mid: now + 3 * 3600_000 };
const EVENT_ORDER = ['g_late', 'g_soon', 'g_mid'];

// One snapshot history: draftkings had the home side at -3 ten minutes ago, and
// an older -2.5 behind it that must NOT win (newest row per key).
const SNAPS = [
  { game_id: 'g_soon', book: 'draftkings', market: 'spreads', side: 'Home', line: -2.5, price: -105, fetched_at: iso(now - 90 * MIN) },
  { game_id: 'g_soon', book: 'draftkings', market: 'spreads', side: 'Home', line: -3, price: -110, fetched_at: iso(now - 10 * MIN) },
];

const ev = (id) => ({
  id, home_team: 'Home', away_team: 'Away', commence_time: iso(KICKOFF[id]),
  bookmakers: [{
    key: 'draftkings', last_update: iso(now),
    markets: [{
      key: 'spreads', last_update: iso(now),
      outcomes: [{ name: 'Home', point: -3.5, price: -112 }, { name: 'Away', point: 3.5, price: -108 }],
    }],
  }],
});

let mod;
let fdb;
let logs;
let movementInsertAttempts;

before(async () => {
  // The cap, lowered so "honoured" is observable: 3 games offered, 2 allowed.
  process.env.ODDS_HYDRATE_COLD_MAX = '2';
  process.env.ODDS_HYDRATE_MAX_GAMES = '1';

  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: { allocation: ALLOC, monthlyBudget: 20000, tier: 'starter', key: 'test-key',
        footballSports: [], footballPriority: 'false', footballPriorityOn: () => false,
        base: 'https://api.the-odds-api.com/v4' },
      SPORTS: { A: { key: 'k_A' }, B: { key: 'k_B' } },
      BOOKS: ['draftkings'], BOOK_LABELS: { draftkings: 'DK' },
      rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: false,
    },
  });

  fdb = fakeDb({ line_snapshots: SNAPS });
  const realInsert = fdb.insert;
  movementInsertAttempts = [];
  // The D70 shape: PostgREST rejects the WHOLE insert on an unknown column, so
  // the first attempt fails until the two `alter table` lines are hand-run.
  //
  // Thrown exactly as production throws it, which an error carrying `.code`
  // does NOT: db.insert rethrows `new Error('insert <table>: <msg>')` and
  // discards the code, so a test that sets `.code` short-circuits the only
  // branch that ever runs for real. And db.insert fires reportWriteFailure on
  // the way out, which is what leaves a `write|line_movements` degradation
  // standing — stood in for here, since db is faked.
  fdb.insert = async (table, rows) => {
    if (table === 'line_movements') {
      movementInsertAttempts.push(rows);
      if (movementInsertAttempts.length === 1) {
        const msg = "Could not find the 'gap_min' column of 'line_movements' in the schema cache";
        reportDegraded('write|line_movements', `insert line_movements failing — schema out of date (${msg}); run scripts/schema.sql`);
        throw new Error(`insert line_movements: ${msg}`);
      }
    }
    return realInsert(table, rows);
  };
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb,
    namedExports: { isMissingRelation: fdb.isMissingRelation },
  });

  const fl = fakeLogger();
  logs = fl.lines;
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: fl.logger, notifyAll: async () => ({ total: 0 }) },
  });

  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?')
      ? [{ key: 'k_A', active: true }, { key: 'k_B', active: true }]
      : (String(url).includes('/k_A/') ? EVENT_ORDER.map(ev) : [])),
  });

  mod = await import('../src/agents/odds/index.js');
});
after(() => mock.reset());

// ── baselineFromSnapshots: the pure projection ──────────────────
test('the newest row per key wins, which is what newest-first ordering buys', () => {
  const m = mod.baselineFromSnapshots([
    { game_id: 'g', book: 'dk', market: 'spreads', side: 'Home', line: -3.5, price: -110, fetched_at: iso(now) },
    { game_id: 'g', book: 'dk', market: 'spreads', side: 'Home', line: -3, price: -105, fetched_at: iso(now - MIN) },
  ]);
  assert.equal(m.size, 1);
  const e = m.get('g|dk|spreads|Home');
  assert.equal(e.line, -3.5);
  assert.equal(e.source, 'rehydrated');
  assert.equal(e.at, Date.parse(iso(now)));
});

test('a null line is no baseline at all — Number(null) is 0 and reads as a pick-em', () => {
  const m = mod.baselineFromSnapshots([
    { game_id: 'g', book: 'dk', market: 'h2h', side: 'Home', line: null, price: -110, fetched_at: iso(now) },
    { game_id: 'g', book: 'dk', market: 'spreads', side: 'Home', line: '', price: -110, fetched_at: iso(now) },
  ]);
  assert.equal(m.size, 0);
});

test('an unparseable stamp is skipped — a baseline with no age cannot be bounded', () => {
  const m = mod.baselineFromSnapshots([
    { game_id: 'g', book: 'dk', market: 'spreads', side: 'Home', line: -3, price: -110, fetched_at: 'not a date' },
    { game_id: 'g', book: 'dk', market: 'totals', side: 'Over', line: 44, price: -110, fetched_at: null },
  ]);
  assert.equal(m.size, 0);
});

test('both Postgres timestamp spellings parse to the same baseline age', () => {
  const z = '2026-10-17T12:00:00.500Z';
  for (const f of [z, z.replace('T', ' ').replace('Z', '+00:00'), z.replace('T', ' ').replace('Z', '+00')]) {
    const m = mod.baselineFromSnapshots([{ game_id: 'g', book: 'dk', market: 'spreads', side: 'Home', line: '-3', price: '-110', fetched_at: f }]);
    assert.equal(m.get('g|dk|spreads|Home').at, Date.parse(z), f);
    // Postgres hands numerics back as strings; a string line never compares
    // strictly equal to the number the feed gives us.
    assert.equal(m.get('g|dk|spreads|Home').line, -3);
  }
});

// ── movementFrom: the one comparison rule ───────────────────────
const cur = (line, price = -110) => ({ sport: 'A', game_id: 'g', market: 'spreads', book: 'dk', side: 'Home', line, price });

test('a move inside the bound is emitted, with its gap and its provenance', () => {
  const v = mod.movementFrom({ line: -3, price: -105, at: now - 12 * MIN, source: 'rehydrated' }, cur(-3.5), now);
  assert.equal(v.move.moved, -0.5);
  assert.equal(v.move.direction, 'down');
  assert.equal(v.move.line_open, -3);
  assert.equal(v.move.price_open, -105);
  assert.equal(v.move.gap_min, 12);
  assert.equal(v.move.baseline_source, 'rehydrated');
  assert.ok(!v.stale);
});

test('past the bound the move is counted stale, not written with a fabricated magnitude', () => {
  const v = mod.movementFrom({ line: -3, price: -105, at: now - 361 * MIN, source: 'rehydrated' }, cur(-3.5), now);
  assert.equal(v.move, undefined, 'a 6h+ gap conflates an unknown number of hops into one row');
  assert.equal(v.stale, true);
  // Just inside is still a move — the bound is 360 minutes, not "a few hours".
  assert.ok(mod.movementFrom({ line: -3, at: now - 359 * MIN, source: 'in-process' }, cur(-3.5), now).move);
});

test('an unchanged line is not a movement, and is not stale either', () => {
  assert.equal(mod.movementFrom({ line: -3.5, price: -110, at: now - 500 * MIN }, cur(-3.5), now), null);
  // '-3.5' from Postgres against -3.5 from the feed is the same line.
  assert.equal(mod.movementFrom({ line: '-3.5', price: -110, at: now - MIN }, cur(-3.5), now), null);
});

test('either side null emits nothing — a missing line is not a move to or from zero', () => {
  assert.equal(mod.movementFrom({ line: null, price: -110, at: now - MIN }, cur(-3.5), now), null);
  assert.equal(mod.movementFrom({ line: -3, price: -110, at: now - MIN }, cur(null), now), null);
  assert.equal(mod.movementFrom(undefined, cur(-3.5), now), null, 'no baseline at all is the first sighting');
});

test("an empty-string line is not a pick-em — Number('') is 0 and finite", () => {
  // Not reachable from the in-repo call sites today, but movementFrom is
  // exported and this is the D10/D67 shape it is documented to defend against:
  // a 3-point move off a line that never existed.
  assert.equal(mod.movementFrom({ line: '', at: now - MIN }, cur(-3), now), null);
  assert.equal(mod.movementFrom({ line: -3, at: now - MIN }, cur(''), now), null);
});

test('a baseline with no usable age is stale, never treated as fresh', () => {
  assert.equal(mod.movementFrom({ line: -3, at: NaN }, cur(-3.5), now).stale, true);
  assert.equal(mod.movementFrom({ line: -3, at: now + 10 * MIN }, cur(-3.5), now).stale, true,
    'a future stamp is clock skew, not a 0-minute gap');
});

// ── isMissingColumn: narrower than isMissingRelation, deliberately ──
test('only a missing COLUMN disables the extra columns, never a missing table', () => {
  // The messages, with no `.code`, are the production path: db.insert rethrows
  // `insert <table>: <msg>` and discards the code.
  for (const msg of [
    "insert line_movements: Could not find the 'gap_min' column of 'line_movements' in the schema cache",
    'insert line_movements: column "baseline_source" of relation "line_movements" does not exist',
  ]) assert.equal(mod.isMissingColumn(new Error(msg)), true, msg);

  for (const msg of [
    'insert line_movements: relation "line_movements" does not exist',
    "insert line_movements: Could not find the table 'public.line_movements' in the schema cache",
  ]) {
    assert.equal(mod.isMissingColumn(new Error(msg)), false,
      `a missing TABLE must not latch extraCols off for the process lifetime — once the table came back we would keep writing rows the reader rule calls non-authoritative: ${msg}`);
  }

  // Codes still win when PostgREST hands one through (count() does).
  assert.equal(mod.isMissingColumn(Object.assign(new Error('x'), { code: '42703' })), true);
  assert.equal(mod.isMissingColumn(Object.assign(new Error('x'), { code: 'PGRST204' })), true);
  assert.equal(mod.isMissingColumn(Object.assign(new Error('x'), { code: '42P01' })), false);
  assert.equal(mod.isMissingColumn(new Error('canceling statement due to statement timeout')), false);
  assert.equal(mod.isMissingColumn(null), false);
});

// ── The run: query shape, the cap, and the retry-strip guard ─────
test('one run hydrates from snapshots and detects movement on its FIRST fetch', async () => {
  const res = await mod.default.run();

  const reads = fdb.calls.select.filter((c) => c.table === 'line_snapshots');
  // 2 games (the cold cap) x 2 markets. Not 3 games, and not one query for all.
  // Two markets, not three: h2h outcomes carry no `point`, so every h2h row has
  // a null line and can never produce a baseline entry — reading it inflated the
  // cold burst by 50% for nothing.
  assert.equal(reads.length, 4, `expected 2 games x 2 markets, got ${reads.length}`);
  assert.equal(reads.filter((r) => r.opts.match.market === 'h2h').length, 0,
    'h2h lines are always null — querying them is pure cost');
  for (const r of reads) {
    assert.ok(r.opts.match && r.opts.match.game_id, 'game_id must be an equality match');
    assert.ok(r.opts.match.market, 'market must be an equality match too, or the index prefix stops at game_id');
    assert.equal(r.opts.order.column, 'fetched_at');
    assert.equal(r.opts.order.ascending, false, 'ASC + limit truncates the NEWEST rows');
    assert.ok(r.opts.limit > 0 && r.opts.limit <= 100, `bounded, got ${r.opts.limit}`);
    assert.ok(r.opts.gte && r.opts.gte.fetched_at, 'the staleness bound is also the read bound');
    assert.ok(!r.opts.in, 'an in(game_id, [...]) query cannot order off the composite index');
  }
  // The cap goes to the soonest kickoffs, not to API listing order.
  const hydrated = new Set(reads.map((r) => r.opts.match.game_id));
  assert.deepEqual([...hydrated].sort(), ['g_mid', 'g_soon']);

  // -3 ten minutes ago -> -3.5 now, across a process boundary this agent never
  // observed. Before the fix this run reported 0 movements.
  assert.equal(res.data.movements, 1, res.summary);
  assert.ok(res.data.rehydratedKeys > 0, 'rehydrated keys must be reported — it is how the manual check is decided');
  assert.equal(res.data.rehydratedGames, 2, 'games hydrated, which is NOT the same unit as keys filled');
  assert.equal(res.data.hydrateAttempted, 2);
  assert.equal(res.data.hydrateFailures, 0);
  assert.match(res.summary, /rehydrated/);

  const row = movementInsertAttempts[0][0];
  assert.equal(row.baseline_source, 'rehydrated');
  assert.equal(row.line_open, -3);
  assert.equal(row.line_current, -3.5);
  assert.ok(row.gap_min >= 9 && row.gap_min <= 12, `gap_min ~10, got ${row.gap_min}`);

  // The guard: the first insert was rejected for the un-migrated columns, so the
  // retry drops them and the movement still lands.
  assert.equal(movementInsertAttempts.length, 2, 'the insert must be retried, not abandoned');
  assert.equal('gap_min' in movementInsertAttempts[1][0], false);
  assert.equal('baseline_source' in movementInsertAttempts[1][0], false);
  assert.equal(movementInsertAttempts[1][0].line_current, -3.5, 'and nothing else is stripped');
  assert.ok(logs.warn.some((l) => /schema\.sql/.test(l)), `the missing columns must be logged once: ${logs.warn.join(' | ')}`);

  // And the retry leaves NO degradation standing. The failed probe reported
  // `write|line_movements`, and nothing used to retract it — so /data-health and
  // the watchdog would have called movement writes broken for the full 90-minute
  // TTL while every row was in fact landing, on the one channel built to surface
  // real silent write failure (D70).
  assert.equal(getDegraded().filter((d) => d.key === 'write|line_movements').length, 0,
    `a false alarm on the degradation channel is how it becomes noise: ${JSON.stringify(getDegraded())}`);
});

test('an in-process observation becomes the baseline, stamped and labelled', () => {
  const b = mod.getBaseline();
  const e = b.get('g_soon|draftkings|spreads|Home');
  assert.equal(e.line, -3.5, 'the live observation reseeds the key');
  assert.equal(e.source, 'in-process');
  assert.ok(e.at >= now, 'every entry carries an age');
});

test('a game that missed the cap is never hydrated afterwards', async () => {
  // A backwards baseline arriving AFTER a live observation would manufacture a
  // phantom move, so normalize() settles the game too.
  const reads = fdb.calls.select.filter((c) => c.table === 'line_snapshots').length;
  await mod.default.run();   // k_A is paced-skipped; nothing new to hydrate
  assert.equal(fdb.calls.select.filter((c) => c.table === 'line_snapshots').length, reads,
    'g_late was observed live, so its baseline is settled');
});

test('baselines are evicted once their game leaves the slate', async () => {
  mod.__resetBaseline();
  const b = mod.getBaseline();
  b.set('gone|draftkings|spreads|Home', { line: -3, price: -110, at: now, source: 'in-process' });
  await mod.default.run();
  assert.equal(b.has('gone|draftkings|spreads|Home'), false,
    'the Map was never pruned: ~66 keys per game x ~150 new games a day');
});
