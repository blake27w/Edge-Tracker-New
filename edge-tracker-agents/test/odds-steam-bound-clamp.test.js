// ══════════════════════════════════════════════════════════════
// The steam bound is CLAMPED to the write bound: a row we refuse to write
// cannot be steam. Here the override asks for a steam window four times wider
// than the emit bound, and must get the emit bound instead.
//
// Its own file because both bounds are module-level consts read from
// process.env at FIRST import.
// ══════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadOddsPure, moveRow } from './helpers/odds-pure.js';

const MIN = 60_000;
let mod;

before(async () => {
  process.env.ODDS_MOVE_MAX_GAP_MIN = '120';
  process.env.ODDS_STEAM_MAX_GAP_MIN = '480';
  ({ mod } = await loadOddsPure());
});
after(() => {
  delete process.env.ODDS_MOVE_MAX_GAP_MIN;
  delete process.env.ODDS_STEAM_MAX_GAP_MIN;
  mock.reset();
});

test('a steam window wider than the write bound is clamped to it', () => {
  const kept = mod.steamSafeMovements([moveRow(119.9), moveRow(120), moveRow(120.1), moveRow(479)]);
  assert.deepEqual(kept.map((r) => r.gap_min), [119.9, 120],
    'Math.min(MOVE_MAX_GAP_MIN, override) — 480 cannot admit what 120 refuses to write');
});

test('and the clamp is coherent: nothing publishable is unwritable', () => {
  // The invariant behind the clamp, exercised rather than asserted in prose:
  // for every gap, publishable implies writable.
  const cur = { sport: 'A', game_id: 'g1', market: 'totals', book: 'draftkings', side: 'Over', line: 43.5, price: -110 };
  const t = Date.now();
  for (const gapMin of [0, 1, 30, 119, 120, 121, 300]) {
    const v = mod.movementFrom({ line: 44.5, price: -110, at: t - gapMin * MIN, source: 'rehydrated' }, cur, t);
    const writable = !!(v && v.move);
    const publishable = writable && mod.steamSafeMovements([v.move]).length === 1;
    assert.ok(!publishable || writable, `gap ${gapMin} is published but not written`);
    if (gapMin > 120) assert.equal(writable, false, `gap ${gapMin} is past the write bound`);
  }
});
