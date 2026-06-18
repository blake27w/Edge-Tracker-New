// ══════════════════════════════════════════════════════════════
// Prop Engine (Agent 11) — code-based, no Claude. When a starter is
// newly ruled OUT (or a game is windy), it pulls that game's player
// props from The Odds API and flags cross-book edges: a book whose line
// is meaningfully off consensus (line shopping) — which is exactly how a
// stale post-injury backup line shows up. Uses Odds-API quota only.
//
// Bounded: only scans games with a NEW trigger, capped per run and per
// day (PROP_MAX_GAMES_PER_RUN, PROP_MAX_SCANS_PER_DAY).
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, getIntel, setPropPlays } from '../../store/index.js';

const { oddsApi, SPORTS, BOOKS } = config;

const PROP_MARKETS = {
  MLB: ['batter_hits', 'batter_total_bases', 'pitcher_strikeouts'],
  NBA: ['player_points', 'player_rebounds', 'player_assists'],
  NHL: ['player_points', 'player_shots_on_goal'],
  NFL: ['player_pass_yds', 'player_rush_yds', 'player_reception_yds'],
};
// Line-shopping thresholds (a book this far off the consensus line = an edge).
const LINE_EDGE = { MLB: 0.5, NBA: 1.5, NHL: 0.5, NFL: 10 };

const MAX_PER_RUN = num(process.env.PROP_MAX_GAMES_PER_RUN, 6);
const MAX_PER_DAY = num(process.env.PROP_MAX_SCANS_PER_DAY, 40);

const seenOut = new Set();          // game_id|player already alerted on
let day = today(), scansToday = 0;

function today() { return new Date().toISOString().slice(0, 10); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

async function fetchProps(sportKey, eventId, markets) {
  const params = new URLSearchParams({
    apiKey: oddsApi.key, regions: 'us', oddsFormat: 'american',
    markets: markets.join(','), bookmakers: BOOKS.join(','),
  });
  const res = await fetch(`${oddsApi.base}/sports/${sportKey}/events/${eventId}/odds?${params}`);
  if (res.status === 404 || res.status === 422) return null; // no props for this event
  if (!res.ok) throw new Error(`Odds props ${res.status}`);
  return res.json();
}

// Find the most favorable book per player/market/side and flag if it's an
// outlier vs consensus. Over wants the LOWEST line, Under the HIGHEST.
function flagEdges(data, sport, game) {
  const groups = new Map(); // player|market|side -> [{book,line,price}]
  for (const bm of data.bookmakers || []) {
    for (const mk of bm.markets || []) {
      for (const oc of mk.outcomes || []) {
        const player = oc.description; const side = oc.name; // Over/Under
        if (!player || oc.point == null) continue;
        const key = `${player}|${mk.key}|${side}`;
        (groups.get(key) || groups.set(key, []).get(key)).push({ book: bm.title || bm.key, line: oc.point, price: oc.price });
      }
    }
  }
  const thr = LINE_EDGE[sport] || 0.5;
  const edges = [];
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const [player, market, side] = key.split('|');
    const med = median(rows.map((r) => r.line));
    const best = side === 'Over'
      ? rows.reduce((a, b) => (b.line < a.line ? b : a))   // lowest line for Over
      : rows.reduce((a, b) => (b.line > a.line ? b : a));   // highest line for Under
    if (med != null && Math.abs(best.line - med) >= thr) {
      edges.push({ player, market, side, line: best.line, price: best.price, book: best.book, consensus: med });
    }
  }
  return edges;
}

async function run() {
  if (!oddsApi.key) { setPropPlays([]); return { summary: 'skipped — no ODDS_API_KEY' }; }
  if (today() !== day) { day = today(); scansToday = 0; }

  const games = getGames();
  const byId = new Map(games.map((g) => [g.game_id, g]));

  // Triggers: newly-OUT impactful players, + windy outdoor games.
  const triggerGames = new Map(); // game_id -> trigger
  for (const inj of getIntel('injuries')) {
    if (inj.status !== 'OUT' || inj.impact === 'low') continue;
    const k = `${inj.game_id}|${inj.player}`;
    if (seenOut.has(k)) continue;
    seenOut.add(k);
    if (inj.game_id && byId.has(inj.game_id)) triggerGames.set(inj.game_id, 'injury');
  }
  for (const w of getIntel('weather')) {
    if (!w.dome && (w.wind_mph || 0) >= 15 && byId.has(w.game_id)) {
      if (!triggerGames.has(w.game_id)) triggerGames.set(w.game_id, 'weather');
    }
  }

  if (!triggerGames.size) { return { summary: 'no new prop triggers — idle' }; }

  const now = new Date().toISOString();
  const snapshots = [], plays = [];
  let scanned = 0;

  for (const [gameId, trigger] of triggerGames) {
    if (scanned >= MAX_PER_RUN || scansToday >= MAX_PER_DAY) break;
    const g = byId.get(gameId);
    const meta = SPORTS[g.sport];
    const markets = PROP_MARKETS[g.sport];
    if (!meta || !markets) continue;
    let data;
    try { data = await fetchProps(meta.key, gameId, markets); } catch (e) { logger.warn('prop-engine', `${g.away}@${g.home}: ${e.message}`); continue; }
    scanned++; scansToday++;
    if (!data) continue;

    for (const e of flagEdges(data, g.sport, g)) {
      snapshots.push({
        sport: g.sport, game_id: gameId, player_id: null, player: e.player, stat_type: e.market,
        line: e.line, side: e.side.toUpperCase(), price: Math.round(e.price), book: e.book, trigger, fetched_at: now,
      });
      plays.push({
        sport: g.sport, game_id: gameId, matchup: `${g.away} @ ${g.home}`, market: 'prop',
        side: `${e.player} ${e.side} ${e.line} ${e.market.replace(/_/g, ' ')}`, line: e.line,
        score: 75, confidence: 75, tier: '1u', unit_mult: 1, unit_dollars: config.rules.unitDollars, t1_count: 1,
        signals: [{ tier: 1, id: trigger, label: `${trigger} edge — best ${e.book} ${e.line} vs ${e.consensus} consensus` }],
        qualified: true, market_trigger: trigger, scored_at: now,
      });
    }
  }

  if (snapshots.length) { try { await db.insert('prop_snapshots', snapshots); } catch (e) { logger.warn('prop-engine', e.message); } }
  setPropPlays(plays);

  return {
    summary: `${scanned} games scanned, ${snapshots.length} prop edges flagged · Odds API (no Claude)`,
    data: { scanned, edges: snapshots.length, scansToday },
  };
}

export default { name: 'prop-engine', run };
