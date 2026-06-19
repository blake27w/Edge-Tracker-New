// ══════════════════════════════════════════════════════════════
// Fair-Line Model — EXPERIMENTAL / OBSERVATIONAL.
//
// Converts the Elo power ratings into a model fair spread and compares
// it to the market, logging the disagreement so we can validate the
// model's calibration over time. By design this is fully isolated:
//   • it does NOT feed the signal engine or qualifying plays
//   • it does NOT send any alert
//   • it only logs + shows in a clearly-labeled experimental panel
// Football + basketball only (Elo→points mapping is standard there;
// spreads only — these ratings don't model totals). $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, getPower, setFairLine } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';

// Elo points per 1 spread point, and home-field advantage (points), per sport.
const MODEL = {
  NFL: { elo: 25, hfa: 2.0 }, NCAAF: { elo: 25, hfa: 2.6 },
  NBA: { elo: 28, hfa: 2.5 }, NCAAB: { elo: 28, hfa: 3.2 }, WNBA: { elo: 28, hfa: 2.0 },
};
const EDGE_MIN = Number(process.env.FAIRLINE_EDGE_PTS) || 1.5; // flag disagreements ≥ this

function ratingFor(map, team) {
  if (!team) return null;
  if (map[team]) return map[team].rating;
  const lc = team.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    const kl = k.toLowerCase();
    if (kl.includes(lc) || lc.includes(kl)) return v.rating;
  }
  return null;
}

async function run() {
  const games = getGames().filter((g) => MODEL[g.sport]);
  if (!games.length) { setFairLine([]); return { summary: 'no modeled sports on the slate' }; }

  const rows = [];
  for (const g of games) {
    const cfg = MODEL[g.sport];
    const power = getPower(g.sport);
    const rH = ratingFor(power, g.home), rA = ratingFor(power, g.away);
    if (rH == null || rA == null) continue;

    const market = computeMarkets(g).spread.consensusHome;
    if (market == null) continue;

    const modelMargin = (rH - rA) / cfg.elo + cfg.hfa;          // home expected margin
    const modelSpreadHome = Math.round(-modelMargin * 2) / 2;    // fair home spread, to 0.5
    const edge = Math.round((modelMargin - (-market)) * 10) / 10; // model vs market (home view)
    if (Math.abs(edge) < EDGE_MIN) continue;

    rows.push({
      sport: g.sport, game_id: g.game_id, commence_time: g.commence_time,
      matchup: `${g.away} @ ${g.home}`,
      model_spread: modelSpreadHome, market_spread: market,
      edge_pts: Math.abs(edge), side: edge > 0 ? g.home : g.away,
    });
  }

  rows.sort((a, b) => b.edge_pts - a.edge_pts);
  setFairLine(rows);

  // Log latest snapshot per game for later calibration study (no alerts, no decisions).
  if (rows.length) {
    const now = new Date().toISOString();
    try {
      await db.upsert('fair_line_log', rows.map((r) => ({
        game_id: r.game_id, sport: r.sport, matchup: r.matchup,
        model_spread: r.model_spread, market_spread: r.market_spread,
        edge_pts: r.edge_pts, side: r.side, commence_time: r.commence_time, fetched_at: now,
      })), 'game_id');
    } catch (e) { logger.warn('fair-line', e.message); }
  }

  return { summary: `${rows.length} model edges ≥${EDGE_MIN}pt (observational)`, data: { count: rows.length } };
}

export default { name: 'fair-line', run };
