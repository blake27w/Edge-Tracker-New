// ══════════════════════════════════════════════════════════════
// C4 — Combat Derivatives. Beyond the moneyline, fights price ROUND
// TOTALS (over/under X.5 rounds) — a soft, lower-limit market where
// books are slower. This scans the round-total lines already in our odds
// feed for combat sports, devigs the consensus to a fair price, and
// flags any book paying meaningfully over fair. Strict prop sizing
// (0.25u). OBSERVATIONAL + validation-gated like the rest of combat;
// graded manually (round count isn't in our free results feed yet).
//   Method-of-victory / goes-the-distance markets aren't in the base
//   feed — left for a future opt-in fetch (no extra credit spend now).
// $0 — reuses odds we already pull.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setCombatDerivs } from '../../store/index.js';
import { impliedProb, toAmerican } from '../shared/odds-math.js';

const COMBAT = new Set(['UFC', 'BOXING']);
const U = config.rules.unitDollars;
const MIN_BOOKS = Number(process.env.COMBAT_DERIV_MIN_BOOKS) || 3; // fewer books price fights
const SHOW_EV = Number(process.env.COMBAT_DERIV_EV) || 0.03;

// Per-book Over/Under prices at the consensus round-total line.
function roundPrices(game, line) {
  const out = { Over: [], Under: [] };
  for (const b of Object.values(game.books || {})) {
    const mk = b.markets || {};
    const ov = mk['totals:Over'], un = mk['totals:Under'];
    if (ov && ov.price != null && ov.line === line) out.Over.push({ book: b.label, price: ov.price });
    if (un && un.price != null && un.line === line) out.Under.push({ book: b.label, price: un.price });
  }
  return out;
}

async function run() {
  const games = getGames().filter((g) => COMBAT.has(g.sport) && g.consensusTotal != null);
  if (!games.length) { setCombatDerivs([]); return { summary: 'no combat round totals in feed' }; }

  const now = new Date().toISOString();
  const plays = [];
  for (const g of games) {
    const line = g.consensusTotal;
    const o = roundPrices(g, line);
    if (o.Over.length < MIN_BOOKS || o.Under.length < MIN_BOOKS) continue;
    const ap = o.Over.reduce((s, x) => s + impliedProb(x.price), 0) / o.Over.length;
    const bp = o.Under.reduce((s, x) => s + impliedProb(x.price), 0) / o.Under.length;
    const t = ap + bp; if (!t) continue;
    const fair = { Over: ap / t, Under: bp / t };
    for (const side of ['Over', 'Under']) {
      let best = null;
      for (const x of o[side]) { const ev = fair[side] * (x.price > 0 ? 1 + x.price / 100 : 1 + 100 / Math.abs(x.price)) - 1; if (ev >= SHOW_EV && (!best || ev > best.ev)) best = { ...x, ev }; }
      if (!best) continue;
      plays.push({
        sport: g.sport, game_id: g.game_id, matchup: `${g.away} vs ${g.home}`,
        commence_time: g.commence_time, market: 'rounds', line, side: `${side} ${line}`,
        book: best.book, price: best.price, fair_price: toAmerican(fair[side]),
        ev_pct: Math.round(best.ev * 1000) / 10, unit_mult: 0.25, unit_dollars: Math.round(U * 0.25 * 100) / 100,
        qualified: true, observational: true, detected_at: now,
      });
    }
  }
  plays.sort((a, b) => b.ev_pct - a.ev_pct);
  setCombatDerivs(plays);

  if (plays.length) {
    try { await db.insert('combat_derivatives', plays.map(({ qualified, observational, ...r }) => r)); }
    catch (e) { logger.warn('combat-derivatives', e.message); }
  }
  return { summary: `${plays.length} combat round-total derivatives (observational)`, data: { count: plays.length } };
}

export default { name: 'combat-derivatives', run };
