// ══════════════════════════════════════════════════════════════
// Opener→Close Line Tracker — every sport on the slate. Reuses the openers we
// already capture (opening_lines) and the live consensus to measure how each
// game's total, spread and moneyline moved from open to close — the
// market-direction signal (which way the money pushed the number). Upcoming
// games show the live open→current move; once a game reaches kickoff its
// open→close move is persisted, and recent history is aggregated overall and
// per sport (how often totals close lower, average move, etc.). $0: the
// inputs are getGames() plus two reads of our own small tables — no fetch(,
// nothing imported from the odds agent. DORMANT on an empty slate.
// Reference/observational — not a play by itself.
//
// The agent's NAME stays `nfl-line-move` (D95): scan_runs history, the durable
// blockedRuns fields on /health, the PWA roster keys and the
// INTERVAL_NFL_LINE_MOVE override all key on it, and a rename would split or
// silently drop each. Same for the `nfl_line_moves` table — additive columns
// only (`sport`, `open_ml`, `close_ml`, `ml_move`).
//
// Which sports? Whatever is on the slate, grouped by g.sport — never a list,
// and never getOddsCeilings().season (D89–D91). That signal answers a budget
// question ("is this sport in the ceiling denominator?") with a deliberate
// 14-day release grace and a forced football backstop, so a sport reads `in`
// for two weeks after its last game and NFL reads `in` on a Tuesday with
// nothing on the board. This agent needs "which games are on the board right
// now", which is exactly getGames(). Importing the season table would also
// pull in agents/odds/index.js, which the zero-spend smoke assertion forbids.
//
// Baseline/movement tables are untouched. Open→close is opening_lines (first
// sight, immutable) vs in-memory consensus; it has no reason to read
// line_movements, the movement intel, or line_snapshots — those answer
// *when/who moved*, this answers *net from open*.
//
// ml_move is in IMPLIED-PROBABILITY POINTS, home side, positive = home
// shortened: -105→+105 is a 210-point "move" in American odds and a ~2.5-pt
// real one. Soccer draws are ignored (we store home ML only).
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setNflLineMove } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';
import { impliedProb } from '../shared/odds-math.js';

const CLOSE_LEAD_MS = 30 * 60_000; // a game ≤30m from kickoff is treated as closed
const HISTORY_DAYS = 180;          // aggregate window
const HISTORY_LIMIT = 4000;        // ~150 rows/day across 12 sports → ~27k/180d; the newest 4000 is plenty
const OPENERS_CHUNK = 100;         // ids per `in:` call so a 300-game Saturday never builds an over-long URL
const persisted = new Set();       // game_id already saved as a close (pruned to the slate each run)

// Blocked reasons are CONSTANT LITERALS (D80): no counts, no env, nothing
// interpolated, so the durable blockedReason on /health is stable text.
export const OPENERS_BLOCKED = 'opening_lines could not be read';
export const SCHEMA_BLOCKED = 'nfl_line_moves is missing the all-sports columns — run the schema.sql block';

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
// Number(null) === 0 and Number('') === 0, so a plain Number() would turn a
// MISSING line into a 0 move and count it in every aggregate. Only a real
// number or a numeric string (Postgres hands numerics back as strings) counts.
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const fin = (v) => { const n = num(v); return Number.isFinite(n) ? n : null; };
// impliedProb(null) is silently 0 (toDecimal(null) → Infinity), so both ends
// are checked here: a real American price is finite and |x| >= 100.
const isPrice = (v) => Number.isFinite(v) && Math.abs(v) >= 100;
const mlMove = (open, close) => (isPrice(open) && isPrice(close) ? r1((impliedProb(close) - impliedProb(open)) * 100) : null);
const delta = (open, close) => (open != null && close != null ? r1(close - open) : null);

// History aggregate for a set of rows; a null move is NOT a 0 move and stays
// out of every denominator.
const agg = (rows) => {
  const tm = rows.map((h) => num(h.total_move)).filter(Number.isFinite);
  const sm = rows.map((h) => num(h.spread_move)).filter(Number.isFinite);
  const mm = rows.map((h) => num(h.ml_move)).filter(Number.isFinite);
  const avgAbs = (xs) => (xs.length ? r1(xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length) : null);
  return {
    n: rows.length,
    total_down_pct: tm.length ? Math.round((tm.filter((x) => x < 0).length / tm.length) * 1000) / 10 : null,
    total_avg_abs: avgAbs(tm),
    spread_avg_abs: avgAbs(sm),
    ml_avg_abs: avgAbs(mm),
  };
};

async function readOpeners(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += OPENERS_CHUNK) {
    out.push(...await db.select('opening_lines', 'game_id,market,line', { in: { game_id: ids.slice(i, i + OPENERS_CHUNK) } }));
  }
  return out;
}

const LEGACY_COLS = ['game_id', 'matchup', 'open_total', 'close_total', 'total_move', 'open_spread', 'close_spread', 'spread_move', 'captured_at'];
const ALL_COLS = [...LEGACY_COLS, 'sport', 'open_ml', 'close_ml', 'ml_move'];
const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));

async function run() {
  if (!db.isConnected()) { setNflLineMove(null); return { summary: 'skipped — no DB' }; }
  const games = getGames().filter((g) => g.sport && g.commence_time);
  if (!games.length) { setNflLineMove(null); return { summary: 'dormant — empty slate' }; }

  // Openers for these games (chunked). Unreadable openers mean the agent can
  // do nothing this run — say so, loudly.
  const ids = games.map((g) => g.game_id);
  let opens;
  try { opens = await readOpeners(ids); }
  catch (e) {
    logger.warn('nfl-line-move', `opening_lines: ${e.message}`);
    setNflLineMove(null);
    return { summary: 'skipped — opening_lines unreadable', blocked: OPENERS_BLOCKED };
  }
  const openMap = new Map();
  for (const o of opens) openMap.set(`${o.game_id}|${o.market}`, fin(o.line));

  const now = Date.now();
  const live = [], toClose = [];
  for (const g of games) {
    const m = computeMarkets(g);
    const curTotal = fin(g.consensusTotal ?? m.total.consensus);
    const curSpread = fin(m.spread.consensusHome);
    const curMl = fin(m.ml.consensusHome);
    const openTotal = openMap.get(`${g.game_id}|total`) ?? null;
    const openSpread = openMap.get(`${g.game_id}|spread`) ?? null;
    const openMl = openMap.get(`${g.game_id}|ml`) ?? null;
    const row = {
      sport: g.sport, game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, commence_time: g.commence_time,
      open_total: r1(openTotal), close_total: r1(curTotal), total_move: delta(openTotal, curTotal),
      open_spread: r1(openSpread), close_spread: r1(curSpread), spread_move: delta(openSpread, curSpread),
      open_ml: openMl, close_ml: curMl, ml_move: mlMove(openMl, curMl),
    };
    const started = new Date(g.commence_time).getTime() <= now + CLOSE_LEAD_MS;
    if (started) toClose.push(row); else live.push(row);
  }

  // Persist open→close once per game (dedup in-memory + against today's rows).
  let blocked = null;
  let logged = new Set();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ex = await db.select('nfl_line_moves', 'game_id', { gte: { captured_at: today + 'T00:00:00Z' } });
    logged = new Set(ex.map((r) => r.game_id));
  } catch (_) { /* table optional */ }
  const onSlate = new Set(ids);
  for (const id of persisted) if (!onSlate.has(id)) persisted.delete(id);
  const fresh = toClose.filter((r) => !persisted.has(r.game_id) && !logged.has(r.game_id)
    && (r.total_move != null || r.spread_move != null || r.ml_move != null));
  if (fresh.length) {
    fresh.forEach((r) => persisted.add(r.game_id));
    const nowIso = new Date().toISOString();
    const rows = fresh.map((r) => ({ ...pick(r, ALL_COLS), captured_at: nowIso }));
    try { await db.insert('nfl_line_moves', rows); }
    catch (e) {
      // The four new columns are hand-run DDL (D73 distinction: a missing
      // COLUMN, not a missing relation). Retry once with them stripped so the
      // legacy NFL rows keep landing, and report the schema gap as blocked.
      if (/column/i.test(e.message || '')) {
        blocked = SCHEMA_BLOCKED;
        try { await db.insert('nfl_line_moves', rows.map((r) => pick(r, LEGACY_COLS))); }
        catch (e2) { logger.warn('nfl-line-move', e2.message); }
      } else logger.warn('nfl-line-move', e.message);
    }
  }

  // Aggregate recent closed history (market direction tendencies), overall and
  // per sport. One bounded query, grouped in JS. Legacy rows have no sport and
  // are NFL by construction (the DDL block backfills them).
  let hist = [];
  try {
    hist = await db.select('nfl_line_moves', 'sport,total_move,spread_move,ml_move', {
      gte: { captured_at: new Date(now - HISTORY_DAYS * 86_400_000).toISOString() },
      order: { column: 'captured_at', ascending: false }, limit: HISTORY_LIMIT,
    });
  } catch (_) { /* none */ }
  const overall = agg(hist);
  const histBySport = {};
  for (const h of hist) (histBySport[h.sport || 'NFL'] ||= []).push(h);
  const bySport = Object.entries(histBySport).map(([sport, rows]) => ({ sport, ...agg(rows) })).sort((a, b) => b.n - a.n);

  const sports = [...new Set(games.map((g) => g.sport))];
  live.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
  setNflLineMove({ updated: new Date().toISOString(), live: live.slice(0, 80), agg: overall, bySport });
  const out = {
    summary: `${live.length} games · ${sports.length} sports (${fresh.length} new closes) · ${overall.n} in history`,
    data: { live: live.length, sports: sports.length, closed: fresh.length, history: overall.n },
  };
  if (blocked) out.blocked = blocked;
  return out;
}

export default { name: 'nfl-line-move', run };
