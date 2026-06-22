// ══════════════════════════════════════════════════════════════
// Corroboration check — is there an independent signal backing a side?
// Used to let heavily-juiced opportunities through ONLY when a real edge
// supports them (sharp steam toward the side, reverse line movement vs the
// public, or a handle≫bets split). A better price on heavy chalk is not an
// edge by itself; with a confirming signal it can be.
// ══════════════════════════════════════════════════════════════
import { getIntel } from '../../store/index.js';

const norm = (s) => String(s || '').toLowerCase();
function sideMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return x.split(' ').pop() === y.split(' ').pop(); // surname / nickname
}

// marketKey: 'ml' | 'total' | 'spread'. Returns a reason string, or null.
export function corroboration(gameId, marketKey, side) {
  const sharpMk = marketKey === 'ml' ? 'h2h' : marketKey === 'total' ? 'totals' : 'spreads';
  for (const s of getIntel('sharp') || []) {
    if (s.game_id === gameId && s.market === sharpMk && sideMatch(s.side, side)) return 'sharp steam';
  }
  for (const s of getIntel('splits') || []) {
    if (s.game_id === gameId && s.market === marketKey && sideMatch(s.side, side)) {
      if (s.rlm) return 'RLM vs public';
      if (s.divergence != null && s.divergence >= 8) return 'sharp money (handle>bets)';
    }
  }
  return null;
}

export default { corroboration };
