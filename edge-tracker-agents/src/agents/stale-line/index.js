// ══════════════════════════════════════════════════════════════
// Slow-Book / Stale-Line Detector — free, uses our own multi-book
// odds. While the market moves, some books are slow to follow. This
// flags any book hanging a LINE (points) meaningfully off the field
// consensus in the bettor's favor — a stale number to attack before
// it corrects. Distinct from the +EV scanner, which compares PRICE at
// the consensus line; this compares the line itself. $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setStaleLines } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';
import { fmtOdds } from '../shared/odds-math.js';
import { trackBookEdges } from '../shared/book-edge.js';

const STALE_PTS = Number(process.env.STALE_LINE_PTS) || 1.5; // min points off consensus

function push(rows, g, market, side, o, consensus) {
  rows.push({
    sport: g.sport, game_id: g.game_id, commence_time: g.commence_time,
    matchup: `${g.away} @ ${g.home}`, market, side,
    book: o.book, line: o.line, consensus,
    pts: Math.round(Math.abs(o.line - consensus) * 10) / 10, price: o.price,
  });
}

async function run() {
  const games = getGames();
  if (!games.length) { setStaleLines([]); return { summary: 'no games to scan' }; }

  const rows = [];
  for (const g of games) {
    const m = computeMarkets(g);
    const consT = g.consensusTotal ?? m.total.consensus;
    const consH = m.spread.consensusHome;

    for (const [bk, b] of Object.entries(g.books || {})) {
      const label = b.label || bk; const mk = b.markets || {};

      // Totals: a line above consensus favors Under; below favors Over.
      if (consT != null) {
        const ov = mk['totals:Over'], un = mk['totals:Under'];
        if (un && un.line != null && un.line - consT >= STALE_PTS) push(rows, g, `total`, 'Under', { book: label, line: un.line, price: un.price }, consT);
        if (ov && ov.line != null && consT - ov.line >= STALE_PTS) push(rows, g, `total`, 'Over', { book: label, line: ov.line, price: ov.price }, consT);
      }
      // Spreads: a more generous number than consensus on either side.
      if (consH != null) {
        const sh = mk[`spreads:${g.home}`], sa = mk[`spreads:${g.away}`];
        if (sh && sh.line != null && sh.line - consH >= STALE_PTS) push(rows, g, `spread`, g.home, { book: label, line: sh.line, price: sh.price }, consH);
        if (sa && sa.line != null && sa.line - (-consH) >= STALE_PTS) push(rows, g, `spread`, g.away, { book: label, line: sa.line, price: sa.price }, -consH);
      }
    }
  }

  rows.sort((a, b) => b.pts - a.pts);
  setStaleLines(rows);

  // Track each stale book as an episode (open→correct) for the Book Edges scorecard.
  try {
    await trackBookEdges('stale', rows.slice(0, 80).map((r) => ({
      sport: r.sport, game_id: r.game_id, market: r.market, side: r.side, book: r.book,
      consensus_line: r.consensus, outlier_line: r.line, pts: r.pts, price: r.price,
    })));
  } catch (_) { /* non-fatal */ }

  if (rows.length) {
    const now = new Date().toISOString();
    try {
      await db.insert('line_signals', rows.slice(0, 60).map((r) => ({
        type: 'stale', sport: r.sport, game_id: r.game_id, matchup: r.matchup, market: r.market,
        side: r.side, book: r.book, line: r.line, consensus: r.consensus, pts: r.pts, price: r.price,
        detail: `${r.book} ${r.side} ${r.line} vs field ${r.consensus} (${r.pts}pt, ${fmtOdds(r.price)})`, fetched_at: now,
      })));
    } catch (e) { logger.warn('stale-line', e.message); }
  }

  return { summary: `${rows.length} stale lines${rows.length ? ` (top ${rows[0].pts}pt)` : ''}`, data: { count: rows.length } };
}

export default { name: 'stale-line', run };
