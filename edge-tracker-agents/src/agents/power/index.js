// ══════════════════════════════════════════════════════════════
// Power Ratings — a free, results-driven Elo model (replaces the old
// Claude version). Each run RECOMPUTES ratings from scratch over a
// rolling window of final scores from ESPN (free), so it's deterministic
// and never drifts/double-counts. $0 per run, fully objective.
//   rating: 1500 = average; winners take points from losers, scaled by
//   the upset size and margin of victory; home edge baked in.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setPower } from '../../store/index.js';

const ESPN_PATH = { MLB: 'baseball/mlb', NBA: 'basketball/nba', NHL: 'hockey/nhl', NFL: 'football/nfl' };
const BASE = 1500, K = 20, HFA = 35, DAY = 86400_000;
const LOOKBACK = Number(process.env.ELO_LOOKBACK_DAYS) || 30;

const ymd = (d) => d.toISOString().slice(0, 10);
const compact = (s) => s.replace(/-/g, '');

async function finalsForDate(sport, dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sport]}/scoreboard?dates=${compact(dateStr)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const ev of data.events || []) {
    const c = (ev.competitions || [])[0];
    if (!c || !(c.status?.type?.completed)) continue;
    const h = (c.competitors || []).find((x) => x.homeAway === 'home');
    const a = (c.competitors || []).find((x) => x.homeAway === 'away');
    if (!h || !a) continue;
    const hs = Number(h.score), as = Number(a.score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    out.push({ home: h.team?.displayName, away: a.team?.displayName, hs, as });
  }
  return out;
}

// 538-style margin-of-victory multiplier.
function movMult(diff, ratingGap) {
  return Math.log(Math.abs(diff) + 1) * (2.2 / (Math.abs(ratingGap) * 0.001 + 2.2));
}

async function run() {
  const sports = [...new Set(getGames().map((g) => g.sport))].filter((s) => ESPN_PATH[s]);
  if (!sports.length) return { summary: 'no team-sport games on the slate' };

  const yesterday = new Date(Date.now() - DAY);
  const now = new Date().toISOString();
  let totalGames = 0;
  const parts = [];

  for (const sport of sports) {
    const ratings = {};               // recomputed fresh each run (no drift)
    let processed = 0;
    for (let t = Date.now() - LOOKBACK * DAY; t <= yesterday.getTime(); t += DAY) {
      const dateStr = ymd(new Date(t));
      let finals = [];
      try { finals = await finalsForDate(sport, dateStr); }
      catch (e) { logger.warn('power', `${sport} ${dateStr}: ${e.message}`); continue; }
      for (const g of finals) {
        if (!g.home || !g.away) continue;
        const rh = ratings[g.home] ?? BASE, ra = ratings[g.away] ?? BASE;
        const expH = 1 / (1 + Math.pow(10, (ra - (rh + HFA)) / 400));
        const actH = g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5;
        const delta = K * movMult(g.hs - g.as, (rh + HFA) - ra) * (actH - expH);
        ratings[g.home] = Math.round((rh + delta) * 10) / 10;
        ratings[g.away] = Math.round((ra - delta) * 10) / 10;
        processed++;
      }
    }

    const rows = Object.entries(ratings).map(([team, rating]) => ({
      sport, team, rating, off_rating: null, def_rating: null,
      notes: `Elo · ${LOOKBACK}d form (${processed}g)`, updated_at: now,
    }));
    if (rows.length) { try { await db.upsert('power_ratings', rows, 'sport,team'); } catch (e) { logger.warn('power', e.message); } }

    const map = {};
    for (const [team, rating] of Object.entries(ratings)) map[team] = { rating };
    setPower(sport, map);
    totalGames += processed;
    parts.push(`${sport}:${Object.keys(ratings).length}t/${processed}g`);
  }

  return { summary: `Elo recomputed (${LOOKBACK}d) · ${parts.join(', ')} · free ESPN`, data: { games: totalGames } };
}

export default { name: 'power', run };
