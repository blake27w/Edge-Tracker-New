// ══════════════════════════════════════════════════════════════
// Tennis — Match & Market Ingestion (T1). Discovers active tennis
// tournaments from The Odds API (keys like tennis_atp_*, tennis_wta_*,
// incl. Challenger/ITF where offered), pulls match-winner (+ totals)
// lines across books, snapshots them, and detects steam (coordinated
// line movement) — the information-asymmetry T1 for tennis.
//
// No new paid data — uses the Odds API plan you already have. Skips
// entirely when no tennis events are active (cost guard).
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setTennisGames, setIntel } from '../../store/index.js';

const { oddsApi, BOOKS, BOOK_LABELS } = config;
const MAX_TOURNEYS = Number(process.env.TENNIS_MAX_TOURNEYS) || 8;

const lastLines = new Map(); // game_id|book|player -> price

async function activeTennisKeys() {
  try {
    const res = await fetch(`${oddsApi.base}/sports?apiKey=${oddsApi.key}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.filter((s) => s.active && /^tennis_/.test(s.key)).map((s) => s.key);
  } catch (_) { return []; }
}

async function fetchMatches(key) {
  const params = new URLSearchParams({
    apiKey: oddsApi.key, regions: 'us', markets: 'h2h,totals',
    oddsFormat: 'american', bookmakers: BOOKS.join(','),
  });
  const res = await fetch(`${oddsApi.base}/sports/${key}/odds?${params}`);
  if (res.status === 422) return [];
  if (!res.ok) throw new Error(`Odds ${res.status} for ${key}`);
  return res.json();
}

function normalize(key, ev, snapshots, movements) {
  const p1 = ev.home_team, p2 = ev.away_team;   // tennis: the two players
  const game = { game_id: ev.id, sport: 'TENNIS', tournament: key, p1, p2, commence_time: ev.commence_time, books: {} };
  for (const bm of ev.bookmakers || []) {
    const label = BOOK_LABELS[bm.key] || bm.title || bm.key;
    game.books[bm.key] = { label, markets: {} };
    for (const mk of bm.markets || []) {
      for (const oc of mk.outcomes || []) {
        game.books[bm.key].markets[`${mk.key}:${oc.name}`] = { line: oc.point ?? null, price: oc.price != null ? Math.round(oc.price) : null };
        snapshots.push({ game_id: ev.id, tournament: key, p1, p2, book: bm.key, market: mk.key, side: oc.name, line: oc.point ?? null, price: oc.price != null ? Math.round(oc.price) : null, fetched_at: new Date().toISOString() });
        if (mk.key === 'h2h' && oc.price != null) {
          const lk = `${ev.id}|${bm.key}|${oc.name}`;
          const prev = lastLines.get(lk);
          if (prev != null && Math.sign(prev) === Math.sign(oc.price) && Math.abs(oc.price - prev) >= 15) {
            movements.push({ game_id: ev.id, player: oc.name, book: bm.key, from: prev, to: Math.round(oc.price) });
          }
          lastLines.set(lk, Math.round(oc.price));
        }
      }
    }
  }
  return game;
}

async function run() {
  if (!oddsApi.key) return { summary: 'skipped — no ODDS_API_KEY' };
  const keys = (await activeTennisKeys()).slice(0, MAX_TOURNEYS);
  if (!keys.length) { setTennisGames([]); return { summary: 'no active tennis tournaments' }; }

  const games = [], snapshots = [], movements = [];
  for (const key of keys) {
    try {
      const evs = await fetchMatches(key);
      for (const ev of evs) games.push(normalize(key, ev, snapshots, movements));
    } catch (e) { logger.warn('tennis-ingest', e.message); }
  }

  if (snapshots.length) { try { await db.insert('tennis_markets', snapshots); } catch (e) { logger.warn('tennis-ingest', e.message); } }
  setTennisGames(games);
  setIntel('tennisMoves', movements);

  return {
    summary: `${games.length} matches across ${keys.length} tournaments, ${movements.length} steam moves`,
    gamesMonitored: games.length,
    data: { matches: games.length, tournaments: keys.length, steam: movements.length },
  };
}

export default { name: 'tennis-ingest', run };
