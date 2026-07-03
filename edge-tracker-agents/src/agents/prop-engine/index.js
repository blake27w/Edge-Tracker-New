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
import { hasOddsBudget } from '../odds/index.js';

const { oddsApi, SPORTS, BOOKS } = config;

const PROP_MARKETS = {
  MLB: ['batter_hits', 'batter_total_bases', 'pitcher_strikeouts'],
  NBA: ['player_points', 'player_rebounds', 'player_assists'],
  NHL: ['player_points', 'player_shots_on_goal'],
  NFL: ['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_receptions'],
};
// Line-shopping thresholds (a book this far off the consensus line = an edge).
// NFL is PER-MARKET: 15 was calibrated for pass yards (lines 200-300) and made
// rush/receiving (lines 40-90) effectively unable to trigger.
const LINE_EDGE = {
  MLB: 1, NBA: 2.5, NHL: 1,
  NFL: { player_pass_yds: 15, player_rush_yds: 8, player_reception_yds: 8, player_receptions: 1.5 },
};

const MAX_PER_RUN = num(process.env.PROP_MAX_GAMES_PER_RUN, 6);
const MAX_PER_DAY = num(process.env.PROP_MAX_SCANS_PER_DAY, 20); // each scan = a multi-market event call (several credits)

// Classify a prop play by the trigger that surfaced it (tag from the real
// source — never a guess). The underlying mechanism is always a cross-book
// line discrepancy; the trigger is what made us look.
function propSignalType(trigger, market, side, sport) {
  if (trigger === 'qb_change') return 'qb_change';
  if (trigger === 'injury') return 'injury_backup';
  if (trigger === 'weather') {
    if (sport === 'NFL' && market === 'player_pass_yds' && side === 'UNDER') return 'weather_passing_under';
    return 'line_shop';
  }
  return 'line_shop';
}

const seenOut = new Set();          // game_id|player already alerted on
const persisted = new Set();        // game_id|player|stat|side already in monitor_scores
const closedGames = new Set();      // games whose prop close was already captured
let day = today(), scansToday = 0, closesToday = 0;
const CLOSE_MAX = num(process.env.PROP_CLOSE_MAX_DAY, 4); // close-capture scans per day

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
  const sportThr = LINE_EDGE[sport];
  const edges = [];
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const [player, market, side] = key.split('|');
    const thr = (sportThr && typeof sportThr === 'object' ? sportThr[market] : sportThr) || 0.5;
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

// ── Prop close-capture → CLV ─────────────────────────────────────
// Props previously validated on win rate alone — the only part of the system
// exempt from beat-the-close validation. For games with pending prop plays
// kicking off within 75 min, ONE bounded re-scan records the closing consensus
// per player/stat/side into clv_records (bet_market 'prop'), so props flow
// into the Market Validation panel like every other market.
async function captureCloses(byId) {
  if (closesToday >= CLOSE_MAX || !db.isConnected()) return 0;
  let pending = [];
  try { pending = await db.select('monitor_scores', 'game_id,sport,player,stat_type,side,line,scored_at', { match: { market: 'prop', status: 'pending' }, limit: 200 }); } catch (_) { return 0; }
  const nearGames = new Map();
  for (const p of pending) {
    if (!p.player || p.line == null || closedGames.has(p.game_id)) continue;
    const g = byId.get(p.game_id);
    if (!g || !g.commence_time) continue;
    const dt = Date.parse(g.commence_time) - Date.now();
    if (dt > 0 && dt <= 75 * 60_000) (nearGames.get(p.game_id) || nearGames.set(p.game_id, []).get(p.game_id)).push(p);
  }
  let captured = 0;
  for (const [gameId, list] of nearGames) {
    if (closesToday >= CLOSE_MAX) break;
    const g = byId.get(gameId);
    const meta = SPORTS[g.sport], markets = PROP_MARKETS[g.sport];
    if (!meta || !markets) continue;
    let data;
    try { data = await fetchProps(meta.key, gameId, markets); } catch (_) { continue; }
    closedGames.add(gameId); closesToday++;
    if (!data) continue;
    // Closing consensus (median line across books) per player|market|side.
    const groups = new Map();
    for (const bm of data.bookmakers || []) for (const mk of bm.markets || []) for (const oc of mk.outcomes || []) {
      if (!oc.description || oc.point == null) continue;
      const key = `${oc.description}|${mk.key}|${String(oc.name).toUpperCase()}`;
      (groups.get(key) || groups.set(key, []).get(key)).push(oc.point);
    }
    const nowIso = new Date().toISOString();
    const rows = [];
    for (const p of list) {
      const close = median(groups.get(`${p.player}|${p.stat_type}|${p.side}`) || []);
      if (close == null) continue;
      // OVER beat the close if the line rose above our entry; UNDER if it fell.
      const clv = p.side === 'OVER' ? close - Number(p.line) : Number(p.line) - close;
      rows.push({
        sport: p.sport, game_id: gameId, bet_market: 'prop',
        side: `${p.player}|${p.stat_type}|${p.side}`,
        line_logged: p.line, line_close: close,
        clv: Math.round(clv * 10) / 10, beat_close: clv > 0,
        entry_at: p.scored_at, close_at: nowIso, suspect: false,
      });
    }
    if (rows.length) {
      try { await db.upsert('clv_records', rows, 'game_id,bet_market,side', { ignoreDuplicates: true }); captured += rows.length; }
      catch (e) { logger.warn('prop-engine', `clv: ${e.message}`); }
    }
  }
  return captured;
}

async function run() {
  if (!oddsApi.key) { setPropPlays([]); return { summary: 'skipped — no ODDS_API_KEY' }; }
  if (!hasOddsBudget(config.rules.oddsReserve)) { setPropPlays([]); return { summary: 'skipped — protecting odds budget' }; }
  if (today() !== day) { day = today(); scansToday = 0; closesToday = 0; }

  const games = getGames();
  const byId = new Map(games.map((g) => [g.game_id, g]));

  // Close-capture runs regardless of new triggers — kickoffs approach either way.
  const closes = await captureCloses(byId);

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
  // NFL QB status changes (from nfl-qb) — the biggest prop cascade: every
  // pass-catcher's line goes stale for minutes. Highest-priority trigger.
  for (const c of getIntel('qbChanges')) {
    if (!c.game_id || !byId.has(c.game_id)) continue;
    const k = `qb|${c.game_id}|${c.player}|${c.new_status}`;
    if (seenOut.has(k)) continue;
    seenOut.add(k);
    triggerGames.set(c.game_id, 'qb_change'); // overrides weaker triggers for this game
  }

  if (!triggerGames.size) { return { summary: `no new prop triggers — idle${closes ? ` · ${closes} prop closes captured` : ''}` }; }

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
        sport: g.sport, game_id: gameId, matchup: `${g.away} @ ${g.home}`, commence_time: g.commence_time, market: 'prop',
        side: `${e.player} ${e.side} ${e.line} ${e.market.replace(/_/g, ' ')}`, line: e.line,
        _player: e.player, _stat: e.market, _side: e.side.toUpperCase(),
        _propType: propSignalType(trigger, e.market, e.side.toUpperCase(), g.sport),
        score: 75, confidence: 75, tier: '1u', unit_mult: 1, unit_dollars: config.rules.unitDollars, t1_count: 1,
        signals: [{ tier: 1, id: trigger, label: `${trigger} edge — best ${e.book} ${e.line} vs ${e.consensus} consensus` }],
        qualified: true, market_trigger: trigger, scored_at: now,
      });
    }
  }

  if (snapshots.length) { try { await db.insert('prop_snapshots', snapshots); } catch (e) { logger.warn('prop-engine', e.message); } }
  setPropPlays(plays);

  // Persist gradeable prop picks to monitor_scores (structured) so the grader
  // can settle them from ESPN box scores and they count toward the record.
  const gradeable = [];
  for (const p of plays) {
    if (!p._player || !p._side) continue;
    const key = `${p.game_id}|${p._player}|${p._stat}|${p._side}`;
    if (persisted.has(key)) continue;
    persisted.add(key);
    gradeable.push({
      sport: p.sport, game_id: p.game_id, matchup: p.matchup, market: 'prop',
      side: p._side, line: p.line, player: p._player, stat_type: p._stat, prop_signal_type: p._propType,
      raw_score: p.score, score: p.score, confidence: p.confidence, tier: p.tier,
      unit_mult: p.unit_mult, unit_dollars: p.unit_dollars, t1_count: p.t1_count,
      signals: p.signals, qualified: true, status: 'pending', scored_at: now,
    });
  }
  if (gradeable.length) { try { await db.insert('monitor_scores', gradeable); } catch (e) { logger.warn('prop-engine', `persist: ${e.message}`); } }

  return {
    summary: `${scanned} games scanned, ${snapshots.length} prop edges flagged${closes ? ` · ${closes} closes captured` : ''} · Odds API (no Claude)`,
    data: { scanned, edges: snapshots.length, scansToday, closes },
  };
}

export default { name: 'prop-engine', run };
