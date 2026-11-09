// ══════════════════════════════════════════════════════════════
// Live symptom (2026-11-08 02:13Z): insert monitor_scores failing —
// invalid input syntax for type integer: "222.5"
//
// On the number alone this reads as a totals line (NBA/NFL totals commonly
// sit in the low 200s) — a DIFFERENT column from the `price` bug #150 fixes
// (ML prices "look like" small +/- juice). That reading does not survive
// checking the write path.
//
// `line` — the one column every totals writer actually uses — is declared
// `numeric` in schema.sql (never integer). monitor_scores has exactly two
// integer columns: `price` and `t1_count`. Neither signal-engine,
// public-fade, nor nfl.live ever puts a total (or anything total-derived)
// into either of them — verified here by actually running signal-engine and
// public-fade against a scripted even-book TOTALS-only slate (no h2h/ml
// books at all, so the only play either agent can build is a total) and
// checking every integer-declared column of the row each one emits.
//
// See monitor-scores-underdog-ml-price-type.test.js for where "222.5"
// actually comes from: the SAME monitor_scores.price defect PR #150 fixes
// (D104/D108), on an underdog price instead of a favorite.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readSchema, declaredColumns, assertDeclared, integerColumns, integerViolations } from './helpers/schema-ddl.js';

const HOME = 'Boston Celtics', AWAY = 'Miami Heat';
const GAME_ID = 'g-nba-totals-only';
// No h2h/ml books at all — the only play either agent can build is total.
const game = {
  sport: 'NBA', game_id: GAME_ID, home: HOME, away: AWAY,
  commence_time: '2026-11-07T23:00:00Z',
  consensusTotal: 222.5, // even-book total average — the exact value from the live error
  books: {
    dk: { label: 'DK', markets: { 'totals:Over': { line: 220, price: -110 }, 'totals:Under': { line: 220, price: -110 } } },
    fd: { label: 'FD', markets: { 'totals:Over': { line: 225, price: -110 }, 'totals:Under': { line: 225, price: -110 } } },
  },
};
const intel = {
  splits: [{ sport: 'NBA', game_id: GAME_ID, market: 'total', side: 'Over', bets_pct: 78, handle_pct: 60, divergence: -18, rlm: true }],
  sharp: [{ game_id: GAME_ID, market: 'totals', side: 'Under', detail: 'steam: 3 books moved Under' }],
  weather: [{ dome: false, wind_mph: 20, total_impact: 'under', wind_effect: 'in' }],
  injuries: [], schedule: [], mlbContext: [], umpire: [], lineup: [], bullpenFatigue: [],
};
const inserts = [];
let signalRes, fadeRes;

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
      getIntel: (k) => (k === 'splits' ? intel.splits : []),
      signalsForGame: () => intel,
      getPower: () => ({}),
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
  const signal = (await import('../src/agents/signal-engine/index.js')).default;
  const fade = (await import('../src/agents/public-fade/index.js')).default;
  signalRes = await signal.run();
  fadeRes = await fade.run();
});
after(() => mock.reset());

test('signal-engine and public-fade both qualify a totals play from this slate', () => {
  assert.equal(signalRes.data.newAlerts, 1, 'RLM + wind must qualify one Under play');
  assert.equal(fadeRes.data.graded, 1, 'heavy public + RLM must produce one graded fade');
});

test('every integer-declared monitor_scores column survives a totals row', () => {
  const cols = declaredColumns(readSchema(), 'monitor_scores');
  assertDeclared(cols, 'monitor_scores', ['price', 't1_count', 'line']);
  assert.equal(cols.line, 'numeric', 'the total itself lands in `line`, declared numeric — not the bug');
  const ints = integerColumns(cols);
  assert.ok(ints.length > 0, 'monitor_scores declares t1_count integer — an empty list means the DDL parse went vacuous');
  const rows = inserts.filter((c) => c.table === 'monitor_scores').flatMap((c) => c.rows);
  assert.ok(rows.length >= 2, `expected at least one row from each agent, got ${rows.length}`);
  for (const row of rows) {
    const bad = integerViolations(cols, ints, row);
    assert.deepEqual(bad, [], `a totals-only slate produced an integer violation: ${bad.join('; ')}`);
    assert.equal(row.price, null, 'neither agent prices a totals play — price must stay null, not the total');
    assert.equal(row.line, 222.5, 'the total itself does land in `line` — numeric, so this is not the bug');
  }
});
