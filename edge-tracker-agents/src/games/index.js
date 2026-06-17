// ══════════════════════════════════════════════════════════════
// Games board — assembles the daily slate for a sport: each game with
// its opening line (captured from first sight), current consensus line
// + movement, best-book price (line shopping), and any agent signals
// (qualifying play, sharp/RLM, injuries, weather). Powers GET /games.
// ══════════════════════════════════════════════════════════════
import db from '../db/index.js';
import { getGames, signalsForGame, getPlays } from '../store/index.js';
import { computeMarkets } from './lines.js';
import { getOpenings } from '../agents/odds/index.js';

export async function buildGames(sport) {
  const want = String(sport || '').toUpperCase();
  const games = getGames().filter((g) => !want || g.sport === want);
  if (!games.length) return { sport: want, games: [], note: 'No games in the next 36h.' };

  // Opening lines: prefer persisted (survives restarts), fall back to in-memory.
  const openMem = getOpenings();
  const dbOpen = {};
  try {
    const ids = games.map((g) => g.game_id);
    const rows = await db.select('opening_lines', '*', { in: { game_id: ids } });
    for (const r of rows) dbOpen[`${r.game_id}|${r.market}`] = r;
  } catch (_) { /* table optional */ }
  const openOf = (gid, market) => {
    const r = dbOpen[`${gid}|${market}`] || openMem.get(`${gid}|${market}`);
    return r ? r.line : null;
  };

  const plays = getPlays();

  const out = games.map((g) => {
    const m = computeMarkets(g);
    const sig = signalsForGame(g.game_id);
    const play = plays.find((p) => p.game_id === g.game_id && p.qualified) || null;
    const openTotal = openOf(g.game_id, 'total');
    const curTotal = m.total.consensus;
    return {
      game_id: g.game_id, sport: g.sport, away: g.away, home: g.home,
      commence_time: g.commence_time,
      total: {
        open: openTotal, current: curTotal,
        move: openTotal != null && curTotal != null ? Math.round((curTotal - openTotal) * 10) / 10 : null,
        bestUnder: m.total.bestUnder, bestOver: m.total.bestOver,
      },
      spread: { open: openOf(g.game_id, 'spread'), currentHome: m.spread.consensusHome },
      ml: { currentHome: m.ml.consensusHome, currentAway: m.ml.consensusAway },
      injuries: sig.injuries.filter((i) => i.impact !== 'low').slice(0, 6),
      weather: sig.weather[0] || null,
      sharp: sig.sharp.length > 0,
      rlm: sig.splits.some((s) => s.rlm),
      play: play ? {
        side: play.side, market: play.market, line: play.line, score: Math.round(play.score),
        tier: play.tier, unit_dollars: play.unit_dollars, t1: play.t1_count,
      } : null,
    };
  });

  out.sort((a, b) => new Date(a.commence_time || 0) - new Date(b.commence_time || 0));
  return { sport: want, count: out.length, games: out };
}

export default { buildGames };
