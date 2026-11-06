// ══════════════════════════════════════════════════════════════
// Bounded history reader + the simultaneity test for steam.
//
// Steam is a claim about SIMULTANEITY: three or more books moved the same
// market the same way AT THE SAME TIME. A per-row gap filter proves only that
// each row's own baseline was recent — three books each with gap_min 30 whose
// detected_at are two hours apart pass every per-row test and are not one
// market move. What the data knows exactly is the interval each move must have
// happened in:
//
//   I(r) = [ detected_at(r) − gap_min(r) , detected_at(r) ]
//   lo = max(detected_at − gap_min) over the cluster;  hi = min(detected_at)
//   steam  iff  lo <= hi  AND  distinct books >= minBooks
//
// `lo <= hi` is literally "there exists one instant at which all of these
// books could have moved". Two filters, both necessary: the per-row bound
// (steamSafeMovements, imported — the ONE definition of it, never restated
// here) and the cross-row interval intersection below.
//
// The read is one `db.select` per game, riding line_movements_game_idx
// (game_id, detected_at desc): `match` is the game_id equality, `gte` the
// window, newest-first with a limit. Never `in: { game_id: [...] }` — ordering
// across many game_ids cannot use the composite index and degrades into an
// unbounded sort on a 530k-row table (D71). market/side/direction are grouped
// in JS so the index prefix stays an equality. NO `fetch(` here: the reader
// spends nothing, and tools/smoke.mjs reads this file to keep it that way.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { steamSafeMovements } from '../odds/index.js';

export const HIST_MAX_GAMES = Number(process.env.SHARP_HIST_MAX_GAMES) || 24;     // selects per run
export const HIST_ROW_LIMIT = Number(process.env.SHARP_HIST_ROW_LIMIT) || 400;    // rows per select
// An admissible cluster spans at most the per-row bound plus one cadence tick,
// so the window edge never slices a cluster; wider buys nothing.
export const STEAM_LOOKBACK_MIN = Number(process.env.SHARP_HIST_LOOKBACK_MIN) || 45;
// `baseline_source` is deliberately NOT selected: not needed, and naming a
// hand-run column in a projection makes PostgREST reject the whole select.
export const HIST_COLS = 'sport,game_id,market,book,side,line_open,line_current,moved,direction,gap_min,detected_at';

const MIN_MS = 60_000;

// Kickoff in [now − 3h, now + 24h]; upcoming soonest-first claim the cap, then
// in-progress games freshest-first (book-move's rule, verbatim).
export function selectSlate(games, now, max = HIST_MAX_GAMES) {
  const inWindow = [];
  for (const g of games || []) {
    if (!g || !g.game_id) continue;
    const t = g.commence_time ? new Date(g.commence_time).getTime() : NaN;
    if (Number.isFinite(t) && t >= now - 3 * 3600_000 && t <= now + 24 * 3600_000) inWindow.push({ g, t });
  }
  const upcoming = inWindow.filter((x) => x.t >= now).sort((a, b) => a.t - b.t);
  const started = inWindow.filter((x) => x.t < now).sort((a, b) => b.t - a.t);
  return [...upcoming, ...started].slice(0, max).map((x) => x.g);
}

// A gap is a number, or a non-blank string (Postgres hands numerics back as
// strings), that parses finite and non-negative. Everything else — null (a
// pre-fix row, D73), '', '  ', [], false, true, 'soon', -5 — is NOT a gap and
// must never be coerced into one: Number(x) is a finite 0 for most of those,
// i.e. the most simultaneous row there is (the D10/D79 trap).
function gapOf(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const numOf = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Postgres row (or in-memory row) -> one shape. Presence is checked before any
// coercion; a row with no parseable detected_at cannot be placed on a timeline
// and is dropped. gap_min becomes a number or null — null is kept on the row
// (not dropped) so the caller can COUNT it: a window full of null-gap rows is
// a writer fault to report, not an empty window.
export function normalizeRow(r, src = 'history') {
  if (!r || !r.game_id || !r.book || !r.market || !r.side) return null;
  if (r.direction !== 'up' && r.direction !== 'down') return null;
  const at = r.detected_at == null || r.detected_at === '' ? NaN : Date.parse(r.detected_at);
  if (!Number.isFinite(at)) return null;
  return {
    sport: r.sport, game_id: r.game_id, market: r.market, book: r.book, side: r.side,
    direction: r.direction,
    line_open: numOf(r.line_open), line_current: numOf(r.line_current), moved: numOf(r.moved),
    gap_min: gapOf(r.gap_min),
    detected_at: new Date(at).toISOString(), at, src,
  };
}

// One select per game, newest-first, bounded. A failed read is COUNTED, never
// fatal (hydrateBaseline's rule): one timed-out game must not blind the other
// 23. No missing-column strip-and-retry — the DDL is live, and if the column
// ever vanished this fails loudly into the read-failure state rather than
// silently emitting zero steam.
export async function readMovementHistory(slate, { now = Date.now(), lookbackMin = STEAM_LOOKBACK_MIN } = {}) {
  const out = { rows: [], queried: 0, failures: 0, truncated: 0, preFix: 0 };
  const since = new Date(now - lookbackMin * MIN_MS).toISOString();
  for (const g of slate || []) {
    out.queried++;
    let rows;
    try {
      rows = await db.select('line_movements', HIST_COLS, {
        match: { game_id: g.game_id }, gte: { detected_at: since },
        order: { column: 'detected_at', ascending: false }, limit: HIST_ROW_LIMIT,
      });
    } catch (e) {
      out.failures++;
      logger.warn('sharp', `line_movements read failed for ${g.game_id}: ${e.message}`);
      continue;
    }
    if (!Array.isArray(rows)) rows = [];
    if (rows.length >= HIST_ROW_LIMIT) out.truncated++;
    for (const r of rows) {
      const n = normalizeRow(r, 'history');
      if (!n) continue;
      if (n.gap_min === null) out.preFix++;
      out.rows.push(n);
    }
  }
  return out;
}

// The same move seen in history AND in the in-memory feed counts once. The key
// is the row's natural identity; detected_at is the client stamp movementFrom
// writes, so the stored row and the memory row carry the same instant.
export function mergeMovements(hist, mem) {
  const seen = new Map();
  const key = (r) => `${r.game_id}|${r.book}|${r.market}|${r.side}|${r.line_open}|${r.line_current}|${r.at}`;
  for (const r of hist || []) if (r) seen.set(key(r), r);
  for (const r of mem || []) if (r && !seen.has(key(r))) seen.set(key(r), r);
  return [...seen.values()];
}

// The interval a row's move must have happened in, in ms; null when the row
// cannot say (no gap, no stamp).
export function intervalOf(row) {
  if (!row || row.gap_min === null || row.gap_min === undefined) return null;
  const hi = typeof row.at === 'number' ? row.at : Date.parse(row.detected_at || '');
  if (!Number.isFinite(hi)) return null;
  return { lo: hi - row.gap_min * MIN_MS, hi };
}

// Interval stabbing per game_id|market|side|direction — direction is IN the
// key, never a post-hoc vote (D58). For each group, the maximal set of distinct
// books whose intervals share a point, one row per book. A non-empty
// intersection of closed intervals always contains the smallest `hi` among
// them, so every row's own `hi` is a sufficient set of candidate instants.
export function findSteamClusters(rows, { minBooks = 3 } = {}) {
  const groups = new Map();
  for (const r of steamSafeMovements(rows)) {
    const iv = intervalOf(r);
    if (!iv) continue;
    const k = `${r.game_id}|${r.market}|${r.side}|${r.direction}`;
    (groups.get(k) || groups.set(k, []).get(k)).push({ row: r, ...iv });
  }

  const out = [];
  for (const [k, list] of groups) {
    const [game_id, market, side, direction] = k.split('|');
    let best = null;
    for (const cand of list) {
      const p = cand.hi;
      // Freshest row per book at this instant.
      const perBook = new Map();
      for (const x of list) {
        if (x.lo <= p && p <= x.hi) {
          const cur = perBook.get(x.row.book);
          if (!cur || x.hi > cur.hi) perBook.set(x.row.book, x);
        }
      }
      if (!best || perBook.size > best.perBook.size || (perBook.size === best.perBook.size && p < best.p)) {
        best = { p, perBook };
      }
    }
    if (!best || best.perBook.size < minBooks) continue;
    const picked = [...best.perBook.values()];
    const lo = Math.max(...picked.map((x) => x.lo));
    const hi = Math.min(...picked.map((x) => x.hi));
    if (!(lo <= hi)) continue; // cannot happen for a stabbed set; stated because it IS the rule
    out.push({
      game_id, market, side, direction, sport: picked[0].row.sport,
      books: [...best.perBook.keys()].sort(),
      lo, hi, widthMin: Math.round(((hi - lo) / MIN_MS) * 10) / 10,
      rows: picked.map((x) => x.row),
    });
  }
  return out;
}
