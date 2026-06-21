// ══════════════════════════════════════════════════════════════
// Book-edge episode tracker. The stale-line and divergence scanners
// re-flag the same off-market book every cycle while the edge is open.
// This collapses those repeats into ONE episode per (type·game·market·
// side·book): a row written when the edge first appears, updated with
// corrected_at + window_sec when the book finally falls back in line.
// That window is the execution metric — how long you realistically have
// to act. State is in-process (an open episode lost to a restart simply
// keeps a null window and is excluded from window stats). $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';

const open = new Map(); // `${type}|${game_id}|${market}|${side}|${book}` -> { id, detectedAt }

// Normalize raw market keys to the same vocabulary opp_results uses (ml/total/spread).
export function normMarket(m) {
  const s = String(m || '').toLowerCase();
  if (s === 'h2h' || s === 'ml') return 'ml';
  if (s === 'totals' || s === 'total') return 'total';
  if (s === 'spreads' || s === 'spread') return 'spread';
  return s;
}

// flags: [{ sport, game_id, market, side, book, consensus_line, outlier_line, pts, price }]
export async function trackBookEdges(type, flags) {
  const now = new Date().toISOString();
  const current = new Map();
  for (const f of flags) {
    if (!f || !f.book || !f.game_id) continue;
    current.set(`${type}|${f.game_id}|${normMarket(f.market)}|${f.side}|${f.book}`, f);
  }

  // New edges → open an episode row.
  for (const [k, f] of current) {
    if (open.has(k)) continue;
    let id = null;
    try {
      const res = await db.insert('book_edge_log', {
        type, sport: f.sport, game_id: f.game_id, market: normMarket(f.market), side: f.side, book: f.book,
        consensus_line: f.consensus_line ?? null, outlier_line: f.outlier_line ?? null,
        pts: f.pts ?? null, price: f.price ?? null, detected_at: now,
      });
      id = res?.data?.[0]?.id || null;
    } catch (_) { /* table optional */ }
    open.set(k, { id, detectedAt: now });
  }

  // Edges no longer flagged → the book corrected; close the episode.
  let closed = 0;
  for (const [k, v] of [...open]) {
    if (current.has(k)) continue;
    const windowSec = Math.round((Date.now() - new Date(v.detectedAt).getTime()) / 1000);
    if (v.id) { try { await db.update('book_edge_log', { corrected_at: now, window_sec: windowSec }, { id: v.id }); } catch (_) { /* ignore */ } }
    open.delete(k);
    closed++;
  }
  return { opened: current.size, closed, tracking: open.size };
}

export default { trackBookEdges, normMarket };
