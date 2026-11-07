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
//  2. `price` must stay the UNROUNDED consensus, because `book_prob` in the same
//     row is devigged from that exact number — rounding the price would leave
//     the row internally inconsistent (a price that cannot reproduce its own
//     implied probability), which is corruption in the other direction.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeMarkets } from '../src/games/lines.js';

const SCHEMA = new URL('../scripts/schema.sql', import.meta.url);

// Column name → declared type for one `create table` block in schema.sql,
// plus any later `alter table … add column` for the same table.
function declaredColumns(sql, table) {
  const block = new RegExp(`create table if not exists ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
  assert.ok(block, `no create table block for ${table} in schema.sql`);
  const cols = {};
  for (const raw of block[1].split('\n')) {
    const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '');
    if (!line || /^(primary|unique|foreign|constraint|check)\b/i.test(line)) continue;
    const m = /^([a-z_][a-z0-9_]*)\s+(.+)$/i.exec(line);
    if (m) cols[m[1]] = m[2].trim().toLowerCase();
  }
  const alter = new RegExp(`alter table ${table} add column if not exists ([a-z_][a-z0-9_]*)\\s+([^;]+);`, 'gi');
  for (const m of sql.matchAll(alter)) cols[m[1]] = m[2].trim().toLowerCase();
  return cols;
}

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
  const res = await agent.run();
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
  const cols = declaredColumns(readFileSync(SCHEMA, 'utf8'), 'pred_market_edges');
  const ints = Object.keys(cols).filter((c) => /^(integer|int|int4|bigint|int8|smallint|int2)\b/.test(cols[c]));
  const r = row();
  const bad = ints
    .filter((c) => r[c] != null && !Number.isInteger(r[c]))
    .map((c) => `${c} (declared ${cols[c]}) got ${JSON.stringify(String(r[c]))}`);
  assert.deepEqual(bad, [],
    `Postgres rejects the whole batch for these: ${bad.join('; ')} — the consensus median is not an integer, so the column must be numeric`);
});

test('price stays the unrounded consensus median that book_prob was devigged from', () => {
  const consensus = computeMarkets(game).ml.consensusHome;
  assert.equal(consensus, 125.5, 'an even book count averages the two middle prices');
  assert.equal(row().price, consensus,
    'rounding price would leave a row whose book_prob cannot be reproduced from its own price');
});

