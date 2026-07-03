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
import { computeMarkets } from '../../games/lines.js';

const PUBLIC_PCT = Number(process.env.FADE_PUBLIC_PCT) || 65;  // "heavy public" threshold
const HANDLE_GAP = Number(process.env.FADE_HANDLE_GAP) || 8;   // bets% − handle% gap that signals money on the fade side
const fadePersisted = new Set(); // game|market|fade already written to monitor_scores

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
    // Weaker tells from the splits upgrade: line frozen vs the crowd (books
    // content taking that action), and a late public pile-on.
    if (r.freeze) { reasons.push('line frozen vs heavy public'); score += 8; }
    const hardReasons = reasons.length; // rlm / handle-gap / steam / freeze = market tells
    if (r.pileon) { reasons.push('public piling on late'); score += 5; }

    if (!hardReasons) continue; // require a market tell — pile-on alone is a blind fade
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

  // GRADE THE FADES. These were the only signal with no validation loop —
  // persisted to monitor_scores as OBSERVATIONAL (out of the headline record,
  // reduced stake) so grading settles them and CLV judges them. Each market
  // tell gets its own signal id, so the per-signal CLV scorecard can tell us
  // WHICH fade tells actually beat the close (fade_rlm vs fade_freeze etc.).
  const gradeable = [];
  for (const r of rows) {
    if (!r.fade_side) continue;
    const g = byId[r.game_id];
    if (!g) continue;
    const key = `${r.game_id}|${r.market}|${r.fade_side}`;
    if (fadePersisted.has(key)) continue;
    fadePersisted.add(key);
    const m = computeMarkets(g);
    let line = null, price = null;
    if (r.market === 'total') line = g.consensusTotal ?? m.total.consensus;
    else if (r.market === 'spread') { const ch = m.spread.consensusHome; line = ch == null ? null : (r.fade_side === g.home ? ch : -ch); }
    else if (r.market === 'ml') price = r.fade_side === g.home ? m.ml.consensusHome : m.ml.consensusAway;
    if ((r.market === 'total' || r.market === 'spread') && line == null) continue; // ungradeable without a number
    const sigs = [{ tier: r.rlm ? 1 : 2, id: 'fade', label: r.reasons.join(' · ') }];
    if (r.rlm) sigs.push({ tier: 1, id: 'fade_rlm', label: 'RLM vs public' });
    if (r.divergence != null && r.divergence <= -HANDLE_GAP) sigs.push({ tier: 2, id: 'fade_handle', label: 'handle < bets' });
    if (r.freeze) sigs.push({ tier: 3, id: 'fade_freeze', label: 'line frozen vs public' });
    const stake = Math.round(config.rules.unitDollars * 0.5 * 100) / 100;
    gradeable.push({
      sport: r.sport, game_id: r.game_id, matchup: r.matchup, market: r.market,
      side: r.fade_side, line, price,
      raw_score: r.score, score: r.score, confidence: r.score, tier: 'FADE (obs)',
      unit_mult: 0.5, unit_dollars: stake, t1_count: r.rlm ? 1 : 0,
      signals: sigs, qualified: true, observational: true,
      live: !!(g.commence_time && Date.parse(g.commence_time) <= Date.now()),
      status: 'pending', scored_at: now,
    });
  }
  if (gradeable.length) { try { await db.insert('monitor_scores', gradeable); } catch (e) { logger.warn('public-fade', `persist: ${e.message}`); } }

  return { summary: `${rows.length} fade spots (${gradeable.length} new → grading) · public ≥${PUBLIC_PCT}% + market tell`, data: { count: rows.length, graded: gradeable.length } };
}

export default { name: 'public-fade', run };
