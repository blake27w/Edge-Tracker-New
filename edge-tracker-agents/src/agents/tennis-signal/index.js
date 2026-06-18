// ══════════════════════════════════════════════════════════════
// Tennis Signal Engine (golf/tennis variant) — CLV-first, NO Under bias.
// Scores matches on information-asymmetry signals. Today's available T1
// is steam (coordinated match-winner movement across books); fatigue
// (T3-agent) and surface/style (T2) plug in here once their data feeds
// are wired. Unit sizing is HALVED vs the team model (max 0.75u).
//
// Qualifying plays are written to monitor_scores (sport=TENNIS) so they
// flow into the dashboard queue, alerts, export, and CLV/grading.
// ══════════════════════════════════════════════════════════════
import config, { unitFor } from '../../config/index.js';
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { getTennisGames, getIntel, setTennisPlays } from '../../store/index.js';

const { rules } = config;
const alerted = new Set();

// Halve team-sport sizing; cap at 0.75u (variance rule for this module).
function halfUnit(score) {
  const u = unitFor(score);
  const mult = Math.min(0.75, Math.round((u.mult / 2) * 100) / 100);
  return { mult, label: `${mult}u`, dollars: Math.round(mult * rules.unitDollars * 100) / 100 };
}

async function run() {
  const games = getTennisGames();
  if (!games.length) { setTennisPlays([]); return { summary: 'no tennis matches to score' }; }

  // Steam by game+player: count books where the player's price shortened.
  const steam = new Map(); // game_id|player -> books moved toward
  for (const m of getIntel('tennisMoves')) {
    if (m.to < m.from) { // price shortened = money coming in on this player
      const k = `${m.game_id}|${m.player}`;
      steam.set(k, (steam.get(k) || 0) + 1);
    }
  }

  const now = new Date().toISOString();
  const plays = [], newAlerts = [];
  for (const g of games) {
    for (const player of [g.p1, g.p2]) {
      const books = steam.get(`${g.game_id}|${player}`) || 0;
      if (books < 2) continue; // need ≥2 books moving together = real steam
      const sigs = [{ tier: 1, id: 'steam', label: `Steam: ${books} books shortened ${player}` }];
      const raw = Math.min(100, 50 + 20 + (books - 2) * 5);
      if (raw < rules.confidenceFloor) continue;
      const unit = halfUnit(raw);
      const row = {
        sport: 'TENNIS', game_id: g.game_id, matchup: `${g.p1} vs ${g.p2}`, commence_time: g.commence_time,
        market: 'ml', side: player, line: null, raw_score: raw, score: raw, confidence: raw,
        tier: unit.label, unit_mult: unit.mult, unit_dollars: unit.dollars, t1_count: 1,
        signals: sigs, qualified: true, over_penalty_applied: false, status: 'pending', scored_at: now,
      };
      plays.push(row);
      const key = `${g.game_id}|${player}`;
      if (!alerted.has(key)) { alerted.add(key); newAlerts.push(row); }
    }
  }

  if (newAlerts.length) {
    const dbRows = newAlerts.map(({ commence_time, ...r }) => r);
    try { await db.insert('monitor_scores', dbRows); } catch (e) { logger.warn('tennis-signal', e.message); }
  }
  setTennisPlays(plays);

  for (const p of newAlerts) {
    const body = `🎾 ${p.matchup} — ${p.side} ML (${p.score} conf, ${p.tier}/$${p.unit_dollars}, steam)`;
    try {
      const r = await notifyAll('Edge Tracker tennis play', body);
      await db.insert('alert_log', { type: r.email && !r.sms ? 'email' : 'sms', channel: 'tennis', recipients: r.total, body, sport: 'TENNIS', game_id: p.game_id, status: 'sent' });
    } catch (e) { logger.warn('tennis-signal', `alert: ${e.message}`); }
  }

  return { summary: `${plays.length} tennis plays (${newAlerts.length} new) from ${games.length} matches`, data: { plays: plays.length } };
}

export default { name: 'tennis-signal', run };
