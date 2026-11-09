// ══════════════════════════════════════════════════════════════
// pred_market_edges.price must hold the consensus the agent actually computes.
//
// The live failure (2026-11-07 19:13Z, /health.system.degraded carried
// `write|pred_market_edges` ×9):
//
//   insert pred_market_edges failing — invalid input syntax for type integer: "125.5"
//
// `price` is declared `integer` in scripts/schema.sql, but the value written is
// `computeMarkets(g).ml.consensusHome` — the MEDIAN moneyline across the books,
// and median() averages the two middle values when the book count is even
// (src/games/lines.js:10), so an even slate of +120 / +131 yields 125.5. That is
// the same median() whose spread/total output every other table stores in a
// `numeric` column; only this one calls it a price and declares it integer.
//
// PostgREST applies a batch insert as ONE statement, so a single half-point
// consensus anywhere in the batch discards every exchange edge in that run, and
// the agent's `catch { logger.warn }` (pred-market/index.js:115) means the run
// still reports success. The degraded key is the only trace.
//
// These tests drive the real run() against a scripted Polymarket payload and a
// scripted even-book slate, then check the row it emits against the DDL itself:
//
//  1. every column scripts/schema.sql declares `integer` for this table must
//     receive an integer — this is the failing assertion, and the fix is the
//     DDL (`price numeric`), not a round in the agent;
//  2. `price` must stay the UNROUNDED consensus, on FIDELITY grounds: a median
//     across books is not a price any book quoted, and rounding it would store
//     a quote that never existed, in a column whose other writers hold real
//     feed prices. (D104 argued this from reproducibility — "the row could no
//     longer reproduce its own book_prob" — which does not hold: book_prob is
//     devigged from BOTH sides' prices, so a row carrying only the played
//     side's price cannot reproduce it either way. D108 corrects that.) The
//     round belongs at whichever consumer needs an integer quote.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeMarkets } from '../src/games/lines.js';
import {
  readSchema, declaredColumns, assertDeclared, integerColumns, integerViolations,
} from './helpers/schema-ddl.js';

// An even number of books on both sides, so every median is an average of two.
// Home +120 / +131 → consensus 125.5, the exact value the live error quoted.
const HOME = 'Boston Celtics', AWAY = 'Miami Heat';
const game = {
  sport: 'NBA', game_id: 'g-nba-1', home: HOME, away: AWAY,
  commence_time: '2026-11-07T23:00:00Z',
  books: {
    dk: { label: 'DK', markets: { [`h2h:${HOME}`]: { price: 120 }, [`h2h:${AWAY}`]: { price: -140 } } },
    fd: { label: 'FD', markets: { [`h2h:${HOME}`]: { price: 131 }, [`h2h:${AWAY}`]: { price: -150 } } },
  },
};

// Polymarket prices the home side at 0.50 — well above the book's devigged
// ~0.428, so the home side clears PRED_EDGE_PCT and a row is emitted.
const polyPayload = [{
  outcomes: JSON.stringify([HOME, AWAY]),
  outcomePrices: JSON.stringify(['0.50', '0.50']),
  volumeNum: 250000,
}];

const inserts = [];
const realFetch = global.fetch;
let res;

before(async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('polymarket')) return { ok: true, json: async () => polyPayload };
    return { ok: true, json: async () => ({ markets: [] }) };          // Kalshi: nothing liquid
  };
  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: { predictionMarkets: true, dryRun: false },
  });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      async insert(table, rows) { inserts.push({ table, rows }); return { data: rows, count: rows.length }; },
    },
  });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: { getGames: () => [game], setPredMarket: () => {} },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: { info() {}, warn() {}, error() {} } },
  });
  const agent = (await import('../src/agents/pred-market/index.js')).default;
  res = await agent.run();
  assert.equal(res.data.edges, 1, 'the scripted slate must produce exactly one exchange edge');
});
after(() => { global.fetch = realFetch; mock.reset(); });

const row = () => {
  const call = inserts.find((c) => c.table === 'pred_market_edges');
  assert.ok(call, 'the agent must attempt the pred_market_edges insert');
  assert.equal(call.rows.length, 1);
  return call.rows[0];
};

test('every pred_market_edges column declared integer receives an integer', () => {
  const cols = declaredColumns(readSchema(), 'pred_market_edges');
  // The anti-vacuity guard. "Each integer column got an integer" is satisfied
  // by an empty list, and after the fix this table HAS no integer column — the
  // fix is precisely that `price` stopped being one — so `ints.length > 0` is
  // not available here. What is pinned instead is the parse: these three
  // columns must have come out of the DDL with a declared type, so a
  // reformatted `create table` block fails rather than quietly reading zero
  // columns and agreeing with everything. (monitor_scores keeps `t1_count`, so
  // its copy of this test asserts the length as well.)
  assertDeclared(cols, 'pred_market_edges', ['price', 'exch_prob', 'vol']);
  const ints = integerColumns(cols);
  const r = row();
  const bad = integerViolations(cols, ints, r);
  assert.deepEqual(bad, [],
    `Postgres rejects the whole batch for these: ${bad.join('; ')} — the consensus median is not an integer, so the column must be numeric`);
});

test('price stays the unrounded consensus median — rounding is the consumer\'s job', () => {
  const consensus = computeMarkets(game).ml.consensusHome;
  assert.equal(consensus, 125.5, 'an even book count averages the two middle prices');
  assert.equal(row().price, consensus,
    'a median is not a price any book quoted; rounding it would store a quote that never existed (D108)');
});

test('a run that wrote its batch returns no blocked reason', () => {
  // The other half of the blocked contract pinned in the honesty test: a run
  // without `blocked` is what the orchestrator reads as recovery, and is the
  // only way a standing block ever clears.
  assert.equal(res.data.written, 1, 'the scripted insert succeeds');
  assert.equal(res.data.lost, 0);
  assert.equal(res.blocked, undefined, 'a run that wrote is not blocked');
});
