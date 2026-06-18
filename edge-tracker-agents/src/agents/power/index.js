// ══════════════════════════════════════════════════════════════
// Power Ratings — a free, results-driven Elo model (replaces the old
// Claude version). Pulls final scores from ESPN (free) and updates each
// team's rating: winners take points from losers, scaled by the upset
// size and margin of victory. $0 per run, fully objective.
//
// State is tracked in elo_state (through_date per sport) so games are
// never double-counted across runs. First run backfills ~21 days.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setPower } from '../../store/index.js';

const ESPN_PATH = { MLB: 'baseball/mlb', NBA: 'basketball/nba', NHL: 'hockey/nhl', NFL: 'football/nfl' };
const BASE = 1500, K = 20, HFA = 35, DAY = 86400_000;

function ymd(d) { return d.toISOString().slice(0, 10); }
function compact(dateStr) { return dateStr.replace(/-/g, ''); }

// Final scores for a sport on a given YYYY-MM-DD (ESPN, free).
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

// Margin-of-victory multiplier (538-style): blowouts move ratings more,
// dampened when a strong favorite wins big.
function movMult(diff, ratingGap) {
  return Math.log(Math.abs(diff) + 1) * (2.2 / (Math.abs(ratingGap) * 0.001 + 2.2));
}

async function run() {
  const sports = [...new Set(getGames().map((g) => g.sport))].filter((s) => ESPN_PATH[s]);
  if (!sports.length) return { summary: 'no team-sport games on the slate' };

  let totalGames = 0;
  const summaries = [];

  for (const sport of sports) {
    // Load existing ratings + how far we've processed.
    const ratings = {};
    try {
      const rows = await db.select('power_ratings', 'team,rating', { match: { sport } });
      for (const r of rows) if (r.rating != null) ratings[r.team] = Number(r.rating);
    } catch (_) { /* ignore */ }
    let through = null;
    try {
      const st = await db.select('elo_state', 'through_date', { match: { sport } });
      through = st[0]?.through_date || null;
    } catch (_) { /* ignore */ }

    const yesterday = new Date(Date.now() - DAY);
    const start = through ? new Date(Date.parse(through) + DAY) : new Date(Date.now() - 21 * DAY);
    if (start > yesterday) { setPower(sport, wrap(ratings)); continue; } // already current

    let processed = 0;
    for (let t = start.getTime(); t <= yesterday.getTime(); t += DAY) {
      const dateStr = ymd(new Date(t));
      let finals = [];
      try { finals = await finalsForDate(sport, dateStr); } catch (e) { logger.warn('power', `${sport} ${dateStr}: ${e.message}`); continue; }
      for (const g of finals) {
        if (!g.home || !g.away) continue;
        const rh = ratings[g.home] ?? BASE, ra = ratings[g.away] ?? BASE;
        const expH = 1 / (1 + Math.pow(10, ((ra) - (rh + HFA)) / 400));
        const actH = g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5;
        const mult = movMult(g.hs - g.as, (rh + HFA) - ra);
        const delta = K * mult * (actH - expH);
        ratings[g.home] = Math.round((rh + delta) * 10) / 10;
        ratings[g.away] = Math.round((ra - delta) * 10) / 10;
        processed++;
      }
    }

    // Persist ratings + state, publish to the store.
    const now = new Date().toISOString();
    const rows = Object.entries(ratings).map(([team, rating]) => ({
      sport, team, rating, off_rating: null, def_rating: null,
      notes: `Elo (through ${ymd(yesterday)})`, updated_at: now,
    }));
    if (rows.length) { try { await db.upsert('power_ratings', rows, 'sport,team'); } catch (e) { logger.warn('power', e.message); } }
    try { await db.upsert('elo_state', [{ sport, through_date: ymd(yesterday), games: processed, updated_at: now }], 'sport'); } catch (_) { /* ignore */ }
    setPower(sport, wrap(ratings));
    totalGames += processed;
    summaries.push(`${sport}:${processed}`);
  }

  return {
    summary: `Elo updated · ${summaries.join(', ') || 'current'} · free ESPN`,
    data: { gamesProcessed: totalGames },
  };
}

// store.setPower expects team -> { rating } shape.
function wrap(ratings) {
  const m = {};
  for (const [team, rating] of Object.entries(ratings)) m[team] = { rating };
  return m;
}

export default { name: 'power', run };
