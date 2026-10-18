// ══════════════════════════════════════════════════════════════
// Football key numbers — shared by key-number (shopping edges) and
// book-move (was a move worth anything?). One copy of the measured
// landing frequencies so the two agents can never drift apart.
// ══════════════════════════════════════════════════════════════

// Keys in priority order; importance drives sort + display. Order calibrated
// from the 2025 season via scripts/nfl-backtest.js: 4 outlands 6/10/14; 17
// (two scores) added as a secondary key.
export const KEYS = [{ k: 3, imp: 'high' }, { k: 7, imp: 'high' }, { k: 4, imp: 'med' }, { k: 6, imp: 'med' }, { k: 14, imp: 'med' }, { k: 17, imp: 'med' }, { k: 10, imp: 'med' }];
// Share (%) of NFL games whose final margin lands EXACTLY on each number.
// MEASURED from the 2025 season (n=271, scripts/nfl-backtest.js): 3→15.1,
// 7→9.6, 4→5.5, 6→4.1, 14→4.1, 10→3.7. 17 measured 5.9% but long-run is
// ~3.3%, so it's set conservatively at 4. Rerun the script each offseason.
// Crossing a key is worth roughly HALF its landing frequency in win prob
// (the push flips to a win/loss on one side), so ev_pct ≈ LAND_PCT/2.
export const LAND_PCT = { 3: 15.1, 7: 9.6, 4: 5.5, 6: 4.1, 14: 4.1, 17: 4, 10: 3.7 };

// The key number a move from `from` to `to` crossed, or null. Checked in
// KEYS order (highest LAND_PCT first), so a move spanning several keys is
// credited with the most valuable one. The key must sit STRICTLY between the
// two values — landing on a key is not crossing it. Works on absolute spread
// points and on totals alike (the caller supplies the right units).
export function crossedKey(from, to) {
  const a = Number(from), b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  for (const { k } of KEYS) if (k > lo && k < hi) return k;
  return null;
}
