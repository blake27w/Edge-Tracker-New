// ══════════════════════════════════════════════════════════════
// Public-Fade Engine — fade the public, but ONLY where sharp money
// disagrees. Blindly fading lopsided public sides loses; the edge is in
// the spots where heavy public action meets a contradicting sharp signal:
//   • RLM — the line moved AGAINST the public side (strongest tell)
//   • handle < bets — fewer dollars than tickets on the public side
//     (the money is on the other side)
//   • sharp steam on the opposite side (from the sharp agent)
// Reads the public-splits + sharp data we already ingest — $0, no calls.
// Emits a fade play (the side opposite the public) with the reasons.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, getIntel, setFadePlays } from '../../store/index.js';

const PUBLIC_PCT = Number(process.env.FADE_PUBLIC_PCT) || 65;  // "heavy public" threshold
const HANDLE_GAP = Number(process.env.FADE_HANDLE_GAP) || 8;   // bets% − handle% gap that signals money on the fade side

// The side to bet (opposite the public side), when we can name it.
function fadeOf(game, market, side) {
  const s = String(side || '').toLowerCase();
  if (market === 'total') { if (s.includes('over')) return 'Under'; if (s.includes('under')) return 'Over'; return null; }
  const home = game?.home, away = game?.away;
  const sur = (t) => String(t || '').toLowerCase().split(' ').pop();
  const isHome = s.includes('home') || (home && (s.includes(home.toLowerCase()) || s.includes(sur(home))));
  const isAway = s.includes('away') || (away && (s.includes(away.toLowerCase()) || s.includes(sur(away))));
  if (isHome && away) return away;
  if (isAway && home) return home;
  return null;
}

async function run() {
  const splits = getIntel('splits') || [];
  if (!splits.length) { setFadePlays([]); return { summary: 'no public splits to fade' }; }
  const sharp = getIntel('sharp') || [];
  const games = getGames();
  const byId = {}; for (const g of games) byId[g.game_id] = g;

  // Index sharp signals by game+market for opposite-side lookup.
  const sharpBy = new Map();
  for (const s of sharp) { const k = `${s.game_id}|${s.market === 'totals' ? 'total' : s.market}`; (sharpBy.get(k) || sharpBy.set(k, []).get(k)).push(s); }

  const sideKey = (s) => String(s || '').toLowerCase();
  const now = new Date().toISOString();
  const rows = [];
  for (const r of splits) {
    if (r.bets_pct == null || r.bets_pct < PUBLIC_PCT) continue;
    const g = byId[r.game_id];
    const reasons = [];
    let score = 50 + Math.min(20, Math.round((r.bets_pct - PUBLIC_PCT) * 0.8)); // lopsidedness

    if (r.rlm) { reasons.push('RLM — line moved against the public'); score += 22; }
    if (r.divergence != null && r.divergence <= -HANDLE_GAP) { reasons.push(`money on fade side (handle ${r.handle_pct}% < bets ${r.bets_pct}%)`); score += 13; }
    // Sharp steam on a DIFFERENT side than the public side, same game/market.
    const ss = (sharpBy.get(`${r.game_id}|${r.market}`) || []).find((x) => sideKey(x.side) !== sideKey(r.side));
    if (ss) { reasons.push(`sharp steam on ${ss.side}`); score += 15; }

    if (!reasons.length) continue; // require a sharp disagreement — no blind fades
    const fade = fadeOf(g, r.market, r.side);
    rows.push({
      sport: r.sport, game_id: r.game_id,
      matchup: g ? `${g.away} @ ${g.home}` : r.game_id,
      commence_time: g?.commence_time || null, market: r.market,
      public_side: r.side, fade_side: fade, bets_pct: r.bets_pct, handle_pct: r.handle_pct,
      divergence: r.divergence, rlm: !!r.rlm, score: Math.min(100, score), reasons, detected_at: now,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  setFadePlays(rows);

  if (rows.length) {
    try { await db.insert('public_fades', rows.map((r) => ({ ...r, reasons: r.reasons }))); }
    catch (e) { logger.warn('public-fade', e.message); }
  }
  return { summary: `${rows.length} fade spots (public ≥${PUBLIC_PCT}% + sharp disagrees)`, data: { count: rows.length } };
}

export default { name: 'public-fade', run };
