// ══════════════════════════════════════════════════════════════
// Sharp / Book-Divergence Detector — free, uses our own multi-book
// odds. Our 7 books are all retail (no Pinnacle/Circa reference), so
// "sharp side" is inferred from line MOVEMENT (the steam signals the
// sharp agent already produces), not from a sharp book. This flags
// markets where one book's PRICE diverges from the field, and marks
// the strongest case — a soft price sitting on the side steam money
// is moving toward (a slow book on the sharp side). $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, getIntel, setDivergence } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';
import { impliedProb, toAmerican, median, fmtOdds } from '../shared/odds-math.js';
import { trackBookEdges } from '../shared/book-edge.js';

const MIN_BOOKS = 4;
const DIVERGE = Number(process.env.DIVERGE_PCT) || 0.03; // 3% implied-prob gap vs field

// Best price (lowest implied prob) and field median from {book,price} list.
function analyze(outs) {
  if (outs.length < MIN_BOOKS) return null;
  const probs = outs.map((o) => impliedProb(o.price));
  const field = median(probs);
  let best = outs[0], bestP = probs[0];
  for (let i = 1; i < outs.length; i++) if (probs[i] < bestP) { best = outs[i]; bestP = probs[i]; }
  return { field, bestProb: bestP, book: best.book, price: best.price, gap: field - bestP };
}

function gather(game, key, lineEq) {
  const out = [];
  for (const [bk, b] of Object.entries(game.books || {})) {
    const o = (b.markets || {})[key];
    if (o && o.price != null && (lineEq == null || o.line === lineEq)) out.push({ book: b.label || bk, price: o.price });
  }
  return out;
}

async function run() {
  const games = getGames();
  if (!games.length) { setDivergence([]); return { summary: 'no games to scan' }; }

  const steam = getIntel('sharp') || []; // {game_id, market, side}
  const rows = [];

  for (const g of games) {
    const m = computeMarkets(g);
    const steamFor = (mkt) => { const s = steam.find((x) => x.game_id === g.game_id && x.market === mkt); return s ? s.side : null; };

    const markets = [
      { mkt: 'h2h', sides: [[g.home, `h2h:${g.home}`], [g.away, `h2h:${g.away}`]], line: null },
    ];
    if (g.consensusTotal != null) markets.push({ mkt: 'totals', sides: [['Over', 'totals:Over'], ['Under', 'totals:Under']], line: g.consensusTotal });
    if (m.spread.consensusHome != null) markets.push({ mkt: 'spreads', sides: [[g.home, `spreads:${g.home}`], [g.away, `spreads:${g.away}`]], line: m.spread.consensusHome, awayLine: -m.spread.consensusHome });

    for (const M of markets) {
      const sharpSide = steamFor(M.mkt);
      for (const [side, key] of M.sides) {
        const lineEq = M.mkt === 'spreads' ? (side === g.home ? M.line : M.awayLine) : M.line;
        const a = analyze(gather(g, key, lineEq));
        if (!a || a.gap < DIVERGE) continue;
        rows.push({
          sport: g.sport, game_id: g.game_id, commence_time: g.commence_time,
          matchup: `${g.away} @ ${g.home}`, market: M.mkt, side,
          book: a.book, price: a.price, fieldFair: toAmerican(a.field),
          edgePct: Math.round(a.gap * 1000) / 10,
          aligned: sharpSide != null && side === sharpSide, sharpSide,
        });
      }
    }
  }

  // Steam-aligned soft prices first, then by size of the divergence.
  rows.sort((a, b) => (b.aligned - a.aligned) || (b.edgePct - a.edgePct));
  setDivergence(rows);

  // Track each soft-price book as an episode for the Book Edges scorecard
  // (market normalized to ml/total/spread to match the graded results).
  try {
    await trackBookEdges('divergence', rows.slice(0, 80).map((r) => ({
      sport: r.sport, game_id: r.game_id, market: r.market, side: r.side, book: r.book,
      consensus_line: null, outlier_line: null, pts: r.edgePct, price: r.price,
    })));
  } catch (_) { /* non-fatal */ }

  if (rows.length) {
    const now = new Date().toISOString();
    try {
      await db.insert('line_signals', rows.slice(0, 60).map((r) => ({
        type: 'divergence', sport: r.sport, game_id: r.game_id, matchup: r.matchup, market: r.market,
        side: r.side, book: r.book, price: r.price, consensus: r.fieldFair, pts: r.edgePct, aligned: r.aligned,
        detail: `${r.book} ${r.side} ${fmtOdds(r.price)} vs field ${fmtOdds(r.fieldFair)} (+${r.edgePct}%${r.aligned ? ', sharp side' : ''})`, fetched_at: now,
      })));
    } catch (e) { logger.warn('sharp-divergence', e.message); }
  }

  const aligned = rows.filter((r) => r.aligned).length;
  return { summary: `${rows.length} divergences${aligned ? `, ${aligned} on the sharp side` : ''}`, data: { count: rows.length, aligned } };
}

export default { name: 'sharp-divergence', run };
