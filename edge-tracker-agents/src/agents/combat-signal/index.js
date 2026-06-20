// ══════════════════════════════════════════════════════════════
// C3 — Combat Signal Engine. Acts on signals we ALREADY detect on
// fight odds (steam/RLM via sharp, +EV) plus C2 weigh-in news. Does
// NOT project fights. Emits OBSERVATIONAL combat plays (UFC + Boxing,
// observational=true) to monitor_scores — they do NOT count toward the
// public track record until the validation gate (≥50 graded) clears.
// Strict sizing: combat halved, max 0.5u. $0.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, getIntel, getEvPlays, setCombatPlays } from '../../store/index.js';

const U = config.rules.unitDollars;          // 1u in dollars
const persisted = new Set();                 // game_id|side already written to monitor_scores

// Combat sizing: halved vs team; ml max 0.5u, weaker signals 0.25u.
function size(score) {
  const mult = score >= 80 ? 0.5 : 0.25;
  return { label: mult + 'u', mult, dollars: Math.round(U * mult * 100) / 100 };
}

const COMBAT = new Set(['UFC', 'BOXING']);

async function run() {
  const games = getGames().filter((g) => COMBAT.has(g.sport));
  if (!games.length) { setCombatPlays([]); return { summary: 'no combat card' }; }
  const byId = {}; for (const g of games) byId[g.game_id] = g;

  const plays = {}; // key game_id|side -> play (merge signals)
  const addSig = (game_id, side, score, sig) => {
    const g = byId[game_id]; if (!g || !side) return;
    const k = `${game_id}|${side}`;
    if (!plays[k]) plays[k] = { sport: g.sport, game_id, matchup: `${g.away} vs ${g.home}`, commence_time: g.commence_time, market: 'ml', side, score: 0, t1_count: 0, signals: [] };
    plays[k].score = Math.max(plays[k].score, score);
    plays[k].signals.push(sig);
    if (sig.tier === 1) plays[k].t1_count++;
  };

  // 1. Weigh-in edge (T1) — play the OPPONENT of a compromised fighter, only if value remains.
  try {
    const since = new Date(Date.now() - 36 * 3600_000).toISOString();
    const news = await db.select('combat_news', '*', { gte: { detected_at: since } });
    for (const n of news) {
      if (n.type === 'missed_weight' && n.value_remains) addSig(n.game_id, n.opponent, 80, { tier: 1, id: 'weighin', label: `${n.fighter} ${n.detail} — value on ${n.opponent}` });
    }
  } catch (_) { /* table optional */ }

  // 2. Steam / RLM (T1) — from the sharp agent, on fight moneylines.
  for (const s of (getIntel('sharp') || [])) {
    if (COMBAT.has(s.sport) && s.market === 'h2h') addSig(s.game_id, s.side, Math.min(82, 60 + Math.round((s.strength || 0) / 4)), { tier: 1, id: 'steam', label: s.detail || 'sharp steam' });
  }

  // 3. +EV (T2) — soft price vs the field.
  for (const e of (getEvPlays() || [])) {
    if (COMBAT.has(e.sport) && e.market === 'ml') addSig(e.game_id, e.side, 72, { tier: 2, id: 'ev', label: `+${e.ev_pct}% vs fair @ ${e.book}` });
  }

  const list = Object.values(plays).map((p) => { const u = size(p.score); return { ...p, tier: u.label, unit_mult: u.mult, unit_dollars: u.dollars, qualified: true, observational: true }; })
    .sort((a, b) => b.score - a.score);
  setCombatPlays(list);

  // Persist NEW observational plays so they grade and accumulate toward the gate.
  const fresh = list.filter((p) => !persisted.has(`${p.game_id}|${p.side}`));
  if (fresh.length) {
    fresh.forEach((p) => persisted.add(`${p.game_id}|${p.side}`));
    const now = new Date().toISOString();
    try {
      await db.insert('monitor_scores', fresh.map((p) => ({
        sport: p.sport, game_id: p.game_id, matchup: p.matchup, market: 'ml', side: p.side, line: null,
        raw_score: p.score, score: p.score, confidence: p.score, tier: p.tier, unit_mult: p.unit_mult,
        unit_dollars: p.unit_dollars, t1_count: p.t1_count, signals: p.signals, qualified: true,
        observational: true, status: 'pending', scored_at: now,
      })));
    } catch (e) { logger.warn('combat-signal', e.message); }
  }

  return { summary: `${list.length} combat observational plays (${fresh.length} new) · validation-gated`, data: { plays: list.length } };
}

export default { name: 'combat-signal', run };
