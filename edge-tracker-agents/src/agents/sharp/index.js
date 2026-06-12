// ══════════════════════════════════════════════════════════════
// Sharp Money Detection — pure computation over recent line movement.
// Detects STEAM (multiple books moving the same direction together)
// and book RESISTANCE. Reverse-line-movement vs public money (the
// strongest signal) is emitted by the Public Splits agent, which has
// the bets%/handle% it needs; here we surface the price action.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getIntel, setIntel } from '../../store/index.js';

const STEAM_MIN_BOOKS = 3;

async function run() {
  const moves = getIntel('movements'); // from the most recent odds run
  if (!moves.length) return { summary: 'no recent line movement' };

  // Group by game_id|market|side, collect per-book directions.
  const groups = new Map();
  for (const m of moves) {
    const key = `${m.game_id}|${m.market}|${m.side}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(m);
  }

  const signals = [];
  const now = new Date().toISOString();
  for (const [key, list] of groups) {
    const [game_id, market, side] = key.split('|');
    const down = list.filter((m) => m.direction === 'down');
    const up = list.filter((m) => m.direction === 'up');
    const dominant = down.length >= up.length ? down : up;
    const dir = down.length >= up.length ? 'down' : 'up';
    if (dominant.length < STEAM_MIN_BOOKS) continue;

    const books = [...new Set(dominant.map((m) => m.book))];
    const avgMove = dominant.reduce((s, m) => s + Math.abs(m.moved || 0), 0) / dominant.length;
    // For totals, a coordinated DOWN move is sharp Under money (our bias side).
    let sharpSide = side;
    if (market === 'totals') sharpSide = dir === 'down' ? 'Under' : 'Over';
    const strength = Math.min(100, books.length * 20 + Math.round(avgMove * 10));

    signals.push({
      sport: list[0].sport, game_id, market, side: sharpSide,
      signal_type: 'steam', strength, books,
      detail: `${books.length} books moved ${market} ${side} ${dir} (avg ${avgMove.toFixed(1)})`,
      detected_at: now,
    });
  }

  if (signals.length) {
    try { await db.insert('sharp_signals', signals.map((s) => ({ ...s, books: s.books }))); }
    catch (e) { logger.warn('sharp', e.message); }
  }
  setIntel('sharp', signals);
  return { summary: `${signals.length} steam signals across ${groups.size} markets`, data: { signals: signals.length } };
}

export default { name: 'sharp', run };
