// ══════════════════════════════════════════════════════════════
// Tennis — Fatigue & Schedule (T3), the highest-value tennis edge.
// Uses the Odds API scores endpoint (free, recent completed matches)
// to compute each player's rest days, then flags significant fatigue
// differentials in upcoming matches → a Tier-1 signal favoring the
// rested player. (Cross-tournament/travel fatigue needs Sackmann and is
// deferred; in-tournament rest is captured here.)
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getTennisGames, setIntel } from '../../store/index.js';

const { oddsApi } = config;
const DAY = 86400_000;
const MAX_TOURNEYS = Number(process.env.TENNIS_MAX_TOURNEYS) || 8;
// Significant differential: someone played recently AND has ≥1.5 days less rest.
const DIFF_DAYS = Number(process.env.TENNIS_FATIGUE_DIFF) || 1.5;

async function activeKeys() {
  try {
    const res = await fetch(`${oddsApi.base}/sports?apiKey=${oddsApi.key}`);
    if (!res.ok) return [];
    return (await res.json()).filter((s) => s.active && /^tennis_/.test(s.key)).map((s) => s.key);
  } catch (_) { return []; }
}

async function fetchScores(key) {
  const params = new URLSearchParams({ apiKey: oddsApi.key, daysFrom: '3', dateFormat: 'iso' });
  const res = await fetch(`${oddsApi.base}/sports/${key}/scores?${params}`);
  if (!res.ok) throw new Error(`scores ${res.status} ${key}`);
  return res.json();
}

async function run() {
  if (!oddsApi.key) return { summary: 'skipped — no ODDS_API_KEY' };
  const games = getTennisGames();
  if (!games.length) { setIntel('tennisFatigue', []); return { summary: 'no tennis matches' }; }

  // Most recent completed match datetime per player.
  const lastMatch = {};
  for (const key of (await activeKeys()).slice(0, MAX_TOURNEYS)) {
    let evs = [];
    try { evs = await fetchScores(key); } catch (e) { logger.warn('tennis-fatigue', e.message); continue; }
    for (const ev of evs) {
      if (!ev.completed) continue;
      const when = Date.parse(ev.last_update || ev.commence_time || '');
      if (!Number.isFinite(when)) continue;
      for (const p of [ev.home_team, ev.away_team]) {
        if (p && (!lastMatch[p] || when > lastMatch[p])) lastMatch[p] = when;
      }
    }
  }

  const now = Date.now(), nowIso = new Date().toISOString();
  const rows = [], signals = [];
  for (const g of games) {
    const r1 = lastMatch[g.p1] != null ? (now - lastMatch[g.p1]) / DAY : null;
    const r2 = lastMatch[g.p2] != null ? (now - lastMatch[g.p2]) / DAY : null;
    if (r1 == null || r2 == null) continue;
    const diff = Math.abs(r1 - r2);
    const tiredRest = Math.min(r1, r2);
    if (diff < DIFF_DAYS || tiredRest > 2) continue;
    const favored = r1 > r2 ? g.p1 : g.p2;
    const tired = r1 > r2 ? g.p2 : g.p1;
    const detail = `${tired} on ${tiredRest.toFixed(1)}d rest vs ${favored} ${Math.max(r1, r2).toFixed(1)}d`;
    rows.push({ game_id: g.game_id, player: favored, opponent: tired, rest_days: Math.round(Math.max(r1, r2) * 10) / 10, opp_rest_days: Math.round(tiredRest * 10) / 10, favored, detail, fetched_at: nowIso });
    signals.push({ game_id: g.game_id, favored, detail });
  }

  if (rows.length) { try { await db.insert('tennis_fatigue', rows); } catch (e) { logger.warn('tennis-fatigue', e.message); } }
  setIntel('tennisFatigue', signals);
  return { summary: `${signals.length} fatigue edges across ${games.length} matches`, data: { edges: signals.length } };
}

export default { name: 'tennis-fatigue', run };
