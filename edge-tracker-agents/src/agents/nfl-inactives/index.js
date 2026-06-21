// ══════════════════════════════════════════════════════════════
// NFL Inactives-Speed Agent. NFL inactives post ~90 min before kickoff;
// a key skill player (QB/RB/WR/TE) ruled OUT moves the total before the
// books fully adjust — the edge is reacting FAST. This self-gates: it
// only fetches when an NFL game is within the pre-kickoff window, so it
// is fully DORMANT in the offseason ($0, no calls) and auto-activates
// when the season starts. Reads ESPN's free injuries feed (same proven
// endpoint as the injury agent). Emits an Under lean per affected game
// with how early it was caught (minutes to kick). Observational until
// the CLV scorecard validates it — not wired into the signal engine.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { getGames, setNflInactives } from '../../store/index.js';
import { fetchInjuries, lookup } from '../injury/index.js';

const WINDOW_H = Number(process.env.NFL_INACTIVE_WINDOW_H) || 3; // start watching this many hours before kickoff
const SKILL = /\b(QB|RB|WR|TE|FB)\b/i;
const fired = new Set(); // game_id|player — alert/persist once per process

async function run() {
  const now = Date.now();
  // Self-gate: only NFL games that kick within the window and haven't started.
  const games = getGames().filter((g) => g.sport === 'NFL' && g.commence_time && (() => {
    const t = new Date(g.commence_time).getTime();
    return t >= now - 15 * 60_000 && t <= now + WINDOW_H * 3600_000;
  })());
  if (!games.length) { setNflInactives([]); return { summary: 'dormant — no NFL games near kickoff' }; }

  let byTeam;
  try { byTeam = await fetchInjuries('NFL'); }
  catch (e) { return { summary: `ESPN inactives fetch failed: ${e.message}` }; }

  // Dedup persistence against today's already-logged inactives (survives restarts).
  let logged = new Set();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ex = await db.select('nfl_inactives', 'game_id,player', { gte: { detected_at: today + 'T00:00:00Z' } });
    logged = new Set(ex.map((r) => `${r.game_id}|${r.player}`));
  } catch (_) { /* table optional */ }

  const nowIso = new Date().toISOString();
  const rows = [];
  const fresh = [];
  for (const g of games) {
    const minsToKick = Math.round((new Date(g.commence_time).getTime() - now) / 60_000);
    for (const team of [g.home, g.away]) {
      for (const inj of lookup(byTeam, team)) {
        if (inj.status !== 'OUT' || !SKILL.test(inj.pos || '')) continue;
        const key = `${g.game_id}|${inj.player}`;
        const row = {
          game_id: g.game_id, sport: 'NFL', matchup: `${g.away} @ ${g.home}`, team,
          player: inj.player, pos: inj.pos, market: 'total', side: 'Under',
          mins_to_kick: minsToKick, status: 'OUT', detected_at: nowIso,
        };
        rows.push(row);
        if (!fired.has(key) && !logged.has(key)) { fired.add(key); fresh.push(row); }
      }
    }
  }
  rows.sort((a, b) => a.mins_to_kick - b.mins_to_kick);
  setNflInactives(rows);

  if (fresh.length) {
    try { await db.insert('nfl_inactives', fresh); } catch (e) { logger.warn('nfl-inactives', e.message); }
    // Speed alert — a key skill player just ruled OUT, before the line settles.
    for (const r of fresh) {
      const body = `🏈 INACTIVE: ${r.player} (${r.pos}) OUT — ${r.matchup}, ${r.mins_to_kick}m to kick. Lean Under before the total drops.`;
      try {
        const res = await notifyAll('Edge Tracker: NFL inactive', body);
        await db.insert('alert_log', { type: res.email && !res.sms ? 'email' : 'sms', channel: 'inactive', recipients: res.total, body, sport: 'NFL', game_id: r.game_id, status: 'sent' });
      } catch (e) { logger.warn('nfl-inactives', `alert: ${e.message}`); }
    }
  }

  return { summary: `${rows.length} key NFL OUT (${fresh.length} new) across ${games.length} games near kickoff`, data: { count: rows.length, fresh: fresh.length } };
}

export default { name: 'nfl-inactives', run };
