// ══════════════════════════════════════════════════════════════
// The OTHER consumer of the odds agent's movement rows.
//
// The spec reasons about `sharp`, which reads its feed as a simultaneity claim
// and is right to be protected from a rehydrated six-hour drift. But
// `public-splits` asks a different question of the same rows — "did the
// public's own number move at all" — and answers it with
// `netMove = moves.total.get(game_id) ?? 0`. A movement WITHHELD from the feed
// it reads is therefore indistinguishable there from a line that did not move:
// the ?? turns absence into zero, and `freeze = !rlm && Math.abs(netMove) < 0.5`
// turns zero into a published tell. Filtering is subtractive only for a
// consumer asking about simultaneity.
//
// So odds publishes TWO feeds (D74): `movements`, gap-filtered, for `sharp`;
// and `movementsAll`, complete, for `public-splits`. This file proves both
// halves through the real agents — the wide-gap RLM reaches public-splits as
// an RLM, and the same row still does NOT reach sharp's feed.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';
import { getIntel, setIntel } from '../src/store/index.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const BOOKS = ['draftkings', 'fanduel', 'betmgm'];

let TOTAL = 43.5;

// 300 minutes old: inside the 360-minute write bound, outside the 35-minute
// steam bound. 44.5 -> 43.5 is a one-point drop with the public on Over, i.e.
// the textbook reverse-line-move the agent calls a Tier-1 signal.
const SNAPS = BOOKS.flatMap((book) => ['Over', 'Under'].map((side) => ({
  game_id: 'g1', book, market: 'totals', side,
  line: 44.5, price: -110, fetched_at: iso(now - 300 * MIN),
})));

const ev = () => ({
  id: 'g1', home_team: 'Bruins', away_team: 'Rangers', commence_time: iso(now + 20 * MIN),
  bookmakers: BOOKS.map((key) => ({
    key, last_update: iso(Date.now()),
    markets: [{
      key: 'totals', last_update: iso(Date.now()),
      outcomes: [{ name: 'Over', point: TOTAL, price: -110 }, { name: 'Under', point: TOTAL, price: -110 }],
    }],
  })),
});

let mod;
let splits;
let fdb;
const tick = () => new Promise((r) => setTimeout(r, 5));

before(async () => {
  for (const k of ['ODDS_STRIKE_MIN', 'ODDS_NEAR_MIN', 'ODDS_MID_MIN', 'ODDS_IDLE_MIN']) {
    process.env[k] = '0.000001';
  }

  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: { allocation: { NHL: 1 }, monthlyBudget: 20000, tier: 'starter', key: 'test-key',
        footballSports: [], footballPriority: 'false', footballPriorityOn: () => false,
        base: 'https://api.the-odds-api.com/v4' },
      SPORTS: { NHL: { key: 'icehockey_nhl' } },
      BOOKS, BOOK_LABELS: { draftkings: 'DK', fanduel: 'FD', betmgm: 'MGM' },
      rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: false,
    },
  });

  fdb = fakeDb({ line_snapshots: SNAPS });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb,
    namedExports: { isMissingRelation: fdb.isMissingRelation },
  });

  const fl = fakeLogger();
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: fl.logger,
      notifyAll: async () => ({ total: 0 }),
      hasClaude: () => true,
      claudeBlockReason: () => 'ANTHROPIC_API_KEY is not set in this deployment',
      // 78% of tickets on Over: lopsided, so the RLM / freeze rule engages.
      claudeJson: async () => ([{ game_id: 'g1', sport: 'NHL', market: 'total', side: 'Over', bets_pct: 78, handle_pct: 61 }]),
    },
  });

  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?') ? [{ key: 'icehockey_nhl', active: true }] : [ev()]),
  });

  mod = await import('../src/agents/odds/index.js');
  splits = (await import('../src/agents/public-splits/index.js')).default;
});
after(() => mock.reset());

test('a wide-gap RLM reaches public-splits as an RLM, and still never reaches sharp', async () => {
  const r = await mod.default.run();
  assert.equal(r.data.movements, 6, r.summary);
  assert.equal(r.data.steamDropped, 6, 'none of it is publishable as simultaneity');
  assert.equal(getIntel('movements').length, 0,
    "sharp's feed stays gap-filtered — a 300-minute drift is not coordinated money");
  assert.equal(getIntel('movementsAll').length, 6,
    'the complete feed loses nothing: every detected row is published for public-splits');
  assert.ok(getIntel('movementsAll').every((m) => Number.isFinite(Number(m.gap_min))),
    'rows in BOTH feeds stay self-identifying — gap_min rides along');

  const s = await splits.run();
  const row = getIntel('splits')[0];
  assert.equal(row.net_move, -3,
    'the Over rows carry the total, summed across the three books: -1 each');
  assert.equal(row.rlm, true,
    'books moved the number AGAINST 78% of the tickets — the Tier-1 signal, not a freeze');
  assert.equal(row.freeze, false);
  assert.match(s.summary, /1 RLM/, s.summary);
  await tick();
});

test('an in-cycle move reads the same way — the gap changes sharp\'s feed, not this one', async () => {
  TOTAL = 42.5;                // another full point down, now off an in-process baseline
  const r = await mod.default.run();
  assert.equal(r.data.steamDropped, 0, `gap is one run: ${r.summary}`);
  assert.equal(getIntel('movements').length, 6, 'now narrow enough for steam too');
  assert.equal(getIntel('movementsAll').length, 6);

  await splits.run();
  const row = getIntel('splits')[0];
  assert.equal(row.net_move, -3);
  assert.equal(row.rlm, true, 'same verdict as the wide-gap run: the question is the move, not its gap');
  assert.equal(row.freeze, false);
});

// ── Absence is absent ────────────────────────────────────────────
// D77 routed the complete feed here so a withheld row no longer READS as a
// freeze — but `netMove = moves.total.get(id) ?? 0` was the trap itself, and
// a game with no movement row at all (first run, feed empty, baseline not yet
// rehydrated) still published `freeze: true` off a zero nobody measured. The
// index is written straight into the store here: the question is what the
// agent does with a hole, a real zero, and a row with no usable magnitude, and
// the odds agent cannot be asked to produce the last two.
test('no movement row is "no line data", not a freeze', async () => {
  setIntel('movementsAll', []);
  const s = await splits.run();
  const row = getIntel('splits')[0];
  assert.equal(row.net_move, null, 'nothing was measured, so nothing is published as the measurement');
  assert.equal(row.rlm, null, 'not judged — distinct from a judged false');
  assert.equal(row.freeze, null, 'the old ?? 0 made this true: "I have no data" published as a tell');
  assert.match(s.summary, /0 freeze/, s.summary);
  assert.match(s.summary, /1 no line data/, 'the run says WHY the rule did not fire');
  assert.equal(s.data.noMoveData, 1);
});

test('a line that genuinely moved zero IS a freeze — zero and absent stay distinct', async () => {
  setIntel('movementsAll', [{ game_id: 'g1', market: 'totals', side: 'Over', moved: 0 }]);
  const s = await splits.run();
  const row = getIntel('splits')[0];
  assert.equal(row.net_move, 0, 'a measured zero is published as a zero');
  assert.equal(row.rlm, false);
  assert.equal(row.freeze, true, 'books held the number against 78% of the tickets — that is the tell');
  assert.match(s.summary, /1 freeze/, s.summary);
  assert.match(s.summary, /0 no line data/, s.summary);
});

test('a movement row with no usable `moved` adds no entry — it is not a zero', async () => {
  // Number(null), Number(''), Number(false) are all a finite 0 (house rule),
  // and `(m.moved || 0)` in moveIndexes read every one of them as "did not
  // move". Over-row magnitude missing, Under-row present: the Over row is the
  // one the total index is built from, so the index must have no entry.
  for (const bad of [null, undefined, '', NaN, false, '1']) {
    setIntel('movementsAll', [
      { game_id: 'g1', market: 'totals', side: 'Over', moved: bad },
      { game_id: 'g1', market: 'totals', side: 'Under', moved: -1 },
    ]);
    await splits.run();
    const row = getIntel('splits')[0];
    assert.equal(row.net_move, null, `moved=${String(bad)} must not coerce to a measured 0`);
    assert.equal(row.freeze, null, `moved=${String(bad)} must not publish as a freeze`);
  }
});
