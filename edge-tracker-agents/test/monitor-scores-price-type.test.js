// ══════════════════════════════════════════════════════════════
// monitor_scores.price must hold the consensus the agents actually compute.
//
// The companion of pred-market-price-type.test.js, for the other half of D104.
// `pred_market_edges.price` is where the `integer` declaration was caught, by a
// live failure nine runs deep:
//
//   insert pred_market_edges failing — invalid input syntax for type integer: "125.5"
//
// `monitor_scores.price` carried the identical latent bug (`alter table
// monitor_scores add column if not exists price integer`) and had simply not
// been handed an even-book moneyline yet — the graded-plays record, one
// half-point consensus away from discarding every new play in a run. It
// receives the same `computeMarkets(g).ml.consensus*` median from
// `signal-engine/index.js` and `public-fade/index.js`, and median() averages
// the two middle prices when the book count is even (src/games/lines.js), so an
// even slate of +120 / +131 yields 125.5.
//
// The reason to drive the REAL run()s rather than a row builder: the row that
// reaches Postgres is assembled inside run() (signal-engine strips
// commence_time on the way to the insert, public-fade picks price only on the
// `ml` branch), and the bug is a property of the row that is actually sent.
//
// A scripted slate, then: one NBA game with an even number of books on both
// sides, driven through both agents, and every column scripts/schema.sql
// declares `integer` for monitor_scores is checked against the row each agent
// emits. Unlike pred_market_edges — which after the fix has no integer column
// left at all — monitor_scores keeps `t1_count integer`, so this file can also
// assert the integer list is non-empty and know the check is doing work.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeMarkets } from '../src/games/lines.js';
import {
  readSchema, declaredColumns, assertDeclared, integerColumns, integerViolations,
} from './helpers/schema-ddl.js';

// An even number of books on BOTH sides, so every median is an average of two.
// Home +120 / +131 → consensus 125.5, the exact value the live error quoted.
// Away −140 / −151 → consensus −145.5, so the faded side is a half too: a slate
// where only one side landed on a half would let one of the two agents pass.
const HOME = 'Boston Celtics', AWAY = 'Miami Heat';
const GAME_ID = 'g-nba-1';
const game = {
  sport: 'NBA', game_id: GAME_ID, home: HOME, away: AWAY,
  commence_time: '2026-11-07T23:00:00Z',
  books: {
    dk: { label: 'DK', markets: { [`h2h:${HOME}`]: { price: 120 }, [`h2h:${AWAY}`]: { price: -140 } } },
    fd: { label: 'FD', markets: { [`h2h:${HOME}`]: { price: 131 }, [`h2h:${AWAY}`]: { price: -151 } } },
  },
};
// No consensusTotal on the game, so the totals candidates never form and the
// only play either agent can build is the moneyline — the market that carries a
// price at all.

// signal-engine qualifies a play on two independent Tier-1 edges: RLM vs heavy
// public, and steam on the side being played (score 50 + 20 + 20 = 90, over the
// 70 floor, t1 = 2 ≥ minPrimary). The steam signal is also what names the side.
const intel = {
  splits: [{ sport: 'NBA', game_id: GAME_ID, market: 'ml', side: HOME, bets_pct: 78, handle_pct: 60, divergence: -18, rlm: true }],
  sharp: [{ game_id: GAME_ID, market: 'h2h', side: HOME, detail: 'steam: 3 books moved +120 → +131' }],
  weather: [], injuries: [], schedule: [], mlbContext: [], umpire: [], lineup: [], bullpenFatigue: [],
};
// public-fade needs the same lopsided public side plus a market tell (the RLM),
// and fades it — so the play it grades is AWAY at the away consensus.
const fadeSplits = intel.splits;

const inserts = [];
let signalRes, fadeRes;

before(async () => {
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      async select() { return []; },                                  // nothing pending → no dedupe
      async insert(table, rows) {
        const arr = Array.isArray(rows) ? rows : [rows];
        inserts.push({ table, rows: arr });
        return { data: arr, count: arr.length };
      },
    },
  });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: {
      getGames: () => [game],
      getIntel: (k) => (k === 'splits' ? fadeSplits : []),
      signalsForGame: () => intel,
      getPower: () => ({}),                                           // no power ratings → no soft side
      getPredMarket: () => null,
      getBacktest: () => null,
      getNflTotals: () => null,
      getNflPace: () => null,
      setPlays: () => {},
      setFadePlays: () => {},
    },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: { info() {}, warn() {}, error() {} },
      notifyAll: async () => ({ total: 0, email: true, sms: false }),
    },
  });
  // config is the real one: the thresholds a play has to clear (confidenceFloor,
  // minPrimary, maxOppJuice) are what decide whether a row exists to check.
  const signal = (await import('../src/agents/signal-engine/index.js')).default;
  const fade = (await import('../src/agents/public-fade/index.js')).default;
  signalRes = await signal.run();
  fadeRes = await fade.run();
});
after(() => mock.reset());

// The monitor_scores row each agent sent, found by the signals it carries —
// both agents write the same table in the same process.
function rowFrom(agent) {
  const rows = inserts.filter((c) => c.table === 'monitor_scores').flatMap((c) => c.rows);
  const mine = rows.filter((r) => (agent === 'fade' ? r.tier === 'FADE (obs)' : r.tier !== 'FADE (obs)'));
  assert.equal(mine.length, 1, `${agent} must send exactly one monitor_scores row — got ${mine.length}`);
  return mine[0];
}

test('the scripted slate produces one play from each agent', () => {
  assert.equal(signalRes.data.newAlerts, 1, 'two Tier-1 edges on the ML must qualify one play');
  assert.equal(signalRes.data.written, 1, 'and it must have landed');
  assert.equal(fadeRes.data.graded, 1, 'heavy public + RLM must produce one graded fade');
  assert.equal(fadeRes.data.written, 1, 'and it must have landed');
  // The other half of the blocked contract: a run that WROTE must return no
  // reason, because that is the only way the orchestrator clears a standing
  // block (a run without `blocked` reads as recovery — nfl-line-move's note).
  assert.equal(signalRes.blocked, undefined, 'a run that wrote is not blocked');
  assert.equal(fadeRes.blocked, undefined, 'a run that wrote is not blocked');
});

test('every monitor_scores column declared integer receives an integer from signal-engine', () => {
  const cols = declaredColumns(readSchema(), 'monitor_scores');
  assertDeclared(cols, 'monitor_scores', ['price', 't1_count', 'score']);
  const ints = integerColumns(cols);
  // Available here and not on pred_market_edges: `t1_count integer` keeps this
  // list non-empty by construction, so an empty one means the parse broke.
  assert.ok(ints.length > 0, 'monitor_scores declares t1_count integer — an empty list means the DDL parse went vacuous');
  const bad = integerViolations(cols, ints, rowFrom('signal'));
  assert.deepEqual(bad, [],
    `Postgres rejects the whole batch for these: ${bad.join('; ')} — the consensus median is not an integer, so the column must be numeric`);
});

test('every monitor_scores column declared integer receives an integer from public-fade', () => {
  const cols = declaredColumns(readSchema(), 'monitor_scores');
  assertDeclared(cols, 'monitor_scores', ['price', 't1_count', 'score']);
  const ints = integerColumns(cols);
  assert.ok(ints.length > 0, 'monitor_scores declares t1_count integer — an empty list means the DDL parse went vacuous');
  const bad = integerViolations(cols, ints, rowFrom('fade'));
  assert.deepEqual(bad, [],
    `Postgres rejects the whole batch for these: ${bad.join('; ')} — the consensus median is not an integer, so the column must be numeric`);
});

test('both agents send the unrounded consensus median — rounding is the consumer\'s job', () => {
  const ml = computeMarkets(game).ml;
  assert.equal(ml.consensusHome, 125.5, 'an even book count averages the two middle prices');
  assert.equal(ml.consensusAway, -145.5, 'both sides, so neither agent can pass on an integer by luck');
  // A median is not a price any book quoted; storing a rounded one would store
  // a quote that never existed (D108 corrects D104's reproducibility argument).
  // grading/index.js pays ML win P&L at this number — if payout fidelity ever
  // matters, the round belongs there, at the consumer, not in the row.
  assert.equal(rowFrom('signal').price, ml.consensusHome, 'signal-engine plays the home side the steam named');
  assert.equal(rowFrom('fade').price, ml.consensusAway, 'public-fade plays the side opposite the public');
});
