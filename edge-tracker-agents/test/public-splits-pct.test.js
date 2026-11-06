// ══════════════════════════════════════════════════════════════
// Absent is not zero — the PERCENTAGE half of D96.
//
// D96 closed the trap for `moved`; `num()` in the same file still validated
// the coercion instead of the input. `Number(null)`, `Number('')` and
// `Number(false)` are all a finite 0, so a Claude row with `bets_pct: null`
// published "0% tickets" (the dashboard tests `!= null`, so 0 renders),
// `divergence = handle - 0` became a large fake sharp-side tell, and the 0
// was stored in `prevBets` so the NEXT run's genuine 75% fired `pileon`. A
// row could say "no line data" and "0% tickets" in the same object.
//
// The agent is driven directly: the slate is seeded through the store and
// `claudeJson` returns whatever ROWS holds, so each case names exactly the
// shape of input it is about. `prevBets` is module state that survives across
// runs, which is precisely what the pile-on cases need — each uses its own
// game_id so no case inherits a prior from another.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';
import { getIntel, setIntel, setGames } from '../src/store/index.js';

let ROWS = [];
let splits;

before(async () => {
  const fdb = fakeDb({});
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
      claudeJson: async () => ROWS,
    },
  });
  splits = (await import('../src/agents/public-splits/index.js')).default;

  setGames([
    { game_id: 'g1', sport: 'NHL', home: 'Boston Bruins', away: 'New York Rangers' },
    { game_id: 'g2', sport: 'NHL', home: 'Toronto Maple Leafs', away: 'Montreal Canadiens' },
  ]);
  setIntel('movementsAll', []);
});
after(() => mock.reset());

const run = async (rows) => { ROWS = rows; const s = await splits.run(); return { s, out: getIntel('splits') }; };

// ── A missing percentage is null, not 0 ───────────────────────────
test('null / "" / false / "abc" percentages publish as null, with no divergence', async () => {
  for (const bad of [null, undefined, '', '   ', false, 'abc', NaN]) {
    const { out } = await run([
      { game_id: 'g1', sport: 'NHL', market: 'total', side: 'Over', bets_pct: bad, handle_pct: 64 },
    ]);
    const row = out[0];
    assert.equal(row.bets_pct, null, `bets_pct=${String(bad)} must not coerce to a measured 0`);
    assert.equal(row.handle_pct, 64, 'the present half is still published');
    assert.equal(row.divergence, null, `bets_pct=${String(bad)}: handle − nothing is not a sharp-side tell`);
    assert.equal(row.rlm, false, 'not lopsided — a missing % cannot be ≥ 70');
    assert.equal(row.freeze, false);
    assert.equal(row.pileon, false);
  }
});

test('the same holds for handle_pct — divergence needs BOTH readings', async () => {
  for (const bad of [null, '', false, 'abc']) {
    const { out } = await run([
      { game_id: 'g1', sport: 'NHL', market: 'total', side: 'Over', bets_pct: 78, handle_pct: bad },
    ]);
    const row = out[0];
    assert.equal(row.handle_pct, null, `handle_pct=${String(bad)} must not coerce to 0`);
    assert.equal(row.bets_pct, 78);
    assert.equal(row.divergence, null, `handle_pct=${String(bad)}: 0 − 78 is not a −78 tell`);
  }
});

// ── A real 0 stays 0 ───────────────────────────────────────────────
test('a genuine 0 is a reading: published as 0, and it feeds divergence', async () => {
  const { out } = await run([
    { game_id: 'g1', sport: 'NHL', market: 'total', side: 'Over', bets_pct: 0, handle_pct: 12 },
  ]);
  assert.equal(out[0].bets_pct, 0, 'zero and absent stay distinct');
  assert.equal(out[0].divergence, 12);
});

test('a numeric string is accepted — "78" is a reading, "" is not', async () => {
  const { out } = await run([
    { game_id: 'g1', sport: 'NHL', market: 'total', side: 'Over', bets_pct: '78', handle_pct: '61.5' },
  ]);
  assert.equal(out[0].bets_pct, 78);
  assert.equal(out[0].handle_pct, 61.5);
  assert.equal(out[0].divergence, -16.5);
});

// ── No phantom pile-on ─────────────────────────────────────────────
// The prior written by a run with no reading must be NO prior: the next
// genuine 75% is the first thing seen, not a +75 surge.
test('a missing percentage is never written as the prior, so the next real reading is not a pile-on', async () => {
  for (const bad of [null, '', false, 'abc']) {
    const id = `pile-${String(bad)}`;
    setGames([{ game_id: id, sport: 'NHL', home: 'Boston Bruins', away: 'New York Rangers' }]);
    const first = await run([{ game_id: id, sport: 'NHL', market: 'total', side: 'Over', bets_pct: bad, handle_pct: 60 }]);
    assert.equal(first.out[0].pileon, false);
    const second = await run([{ game_id: id, sport: 'NHL', market: 'total', side: 'Over', bets_pct: 75, handle_pct: 60 }]);
    assert.equal(second.out[0].pileon, false,
      `bets_pct=${String(bad)} then 75: the old num() stored 0 as the prior and 75 − 0 ≥ 10 fired pile-on`);
    assert.match(second.s.summary, /0 pile-on/, second.s.summary);
  }
});

test('a real surge still IS a pile-on — a measured 0 prior counts, a 62 → 75 jump counts', async () => {
  setGames([{ game_id: 'surge', sport: 'NHL', home: 'Boston Bruins', away: 'New York Rangers' }]);
  await run([{ game_id: 'surge', sport: 'NHL', market: 'total', side: 'Over', bets_pct: 62, handle_pct: 60 }]);
  const { out, s } = await run([{ game_id: 'surge', sport: 'NHL', market: 'total', side: 'Over', bets_pct: 75, handle_pct: 60 }]);
  assert.equal(out[0].pileon, true);
  assert.match(s.summary, /1 pile-on/, s.summary);
});

// ── A row the RLM rule cannot judge is counted, not judged false ────
test('a lopsided spread row whose game is off the slate is "no line data", not rlm:false', async () => {
  setGames([{ game_id: 'g1', sport: 'NHL', home: 'Boston Bruins', away: 'New York Rangers' }]);
  setIntel('movementsAll', [{ game_id: 'g1', market: 'spreads', side: 'boston bruins', moved: 0.5 }]);
  const { out, s } = await run([
    // game_id not on the slate: no team to key on, side resolves by the literal
    // "home" substring, so no index can even be chosen.
    { game_id: 'off-slate', sport: 'NHL', market: 'spread', side: 'Home -1.5', bets_pct: 74, handle_pct: 70 },
    // ML is the intentional exception — no line history by design, stays false.
    { game_id: 'g1', sport: 'NHL', market: 'ml', side: 'HomeML', bets_pct: 74, handle_pct: 70 },
  ]);
  const [spread, ml] = out;
  assert.equal(spread.rlm, null, 'could not judge ≠ judged false');
  assert.equal(spread.freeze, null);
  assert.equal(spread.net_move, null);
  assert.equal(ml.rlm, false, 'ML is "this rule does not apply", not "no data"');
  assert.equal(ml.freeze, false);
  assert.equal(s.data.noMoveData, 1, 'the spread row is counted; the ML row is not');
  assert.match(s.summary, /1 no line data/, s.summary);
  setIntel('movementsAll', []);
});
