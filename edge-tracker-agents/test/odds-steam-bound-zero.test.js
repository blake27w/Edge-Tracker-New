// ══════════════════════════════════════════════════════════════
// ODDS_STEAM_MAX_GAP_MIN = 0 — the "publish nothing but a genuinely
// simultaneous pair" setting, and the one that proves the bound is read with
// `hdrNum` and not `||`: `Number('0') || 35` is 35, which would silently leave
// the default in force on the one override whose whole point is to be zero.
//
// Its own file because the bound is a module-level const read from process.env
// at FIRST import, so one env setting needs one module instance.
// ══════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadOddsPure, moveRow } from './helpers/odds-pure.js';

let mod;

before(async () => {
  process.env.ODDS_STEAM_MAX_GAP_MIN = '0';
  ({ mod } = await loadOddsPure());
});
after(() => { delete process.env.ODDS_STEAM_MAX_GAP_MIN; mock.reset(); });

test('zero means zero — only a same-instant pair is published', () => {
  const kept = mod.steamSafeMovements([moveRow(0), moveRow(0.1), moveRow(4), moveRow(30)]);
  assert.deepEqual(kept.map((r) => r.gap_min), [0],
    'if `||` were used to read the override, 35 would still be in force and all four would pass');
});

test('the write bound is untouched by the steam override', () => {
  // Narrowing what is PUBLISHED must not narrow what is WRITTEN: line_movements
  // is the complete record, and the two bounds answer different questions.
  const cur = { sport: 'A', game_id: 'g1', market: 'totals', book: 'draftkings', side: 'Over', line: 43.5, price: -110 };
  const v = mod.movementFrom({ line: 44.5, price: -110, at: Date.now() - 120 * 60_000, source: 'rehydrated' }, cur, Date.now());
  assert.ok(v && v.move, 'a 2-hour gap is still inside the default 360-minute write bound');
  assert.equal(mod.steamSafeMovements([v.move]).length, 0, 'and still unpublishable at this setting');
});
