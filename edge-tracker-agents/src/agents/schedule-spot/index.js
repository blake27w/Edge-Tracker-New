// ══════════════════════════════════════════════════════════════
// Schedule Spot (Agent 9) — pure schedule math from the odds feed,
// zero API cost. Accumulates observed games into per-team history and
// flags fatigue/travel spots: back-to-backs (NBA/NHL), day-after-night
// (MLB), road-trip length, getaway-day looks. These are T2/T3 signals
// into the Signal Engine — never a standalone qualifier.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

const DAY = 24 * 3600_000;
// team -> [{ ts, homeAway, hour, game_id }] (most recent last), capped.
const history = new Map();

function record(team, ts, homeAway, hour, game_id) {
  const arr = history.get(team) || [];
  // De-dupe same game.
  if (!arr.some((e) => e.game_id === game_id)) arr.push({ ts, homeAway, hour, game_id });
  arr.sort((a, b) => a.ts - b.ts);
  if (arr.length > 30) arr.splice(0, arr.length - 30);
  history.set(team, arr);
}

function roadStreak(team, beforeTs) {
  const arr = (history.get(team) || []).filter((e) => e.ts < beforeTs);
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].homeAway === 'away') n++; else break;
  }
  return n;
}

async function run() {
  const games = getGames();
  if (!games.length) return { summary: 'no games on the slate' };

  const now = new Date().toISOString();
  const spots = [];

  for (const g of games) {
    const ts = Date.parse(g.commence_time || '') || Date.now();
    const hour = new Date(ts).getUTCHours();
    // Evaluate each team using history BEFORE recording today's game.
    for (const [team, homeAway] of [[g.home, 'home'], [g.away, 'away']]) {
      const arr = history.get(team) || [];
      const prev = arr.filter((e) => e.ts < ts).slice(-1)[0];
      if (prev) {
        const gap = ts - prev.ts;
        // Back-to-back (NBA/NHL): consecutive calendar-day games.
        if (gap <= 1.25 * DAY && ['NBA', 'NHL'].includes(g.sport)) {
          spots.push(spot(g, team, 'b2b', `${team} on the second leg of a back-to-back`, 2));
        }
        // Day game after a night game (MLB): prev started late, today early.
        if (g.sport === 'MLB' && gap <= 1.25 * DAY && prev.hour >= 23 && hour <= 20) {
          spots.push(spot(g, team, 'day_after_night', `${team} day game after a night game`, 3));
        }
      }
      // Long road trip (away team deep into a road stretch).
      if (homeAway === 'away') {
        const rs = roadStreak(team, ts);
        if (rs >= 6) spots.push(spot(g, team, 'long_road', `${team} game ${rs + 1} of a long road trip`, 2));
      }
    }
    // Record today's appearances after evaluation.
    record(g.home, ts, 'home', hour, g.game_id);
    record(g.away, ts, 'away', hour, g.game_id);
  }

  if (spots.length) {
    try { await db.insert('schedule_spots', spots); } catch (e) { logger.warn('schedule-spot', e.message); }
  }
  setIntel('schedule', spots);
  return { summary: `${spots.length} schedule spots flagged`, data: { spots: spots.length } };
}

function spot(g, team, type, detail, tier) {
  return {
    sport: g.sport, game_id: g.game_id, team, spot_type: type, detail, tier,
    factors: { home: g.home, away: g.away, commence: g.commence_time },
    fetched_at: new Date().toISOString(),
  };
}

export default { name: 'schedule-spot', run };
