// ══════════════════════════════════════════════════════════════
// /splits — public bets% / handle% joined to open → current lines, per game.
//
// The join lives HERE, in the route, not in the PWA: percentages from the
// public-splits agent's store slot, consensus openers from the nfl-line-move
// slot (which already reads opening_lines for every slate game each run —
// no per-request read of that table, the /games `in:` read is a precedent to
// stop, not copy), and the current consensus from computeMarkets. All three
// are in memory and free.
//
// Durability: after a restart getIntel('splits') is [] until the next 4-hour
// run while the last batch sits in Postgres. Memory wins whenever it has rows;
// otherwise ONE bounded select (newest SPLITS_DB_LIMIT rows by fetched_at desc,
// riding public_splits_fetched_idx) behind a SPLITS_DB_TTL_MS in-process
// cache — the route is polled every 30 s and a failed read is cached for the
// same TTL so a timing-out table is not hammered 120×/hour. `splits_meta.source`
// says which path produced the rows.
//
// Percentages are MARKET-WIDE (public_splits has no book column — D53/D22):
// a `splits[]` row carries no `book` field, by design. `books[]` gains a
// stable `key` (the Odds API key) so the PWA can join per-book lines to the
// book-move slot by key; `book` stays the display label.
//
// A null stays null (D96/D97). No Number() on a possibly-absent value: a DB
// numeric comes back as a string and is type-checked before coercion; a
// missing opener or percentage is published as null, never 0.
// ══════════════════════════════════════════════════════════════
import db from '../db/index.js';
import { logger } from '../utils/index.js';
import { getGames, getIntel, getNflLineMove } from '../store/index.js';
import { computeMarkets } from './lines.js';
import { resolveSide } from '../agents/public-splits/index.js';

export const SPLITS_DB_LIMIT = 300;          // ~5 batches of ≤ 60 rows
export const SPLITS_DB_TTL_MS = 10 * 60_000; // one DB read per 10 min, success or failure
const SPLITS_COLS = 'game_id,sport,market,side,bets_pct,handle_pct,divergence,rlm,freeze,pileon,net_move,fetched_at';

let dbCache = { at: 0, rows: [], error: false };
export function __resetSplitsCache() { dbCache = { at: 0, rows: [], error: false }; }

// A number, or a non-blank numeric string (Postgres numerics arrive as
// strings), else null. Never Number(null) — that is a finite 0 (house rule).
const fin = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const nul = (v) => (v == null ? null : v);

// Newest batch per game: keep each game's rows at its max fetched_at only.
function newestPerGame(rows) {
  const newest = new Map();
  for (const r of rows) {
    if (!r || !r.game_id || !r.fetched_at) continue;
    const prev = newest.get(r.game_id);
    if (!prev || r.fetched_at > prev) newest.set(r.game_id, r.fetched_at);
  }
  return rows.filter((r) => r && r.game_id && newest.get(r.game_id) === r.fetched_at);
}

// Memory if the agent has run in this process; else the cached/refreshed DB
// read. Exactly one db.select in this file.
async function splitsRows(dbi, now) {
  const mem = getIntel('splits');
  if (mem.length) return { rows: mem, source: 'memory', db_error: false };
  if (!dbi.isConnected()) return { rows: [], source: null, db_error: false };
  if (now - dbCache.at >= SPLITS_DB_TTL_MS) {
    try {
      const rows = await dbi.select('public_splits', SPLITS_COLS, {
        order: { column: 'fetched_at', ascending: false }, limit: SPLITS_DB_LIMIT,
      });
      dbCache = { at: now, rows: newestPerGame(rows), error: false };
    } catch (e) {
      logger.warn('splits', `public_splits read failed: ${e.message}`);
      dbCache = { at: now, rows: [], error: true };
    }
  }
  return { rows: dbCache.rows, source: dbCache.error ? null : 'db', db_error: dbCache.error };
}

export async function buildSplits(url, deps = {}) {
  const dbi = deps.db || db;
  const now = deps.now != null ? deps.now : Date.now();
  const want = String(url.searchParams.get('sport') || '').toUpperCase();
  const all = getGames();
  const games = all.filter((g) => !want || g.sport === want);
  const onSlate = new Set(all.map((g) => g.game_id));
  const src = await splitsRows(dbi, now);
  const openers = (getNflLineMove() || {}).openers || {};

  let at = null, offslate = 0;
  const byGame = new Map();
  for (const s of src.rows) {
    if (!s || !s.game_id) continue;
    if (s.fetched_at && (!at || s.fetched_at > at)) at = s.fetched_at;
    if (!onSlate.has(s.game_id)) { offslate++; continue; }
    (byGame.get(s.game_id) || byGame.set(s.game_id, []).get(s.game_id)).push(s);
  }

  const out = games.map((g) => {
    const gs = (byGame.get(g.game_id) || []).map((s) => ({
      market: s.market, side: nul(s.side), public_side: resolveSide(g, s.market, s.side),
      bets_pct: fin(s.bets_pct), handle_pct: fin(s.handle_pct), divergence: fin(s.divergence),
      rlm: nul(s.rlm), freeze: nul(s.freeze), pileon: nul(s.pileon), net_move: fin(s.net_move),
      fetched_at: nul(s.fetched_at),
    }));
    const m = computeMarkets(g);
    const current = { total: nul(m.total.consensus), spread: nul(m.spread.consensusHome), ml: nul(m.ml.consensusHome) };
    const o = openers[g.game_id];
    const open = o ? { total: nul(o.total), spread: nul(o.spread), ml: nul(o.ml) } : null;
    const books = [];
    for (const [bk, b] of Object.entries(g.books || {})) {
      const mk = b.markets || {};
      const mh = mk[`h2h:${g.home}`], ma = mk[`h2h:${g.away}`];
      const sh = mk[`spreads:${g.home}`], ov = mk['totals:Over'], un = mk['totals:Under'];
      books.push({
        key: bk, book: b.label || bk, updated: b.updated || null,
        ml_home: mh?.price ?? null, ml_away: ma?.price ?? null,
        spread_line: sh?.line ?? null, spread_price: sh?.price ?? null,
        total_line: ov?.line ?? null, over_price: ov?.price ?? null, under_price: un?.price ?? null,
      });
    }
    books.sort((a, b) => a.book.localeCompare(b.book));
    return {
      game_id: g.game_id, sport: g.sport, matchup: `${g.away} @ ${g.home}`, home: g.home, away: g.away,
      commence_time: g.commence_time, live: !!(g.commence_time && Date.parse(g.commence_time) <= now),
      open, current, splits: gs, books,
    };
  }).filter((g) => g.books.length);
  out.sort((a, b) => new Date(a.commence_time || 0) - new Date(b.commence_time || 0));
  return {
    count: out.length, games: out,
    splits_meta: { source: src.source, at, rows: src.rows.length, offslate, db_error: src.db_error },
  };
}

export default { buildSplits };
