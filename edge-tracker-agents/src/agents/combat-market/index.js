// ══════════════════════════════════════════════════════════════
// C1 — Combat Market Ingestion. Snapshots each fighter's moneyline
// across books (consensus, softest price, open vs current) for combat
// sports (UFC/Boxing). Feeds CLV and the timestamp-pairing rule (C2
// reads line_open to decide whether weigh-in value still remains).
// Derivative markets (method/round/distance) are a later add. $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames } from '../../store/index.js';
import { impliedProb, toAmerican, median } from '../shared/odds-math.js';

const COMBAT = new Set(['UFC', 'BOXING']);
const opened = new Map(); // game_id|fighter -> opening american line (in-memory; mirrored to DB)

function fighterLines(game, fighter) {
  const out = [];
  for (const b of Object.values(game.books || {})) {
    const o = (b.markets || {})[`h2h:${fighter}`];
    if (o && o.price != null) out.push({ book: b.label, price: o.price });
  }
  return out;
}

async function run() {
  const games = getGames().filter((g) => COMBAT.has(g.sport));
  if (!games.length) return { summary: 'no combat cards' };

  const now = new Date().toISOString();
  const rows = [];
  for (const g of games) {
    for (const fighter of [g.home, g.away]) {
      const ls = fighterLines(g, fighter);
      if (!ls.length) continue;
      const consensus = toAmerican(median(ls.map((l) => impliedProb(l.price))));
      const best = ls.reduce((a, b) => (impliedProb(b.price) < impliedProb(a.price) ? b : a)); // longest price = best for backing
      const key = `${g.game_id}|${fighter}`;
      if (!opened.has(key)) opened.set(key, consensus);
      rows.push({
        game_id: g.game_id, fighter, matchup: `${g.away} vs ${g.home}`, sport: g.sport,
        line_open: opened.get(key), line_current: consensus, best_ml: best.price, best_book: best.book,
        opened_at: opened.has(key) ? undefined : now, fetched_at: now,
      });
    }
  }
  if (rows.length) {
    try { await db.upsert('combat_markets', rows.map(({ opened_at, ...r }) => r), 'game_id,fighter'); }
    catch (e) { logger.warn('combat-market', e.message); }
  }
  return { summary: `${rows.length} combat fighter lines (${games.length} fights)`, data: { fights: games.length } };
}

// Current consensus + opening line for a fighter (used by C2/C3).
export function combatLine(game, fighter) {
  const ls = fighterLines(game, fighter);
  if (!ls.length) return null;
  const consensus = toAmerican(median(ls.map((l) => impliedProb(l.price))));
  return { consensus, open: opened.get(`${game.game_id}|${fighter}`) ?? consensus };
}

export default { name: 'combat-market', run };
