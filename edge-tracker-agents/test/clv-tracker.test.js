// ══════════════════════════════════════════════════════════════
// CLV tracker — the close/entry selection and the price-aware verdict.
//
// These are the cases worth keeping above all others in this suite, because
// the bug they cover was INVISIBLE at small data volumes: with fewer than
// ~1000 snapshot rows for a game the old code behaved correctly, and only
// past that did it start silently comparing against a truncated close. A test
// that seeds a realistic row count is the only thing that catches it.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const BOOKS = ['dk', 'fd', 'mgm', 'czr', 'pn', 'br', 'wh', 'esp'];   // 8 books per batch
const T = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();

// One odds poll writes one INSERT, and Postgres `now()` is the statement
// timestamp — so every row in a batch shares a fetched_at. That is what makes
// batching by fetched_at valid, and what the fixtures reproduce.
const batch = (ts, line, price, commence, side = 'Under') =>
  BOOKS.map((b) => ({ game_id: 'G', market: 'totals', side, book: b, line, price, fetched_at: ts, commence_time: commence }));

let db, degraded, capture;

before(async () => {
  db = fakeDb();
  degraded = [];
  const { logger } = fakeLogger();
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: { setClvReport: () => {}, reportDegraded: (k, d) => degraded.push({ k, d }) },
  });
  ({ capture } = await import('../src/agents/clv-tracker/index.js'));
});
after(() => mock.reset());

const play = (over = {}) => ({ sport: 'NFL', game_id: 'G', market: 'total', side: 'Under', line: 44.5, scored_at: T(290), ...over });

// ── The original bug, at the volume where it appears ────────────
test('close is the newest batch even when the game has more rows than the query limit', async () => {
  // 200 batches x 8 books = 1600 rows for ONE game/market/side — what a game
  // that sits on the board for days actually accumulates, and well past the
  // old `limit: 1000`. The total drifts 42.5 -> 46.5; the true close is 46.5.
  const kickoff = T(5);
  const rows = [];
  const N = 200;
  for (let i = N; i >= 2; i--) {
    const line = 42.5 + (N - i) * (4 / (N - 1));
    rows.push(...batch(T(i * 10), Math.round(line * 2) / 2, -110, kickoff));
  }
  rows.push(...batch(T(6), 46.5, -110, kickoff));        // last pre-kickoff batch
  db.setRows('line_snapshots', rows);

  const r = await capture(play({ scored_at: T(1000) }));
  assert.equal(r.line_close, 46.5, 'must use the real close, not a truncated early batch');
  assert.equal(r.clv, 2, 'Under 44.5 against a 46.5 close is +2');
  assert.equal(r.beat_close, true);
  assert.equal(r.suspect, false);
  assert.notEqual(r.entry_at, r.close_at, 'entry and close must be distinct batches');
});

test('a play logged after every snapshot is unmeasurable, not "suspect with clv 0"', async () => {
  const kickoff = T(5);
  db.setRows('line_snapshots', [...batch(T(300), 44.5, -110, kickoff), ...batch(T(200), 45.5, -110, kickoff)]);
  const r = await capture(play({ scored_at: T(400) }));
  assert.deepEqual(r, { unmeasurable: true }, 'nothing to compare → write nothing');
});

test('a single snapshot batch is unmeasurable and is never persisted', async () => {
  db.setRows('line_snapshots', batch(T(20), 44.5, -110, T(5)));
  assert.deepEqual(await capture(play()), { unmeasurable: true });
});

// ── Price-aware verdict ─────────────────────────────────────────
test('flat line with an improved price beats the close', async () => {
  const k = T(5);
  db.setRows('line_snapshots', [...batch(T(300), 44.5, -105, k), ...batch(T(20), 44.5, -120, k)]);
  const r = await capture(play());
  assert.equal(r.clv, 0, 'the number held');
  assert.equal(r.clv_odds, 3.3, 'but we locked -105 against a -120 close');
  assert.equal(r.beat_close, true, 'price breaks the tie');
});

test('flat line with a worsened price does not beat the close', async () => {
  const k = T(5);
  db.setRows('line_snapshots', [...batch(T(300), 44.5, -120, k), ...batch(T(20), 44.5, -105, k)]);
  const r = await capture(play());
  assert.equal(r.clv_odds, -3.3);
  assert.equal(r.beat_close, false);
});

test('flat line with no prices is UNKNOWN, not a miss', async () => {
  // This is the case that pinned the reported beat-rate near zero: scoring an
  // unknowable close as `false` makes every flat spread/total a loss.
  const k = T(5);
  db.setRows('line_snapshots', [...batch(T(300), 44.5, null, k), ...batch(T(20), 44.5, null, k)]);
  const r = await capture(play());
  assert.equal(r.clv_odds, null);
  assert.equal(r.beat_close, null, 'unknown must be null so the report can exclude it');
});

test('a missing price never becomes odds of 0', async () => {
  // Number(null) is 0 and 0 IS finite, so mapping before filtering turned a
  // missing price into an impossible American price that dragged the median.
  const k = T(5);
  const mixed = [...batch(T(300), 44.5, -110, k)];
  mixed[0].price = null; mixed[1].price = null;
  db.setRows('line_snapshots', [...mixed, ...batch(T(20), 44.5, -110, k)]);
  const r = await capture(play());
  assert.equal(r.odds_logged, -110, 'median must ignore the nulls, not treat them as 0');
});

test('Over is the mirror of Under: it wants the number to fall', async () => {
  const k = T(5);
  db.setRows('line_snapshots', [...batch(T(300), 46.5, -110, k, 'Over'), ...batch(T(20), 44.5, -110, k, 'Over')]);
  const r = await capture(play({ side: 'Over', line: 46.5 }));
  assert.equal(r.clv, 2);
  assert.equal(r.beat_close, true);
});

// ── In-play lines must never be read as the close ────────────────
test('post-kickoff snapshots are excluded from the close', async () => {
  // The feed keeps serving a game after kickoff and we retain it for 6h, so the
  // newest batch can be a live in-game line. Taking it fabricates CLV that then
  // gets locked in permanently. Same trap D4 found in the history agents.
  const kickoff = T(60);
  db.setRows('line_snapshots', [
    ...batch(T(300), 44.5, -110, kickoff),   // entry
    ...batch(T(65), 46.5, -110, kickoff),    // true close, 5 min pre-kickoff
    ...batch(T(10), 33.5, -110, kickoff),    // IN-PLAY: scoreless first half
  ]);
  const r = await capture(play());
  assert.equal(r.line_close, 46.5, 'must not take the 33.5 in-play number');
  assert.equal(r._inPlayDropped, 8, 'and should report what it ignored');
});

test('a game with only in-play snapshots is unmeasurable', async () => {
  db.setRows('line_snapshots', batch(T(10), 33.5, -110, T(60)));
  assert.deepEqual(await capture(play()), { unmeasurable: true });
});

// ── Timing guards ───────────────────────────────────────────────
test('nothing is recorded before the close window opens', async () => {
  const future = new Date(Date.now() + 6 * 3600_000).toISOString();
  db.setRows('line_snapshots', [...batch(T(300), 44.5, -110, future), ...batch(T(20), 44.5, -110, future)]);
  assert.equal(await capture(play()), null, 'too early → null, not a fabricated close');
});

test('suspect means the newest batch predates the close window', async () => {
  const kickoff = T(30);                                  // kicked off 30 min ago
  db.setRows('line_snapshots', [...batch(T(600), 44.5, -110, kickoff), ...batch(T(300), 45.5, -110, kickoff)]);
  const r = await capture(play({ scored_at: T(590) }));
  assert.equal(r.suspect, true, 'our newest batch is 5h stale — that is not the close');
  assert.equal(r.clv, 1, 'still measured, just flagged');
});
