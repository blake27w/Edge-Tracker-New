// ══════════════════════════════════════════════════════════════
// NFL Opener→Close Line Tracker. Reuses the openers we already capture
// (opening_lines) and the live consensus to measure how each NFL game's
// total + spread moved from open to close — the market-direction signal
// (which way sharp money pushed the number). Upcoming games show the live
// open→current move; once a game reaches kickoff its open→close move is
// persisted, and recent history is aggregated (how often NFL totals close
// lower, average move, etc.). Self-gates to NFL games, so it is DORMANT
// in the offseason ($0). Reference/observational — not a play by itself.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setNflLineMove } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';

const CLOSE_LEAD_MS = 30 * 60_000; // a game ≤30m from kickoff is treated as closed
const persisted = new Set();       // game_id already saved as a close

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

async function run() {
  if (!db.isConnected()) { setNflLineMove(null); return { summary: 'skipped — no DB' }; }
  const games = getGames().filter((g) => g.sport === 'NFL');
  if (!games.length) { setNflLineMove(null); return { summary: 'dormant — no NFL games on the slate' }; }

  // Openers for these games.
  const ids = games.map((g) => g.game_id);
  let opens = [];
  try { opens = await db.select('opening_lines', 'game_id,market,line', { in: { game_id: ids } }); } catch (_) { /* none */ }
  const openMap = new Map();
  for (const o of opens) openMap.set(`${o.game_id}|${o.market}`, Number(o.line));

  const now = Date.now();
  const live = [], toClose = [];
  for (const g of games) {
    const m = computeMarkets(g);
    const curTotal = g.consensusTotal ?? m.total.consensus;
    const curSpread = m.spread.consensusHome;
    const openTotal = openMap.get(`${g.game_id}|total`);
    const openSpread = openMap.get(`${g.game_id}|spread`);
    const row = {
      game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, commence_time: g.commence_time,
      open_total: r1(openTotal), close_total: r1(curTotal), total_move: (openTotal != null && curTotal != null) ? r1(curTotal - openTotal) : null,
      open_spread: r1(openSpread), close_spread: r1(curSpread), spread_move: (openSpread != null && curSpread != null) ? r1(curSpread - openSpread) : null,
    };
    const started = g.commence_time && new Date(g.commence_time).getTime() <= now + CLOSE_LEAD_MS;
    if (started) toClose.push(row); else live.push(row);
  }

  // Persist open→close once per game (dedup in-memory + against today's rows).
  let logged = new Set();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ex = await db.select('nfl_line_moves', 'game_id', { gte: { captured_at: today + 'T00:00:00Z' } });
    logged = new Set(ex.map((r) => r.game_id));
  } catch (_) { /* table optional */ }
  const fresh = toClose.filter((r) => !persisted.has(r.game_id) && !logged.has(r.game_id) && (r.total_move != null || r.spread_move != null));
  if (fresh.length) {
    fresh.forEach((r) => persisted.add(r.game_id));
    const nowIso = new Date().toISOString();
    try { await db.insert('nfl_line_moves', fresh.map((r) => ({ game_id: r.game_id, matchup: r.matchup, open_total: r.open_total, close_total: r.close_total, total_move: r.total_move, open_spread: r.open_spread, close_spread: r.close_spread, spread_move: r.spread_move, captured_at: nowIso }))); }
    catch (e) { logger.warn('nfl-line-move', e.message); }
  }

  // Aggregate recent closed history (market direction tendencies).
  let hist = [];
  try { hist = await db.select('nfl_line_moves', 'total_move,spread_move', { order: { column: 'captured_at', ascending: false }, limit: 600 }); } catch (_) { /* none */ }
  const tm = hist.map((h) => Number(h.total_move)).filter(Number.isFinite);
  const sm = hist.map((h) => Number(h.spread_move)).filter(Number.isFinite);
  const agg = {
    n: hist.length,
    total_down_pct: tm.length ? Math.round((tm.filter((x) => x < 0).length / tm.length) * 1000) / 10 : null,
    total_avg_abs: tm.length ? r1(tm.reduce((s, x) => s + Math.abs(x), 0) / tm.length) : null,
    spread_avg_abs: sm.length ? r1(sm.reduce((s, x) => s + Math.abs(x), 0) / sm.length) : null,
  };

  live.sort((a, b) => new Date(a.commence_time || 0) - new Date(b.commence_time || 0));
  setNflLineMove({ updated: new Date().toISOString(), live: live.slice(0, 32), agg });
  return { summary: `${live.length} NFL games tracked (${fresh.length} new closes) · ${agg.n} in history`, data: { live: live.length, closed: fresh.length, history: agg.n } };
}

export default { name: 'nfl-line-move', run };
