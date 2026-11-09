// ══════════════════════════════════════════════════════════════
// The production failure this PR actually fixed: not a totals line.
//
// Tonight's live error was `write|monitor_scores` — invalid input syntax for
// type integer: "222.5". 222.5 looks like a hook on a totals number, but no
// totals candidate exists on this slate (no consensusTotal on the game) — it
// is `computeMarkets(g).ml.consensus*`, an UNDERDOG moneyline median. American
// underdog prices sit in the 200s as routinely as favorite prices sit in the
// 100s-120s (D104's own example), so an even book count there averages to a
// half-point just as readily: +220 / +225 → 222.5. Same defect as D104/D108's
// 125.5 and -145.5, not a second column and not a second fix — this PR's
// `alter table monitor_scores alter column price type numeric;` already
// covers it, so this file is the proof that it does.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeMarkets } from '../src/games/lines.js';
import {
  readSchema, declaredColumns, assertDeclared, integerColumns, integerViolations,
} from './helpers/schema-ddl.js';

// Even book count, both underdog prices in the 200s — the same averaging
// mechanism as the +120/+131 favorite slate, just on the dog side.
const HOME = 'Golden State Warriors', AWAY = 'Phoenix Suns';
const GAME_ID = 'g-nba-dog-1';
const game = {
  sport: 'NBA', game_id: GAME_ID, home: HOME, away: AWAY,
  commence_time: '2026-11-07T23:00:00Z',
  books: {
    dk: { label: 'DK', markets: { [`h2h:${HOME}`]: { price: 220 }, [`h2h:${AWAY}`]: { price: -280 } } },
    fd: { label: 'FD', markets: { [`h2h:${HOME}`]: { price: 225 }, [`h2h:${AWAY}`]: { price: -300 } } },
  },
};
// No consensusTotal on the game, so the totals candidates never form and the
// only play signal-engine can build is the moneyline — the market that carries
// a price at all.
const intel = {
  splits: [{ sport: 'NBA', game_id: GAME_ID, market: 'ml', side: HOME, bets_pct: 78, handle_pct: 60, divergence: -18, rlm: true }],
  sharp: [{ game_id: GAME_ID, market: 'h2h', side: HOME, detail: 'steam: 3 books moved +220 → +225' }],
  weather: [], injuries: [], schedule: [], mlbContext: [], umpire: [], lineup: [], bullpenFatigue: [],
};

const inserts = [];
let signalRes;

before(async () => {
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      async select() { return []; },
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
      getIntel: () => [],
      signalsForGame: () => intel,
      getPower: () => ({}),
      getPredMarket: () => null,
      getBacktest: () => null,
      getNflTotals: () => null,
      getNflPace: () => null,
      setPlays: () => {},
    },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: { info() {}, warn() {}, error() {} },
      notifyAll: async () => ({ total: 0, email: true, sms: false }),
    },
  });
  const signal = (await import('../src/agents/signal-engine/index.js')).default;
  signalRes = await signal.run();
});
after(() => mock.reset());

test('the consensus median is exactly 222.5, not a total', () => {
  const ml = computeMarkets(game).ml;
  assert.equal(ml.consensusHome, 222.5, 'an even underdog-price book count averages to a half-point, same as a favorite does');
});

test('signal-engine sends 222.5 into monitor_scores.price, and this branch\'s numeric column accepts it', () => {
  assert.equal(signalRes.data.newAlerts, 1, 'two Tier-1 edges on the ML must qualify one play');
  assert.equal(signalRes.data.written, 1, 'and it must have landed — this is the PR, so the batch is not rejected');
  assert.equal(signalRes.blocked, undefined, 'a run that wrote is not blocked');

  const rows = inserts.filter((c) => c.table === 'monitor_scores').flatMap((c) => c.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 222.5);

  const cols = declaredColumns(readSchema(), 'monitor_scores');
  assertDeclared(cols, 'monitor_scores', ['price', 't1_count']);
  const ints = integerColumns(cols);
  assert.ok(ints.length > 0, 'monitor_scores declares t1_count integer — an empty list means the DDL parse went vacuous');
  assert.ok(!ints.includes('price'), 'price must not be among the columns still declared integer — that is the defect this PR fixes');
  const bad = integerViolations(cols, ints, rows[0]);
  assert.deepEqual(bad, [],
    `Postgres rejects the whole batch for these: ${bad.join('; ')} — same defect as pred_market_edges/125.5 (D104/D108), on the underdog side this time`);
});
