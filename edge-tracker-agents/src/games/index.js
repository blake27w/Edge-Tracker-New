// ══════════════════════════════════════════════════════════════
// Games board — assembles the daily slate for a sport: each game with
// its opening line (captured from first sight), current consensus line
// + movement, best-book price (line shopping), and any agent signals
// (qualifying play, sharp/RLM, injuries, weather). Powers GET /games.
// ══════════════════════════════════════════════════════════════
import db from '../db/index.js';
import { getGames, signalsForGame, getPlays, getTennisGames, getTennisPlays } from '../store/index.js';
import { computeMarkets } from './lines.js';
import { getOpenings } from '../agents/odds/index.js';

// Best (most favorable) American price per side across books.
function bestPrice(rows) {
  if (!rows.length) return null;
  return rows.reduce((a, b) => (b.price > a.price ? b : a));
}

// Tennis board: matches with best match-winner price per player + steam/play.
function buildTennis() {
  const games = getTennisGames();
  if (!games.length) return { sport: 'TENNIS', games: [], note: 'No active tennis matches.' };
  const plays = getTennisPlays();
  const out = games.map((g) => {
    const p1Rows = [], p2Rows = [];
    for (const [bk, b] of Object.entries(g.books || {})) {
      const label = b.label || bk; const mk = b.markets || {};
      const m1 = mk[`h2h:${g.p1}`], m2 = mk[`h2h:${g.p2}`];
      if (m1 && m1.price != null) p1Rows.push({ book: label, price: m1.price });
      if (m2 && m2.price != null) p2Rows.push({ book: label, price: m2.price });
    }
    const play = plays.find((p) => p.game_id === g.game_id) || null;
    return {
      game_id: g.game_id, sport: 'TENNIS', tournament: g.tournament,
      p1: g.p1, p2: g.p2, commence_time: g.commence_time,
      ml: { p1: bestPrice(p1Rows), p2: bestPrice(p2Rows) },
      play: play ? { side: play.side, score: Math.round(play.score), tier: play.tier, unit_dollars: play.unit_dollars } : null,
    };
  });
  out.sort((a, b) => new Date(a.commence_time || 0) - new Date(b.commence_time || 0));
  return { sport: 'TENNIS', kind: 'tennis', count: out.length, games: out };
}

export async function buildGames(sport) {
  const want = String(sport || '').toUpperCase();
  if (want === 'TENNIS') return buildTennis();
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
      ml: { currentHome: m.ml.consensusHome, currentAway: m.ml.consensusAway, bestHome: m.ml.bestHome, bestAway: m.ml.bestAway },
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

  // Attach any research notes/picks tagged to these games.
  try {
    const rows = await db.select('research_notes', '*', { in: { game_id: games.map((g) => g.game_id) }, order: { column: 'created_at', ascending: false }, limit: 300 });
    const byGame = {};
    for (const r of rows) (byGame[r.game_id] ||= []).push(r);
    for (const g of out) g.research = byGame[g.game_id] || [];
  } catch (_) { /* table optional */ }

  out.sort((a, b) => new Date(a.commence_time || 0) - new Date(b.commence_time || 0));
  return { sport: want, count: out.length, games: out };
}

export default { buildGames };
