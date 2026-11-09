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
// (The HISTORY read is the one place the config roster is consulted — see
// below — because a sport whose season ended is, by definition, not on the
// slate, and its history must still be reported.)
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
import config from '../../config/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setNflLineMove } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';
import { impliedProb } from '../shared/odds-math.js';

const CLOSE_LEAD_MS = 30 * 60_000;       // a game ≤30m from kickoff is treated as closed
const SLATE_HORIZON_MS = 36 * 3600_000;  // getGames() holds games starting in the next 36h (odds agent)
const HISTORY_DAYS = 180;                // aggregate window (upper bound — the real span is published)
const HISTORY_LIMIT = 4000;              // rows across ALL sports; split evenly per sport below
const LIVE_PER_SPORT = 32;               // the old NFL-only cap, now applied per sport so no sport evicts another
const OPENERS_CHUNK = 100;               // ids per `in:` call so a 300-game Saturday never builds an over-long URL
const OPENERS_FAIL_RUNS = 3;             // consecutive unreadable-opener runs before it counts as blocked (D76 idiom)
const POSTGREST_DEFAULT_MAX_ROWS = 1000; // PostgREST's default `max-rows`; a limit above it is silently clamped
                                         // (the `limit: 8000`/`20000` reads in backtest, book-edges, book-move and
                                         // src/index.js have the same exposure and no guard — not touched here)
const persisted = new Set();             // game_id already saved as a close (pruned to the slate each run)

// Blocked reasons are CONSTANT LITERALS (D80): no counts, no env, nothing
// interpolated, so the durable blockedReason on /health is stable text.
export const OPENERS_BLOCKED = 'opening_lines could not be read';
export const SCHEMA_BLOCKED = 'nfl_line_moves is missing the all-sports columns — run the schema.sql block';

// Process-lifetime state, each a D80 "will prevent the next run identically
// until a human acts" condition or the streak that decides one:
//   schemaMissing — latched the first time the insert is rejected on the new
//     columns, cleared only by an insert WITH them succeeding. A run with no
//     new close has no insert to fail, so without the latch /health would
//     toggle blockedRuns 1→0→1 all day and re-fire reportDegraded on every
//     re-entry — the opposite of a standing block.
//   openersFailRuns — a lone opening_lines read failure is a network blip, not
//     a block; OPENERS_FAIL_RUNS consecutive ones are (D76's breaker shape).
let schemaMissing = false;
// Every exit carries the latch. The early returns (no DB, empty slate, a
// transient openers blip) used to return without `blocked`, and the
// orchestrator reads a run without `blocked` as recovery — zeroing the streak,
// clearing the degraded key and re-firing the watchdog on the next run: the
// 1→0→1 flicker the latch exists to stop, through a different door.
const withLatch = (o) => (schemaMissing && !o.blocked ? { ...o, blocked: SCHEMA_BLOCKED } : o);
let openersFailRuns = 0;

// Test seam.
export function __resetState() { persisted.clear(); schemaMissing = false; openersFailRuns = 0; }

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

// A `limit: N > 1000` select that returns EXACTLY 1000 rows was almost
// certainly clamped by PostgREST's default max-rows, not satisfied — nobody
// can verify the project's setting from here, so the shape is flagged instead.
export const postgrestCapped = (limit, rows) => limit > POSTGREST_DEFAULT_MAX_ROWS && rows.length === POSTGREST_DEFAULT_MAX_ROWS;

// History aggregate for a set of rows; a null move is NOT a 0 move and stays
// out of every denominator. `from` is the oldest row's stamp — the honest span
// of the sample, which the row cap makes shorter than HISTORY_DAYS for any
// busy sport.
const agg = (rows) => {
  const tm = rows.map((h) => num(h.total_move)).filter(Number.isFinite);
  const sm = rows.map((h) => num(h.spread_move)).filter(Number.isFinite);
  const mm = rows.map((h) => num(h.ml_move)).filter(Number.isFinite);
  const avgAbs = (xs) => (xs.length ? r1(xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length) : null);
  const stamps = rows.map((h) => new Date(h.captured_at).getTime()).filter(Number.isFinite);
  const from = stamps.length ? new Date(Math.min(...stamps)).toISOString() : null;
  return {
    n: rows.length,
    total_down_pct: tm.length ? Math.round((tm.filter((x) => x < 0).length / tm.length) * 1000) / 10 : null,
    total_avg_abs: avgAbs(tm),
    spread_avg_abs: avgAbs(sm),
    ml_avg_abs: avgAbs(mm),
    from,
    days: from ? Math.max(1, Math.ceil((Date.now() - new Date(from).getTime()) / 86_400_000)) : null,
  };
};

async function readOpeners(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += OPENERS_CHUNK) {
    out.push(...await db.select('opening_lines', 'game_id,market,line', { in: { game_id: ids.slice(i, i + OPENERS_CHUNK) } }));
  }
  return out;
}

// Keep each sport's soonest N upcoming games, then merge by kickoff. A single
// cross-sport cap sorted by commence_time let a 150-game Saturday fill every
// slot before Sunday NFL — the NFL Prep block painted zero rows.
function capPerSport(rows, n) {
  const by = {};
  for (const r of rows) (by[r.sport] ||= []).push(r);
  const out = [];
  for (const arr of Object.values(by)) {
    arr.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    out.push(...arr.slice(0, n));
  }
  return out.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
}

const LEGACY_COLS = ['game_id', 'matchup', 'open_total', 'close_total', 'total_move', 'open_spread', 'close_spread', 'spread_move', 'captured_at'];
const ALL_COLS = [...LEGACY_COLS, 'sport', 'open_ml', 'close_ml', 'ml_move'];
// The legacy columns carry no sport, and every reader (the PWA, the schema.sql
// backfill) treats a sportless row as this sport — so only rows of this sport
// may ever be written on them. Anything else written sportless would be
// relabelled NFL forever and pollute NFL aggregates with NBA-scale moves.
const LEGACY_SPORT = 'NFL';
const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));

async function run() {
  if (!db.isConnected()) { setNflLineMove(null); return withLatch({ summary: 'skipped — no DB' }); }
  const games = getGames().filter((g) => g.sport && g.commence_time);
  if (!games.length) { setNflLineMove(null); return withLatch({ summary: 'dormant — empty slate' }); }

  // Openers for these games (chunked). Unreadable openers mean the agent can
  // do nothing this run; one failure is a blip and is said in the summary,
  // OPENERS_FAIL_RUNS in a row is a block (D80 reserves `blocked` for what
  // will fail identically next run).
  const ids = games.map((g) => g.game_id);
  let opens;
  try { opens = await readOpeners(ids); openersFailRuns = 0; }
  catch (e) {
    openersFailRuns++;
    logger.warn('nfl-line-move', `opening_lines: ${e.message} (${openersFailRuns} consecutive)`);
    setNflLineMove(null);
    const summary = `skipped — opening_lines unreadable (${openersFailRuns} consecutive)`;
    return openersFailRuns >= OPENERS_FAIL_RUNS ? { summary, blocked: OPENERS_BLOCKED } : withLatch({ summary });
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

  // Persist open→close once per game: dedup in-memory and against rows written
  // within the slate horizon. The horizon, not the UTC day — a game closing at
  // 23:50Z that drops off the slate for one cycle and is back after 00:00Z
  // would otherwise be re-inserted.
  let logged = new Set();
  try {
    const ex = await db.select('nfl_line_moves', 'game_id', { gte: { captured_at: new Date(now - SLATE_HORIZON_MS).toISOString() } });
    logged = new Set(ex.map((r) => r.game_id));
  } catch (_) { /* table optional */ }
  const onSlate = new Set(ids);
  for (const id of persisted) if (!onSlate.has(id)) persisted.delete(id);
  const fresh = toClose.filter((r) => !persisted.has(r.game_id) && !logged.has(r.game_id)
    && (r.total_move != null || r.spread_move != null || r.ml_move != null));
  let dropped = [];
  if (fresh.length) {
    fresh.forEach((r) => persisted.add(r.game_id));
    const nowIso = new Date().toISOString();
    const rows = fresh.map((r) => ({ ...pick(r, ALL_COLS), captured_at: nowIso }));
    try { await db.insert('nfl_line_moves', rows); schemaMissing = false; }
    catch (e) {
      // The four new columns are hand-run DDL (D73 distinction: a missing
      // COLUMN, not a missing relation). Retry once with them stripped so the
      // legacy rows keep landing — NFL ONLY, because a stripped row is
      // sportless and sportless means NFL to every reader. The other sports'
      // closes are lost for this run; the loss is counted here and announced
      // by SCHEMA_BLOCKED, and their ids are left out of `persisted` so they
      // land on a later run if the DDL is applied while they are on the slate.
      if (/column/i.test(e.message || '')) {
        schemaMissing = true;
        const keep = rows.filter((r) => r.sport === LEGACY_SPORT);
        dropped = rows.filter((r) => r.sport !== LEGACY_SPORT);
        for (const r of dropped) persisted.delete(r.game_id);
        if (dropped.length) {
          const lost = [...new Set(dropped.map((r) => r.sport))].sort().join(', ');
          logger.warn('nfl-line-move', `schema missing the all-sports columns — ${dropped.length} non-NFL close(s) NOT written (${lost}); only NFL rows land on the legacy columns`);
        }
        if (keep.length) {
          try { await db.insert('nfl_line_moves', keep.map((r) => pick(r, LEGACY_COLS))); }
          catch (e2) { logger.warn('nfl-line-move', e2.message); }
        }
      } else logger.warn('nfl-line-move', e.message);
    }
  }

  // Aggregate recent closed history (market direction tendencies), overall and
  // per sport. One bounded query PER SPORT — the config roster plus whatever
  // is on the slate — with the row budget split evenly. A single newest-N
  // query across sports held ~27 days at 12-sport volume, so a sport whose
  // season ended a month ago silently vanished from bySport; per-sport bounds
  // keep every sport's real n (and its `thin` marker) on the board. Legacy
  // sportless rows are the schema.sql backfill's job, not a 13th query.
  const histSports = [...new Set([...Object.keys(config.SPORTS), ...games.map((g) => g.sport)])];
  const perSport = Math.max(1, Math.floor(HISTORY_LIMIT / histSports.length));
  const since = new Date(now - HISTORY_DAYS * 86_400_000).toISOString();
  const histBySport = {};
  let historyCapped = false;
  for (const sport of histSports) {
    try {
      const rows = await db.select('nfl_line_moves', 'sport,total_move,spread_move,ml_move,captured_at', {
        match: { sport }, gte: { captured_at: since },
        order: { column: 'captured_at', ascending: false }, limit: perSport,
      });
      if (postgrestCapped(perSport, rows)) {
        if (!historyCapped) logger.warn('nfl-line-move', `history read for ${sport} returned exactly ${POSTGREST_DEFAULT_MAX_ROWS} rows against limit ${perSport} — PostgREST max-rows is likely clamping it`);
        historyCapped = true;
      }
      for (const h of rows) (histBySport[h.sport || LEGACY_SPORT] ||= []).push(h);
    } catch (_) { /* none (pre-DDL the `sport` projection itself is rejected) */ }
  }
  const hist = Object.values(histBySport).flat();
  const overall = agg(hist);
  const bySport = Object.entries(histBySport).map(([sport, rows]) => ({ sport, ...agg(rows) })).sort((a, b) => b.n - a.n);

  const sports = [...new Set(games.map((g) => g.sport))];
  // Consensus openers for EVERY slate game, started or not (`live` drops the
  // started ones): the /splits route joins these to the public percentages so
  // it never has to read opening_lines per request. A missing opener is null,
  // never 0.
  const openers = Object.fromEntries(games.map((g) => [g.game_id, {
    total: r1(openMap.get(`${g.game_id}|total`) ?? null),
    spread: r1(openMap.get(`${g.game_id}|spread`) ?? null),
    ml: openMap.get(`${g.game_id}|ml`) ?? null,
  }]));
  setNflLineMove({
    updated: new Date().toISOString(), live: capPerSport(live, LIVE_PER_SPORT), agg: overall, bySport,
    history_from: overall.from, history_days: overall.days, history_capped: historyCapped, openers,
  });
  const out = {
    summary: `${live.length} games · ${sports.length} sports (${fresh.length - dropped.length} new closes${dropped.length ? `, ${dropped.length} dropped — schema` : ''}) · ${overall.n} in history`,
    data: { live: live.length, sports: sports.length, closed: fresh.length - dropped.length, dropped: dropped.length, history: overall.n, history_days: overall.days, history_capped: historyCapped },
  };
  return withLatch(out);
}

export default { name: 'nfl-line-move', run };
