// ══════════════════════════════════════════════════════════════
// Sharp Money Detection — steam, read out of bounded movement history.
//
// STEAM means three or more books moved the same market the same way AT THE
// SAME TIME. Each movement row carries the interval its move must have
// happened in ([detected_at − gap_min, detected_at]); steam is a set of >= 3
// distinct books whose intervals share a point (history.js). A per-row gap
// filter alone cannot say that — it proves each row's OWN baseline was recent,
// not that the books moved together — which is why the interval test exists.
//
// Source: `line_movements` is primary (it survives restarts and spans odds-run
// boundaries), read one bounded select per slate game; the gap-filtered
// in-memory feed `getIntel('movements')` is merged over it (deduped) because it
// covers the window between detection and the insert landing, and is the only
// source with no DB. Never `movementsAll` — that feed belongs to public-splits
// (D74). The per-row bound is applied to the UNION, so the reader is safe
// against any producer. Zero Odds API spend: Postgres only.
//
// Reporting: "nothing moved" must never look like "I cannot see". Seven
// mutually exclusive summaries; the two a human must act on return
// `blocked: true` and the orchestrator does the rest (D80) — no reportDegraded
// call of our own. Reverse-line-movement vs public money is emitted by the
// Public Splits agent, which has the bets%/handle% it needs.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, getIntel, setIntel } from '../../store/index.js';
import { steamSafeMovements } from '../odds/index.js';
import {
  HIST_MAX_GAMES, STEAM_LOOKBACK_MIN, selectSlate, readMovementHistory,
  normalizeRow, mergeMovements, findSteamClusters,
} from './history.js';

const STEAM_MIN_BOOKS = 3;
// A single statement timeout is transient; three all-failed runs (~15 min at
// the 5-min cadence) is a table in distress (D76's number). Past that the
// reader probes one game per run until a read succeeds, so a distressed table
// sees 1 select / 5 min from sharp, not 24.
const HIST_FAIL_RUNS = 3;
const HIST_PROBE_GAMES = 1;

let histFailRuns = 0;
// Re-emission guard: the same cluster is re-derived every run for the life of
// the window. Key -> game_id, so entries evict when the game leaves the slate
// (D75). A cluster that gains a book changes key and re-emits — a strictly
// stronger claim. A restart re-emits each live cluster once.
const emitted = new Map();

// Test seam.
export function __resetSharp() { histFailRuns = 0; emitted.clear(); }

async function run() {
  const now = Date.now();
  const slate = selectSlate(getGames(), now, HIST_MAX_GAMES);
  const slateIds = new Set(slate.map((g) => g.game_id));
  for (const [k, gid] of emitted) if (!slateIds.has(gid)) emitted.delete(k);
  if (!slate.length) { setIntel('sharp', []); return { summary: 'dormant — empty slate', data: counters() }; }

  const memRaw = getIntel('movements'); // the gap-filtered feed, most recent odds run
  const connected = db.isConnected();
  if (!connected && !memRaw.length) {
    setIntel('sharp', []);
    return { summary: 'blind — no DB and no in-memory feed', data: counters({ games: slate.length, source: 'memory' }) };
  }
  const source = connected ? 'history+memory' : 'memory';

  // ── History, behind the breaker ───────────────────────────────
  let hist = { rows: [], queried: 0, failures: 0, truncated: 0, preFix: 0 };
  if (connected) {
    const broken = histFailRuns >= HIST_FAIL_RUNS;
    hist = await readMovementHistory(broken ? slate.slice(0, HIST_PROBE_GAMES) : slate, { now });
    if (hist.queried > 0 && hist.failures === hist.queried) {
      histFailRuns++;
      setIntel('sharp', []);
      const streak = histFailRuns >= HIST_FAIL_RUNS;
      return {
        summary: `blind — history read failed for ${hist.failures}/${hist.queried} games`
          + (streak ? `, ${histFailRuns} consecutive runs` : ''),
        blocked: streak || undefined,
        data: counters({ games: slate.length, queried: hist.queried, failures: hist.failures, failRuns: histFailRuns, source }),
      };
    }
    histFailRuns = 0;
  }

  // ── Union: history + memory, window-bounded, deduped ──────────
  const since = now - STEAM_LOOKBACK_MIN * 60_000;
  const mem = memRaw.map((m) => normalizeRow(m, 'memory'))
    .filter((m) => m && slateIds.has(m.game_id) && m.at >= since);
  const rows = mergeMovements(hist.rows, mem);
  const preFix = rows.filter((r) => r.gap_min === null).length;
  const eligible = steamSafeMovements(rows); // the per-row bound, over the UNION
  const tail = (hist.failures ? `, ${hist.failures} read failure${hist.failures === 1 ? '' : 's'}` : '')
    + (hist.truncated ? `, ${hist.truncated} truncated` : '');
  const base = {
    games: slate.length, queried: hist.queried, failures: hist.failures, truncated: hist.truncated,
    rows: rows.length, eligible: eligible.length, preFix, source,
  };

  if (rows.length && preFix === rows.length) {
    setIntel('sharp', []);
    return {
      summary: `blind — ${rows.length} rows in the last ${STEAM_LOOKBACK_MIN}m, none carry gap_min (writer is stripping it — see odds log)${tail}`,
      blocked: true, data: counters(base),
    };
  }
  if (!rows.length) {
    setIntel('sharp', []);
    return {
      summary: `0 steam · 0 movement rows in the last ${STEAM_LOOKBACK_MIN}m across ${slate.length} games · ${source}${tail}`,
      data: counters(base),
    };
  }

  // ── Simultaneity ──────────────────────────────────────────────
  const clusters = findSteamClusters(rows, { minBooks: STEAM_MIN_BOOKS });
  const markets = new Set(eligible.map((r) => `${r.game_id}|${r.market}|${r.side}`)).size;
  if (!clusters.length) {
    setIntel('sharp', []);
    return {
      summary: `0 steam · ${rows.length} rows / ${eligible.length} gap-eligible / 0 simultaneous clusters · ${slate.length} games · ${source}${tail}`,
      data: counters({ ...base, markets }),
    };
  }

  const detectedAt = new Date(now).toISOString();
  const signals = [];
  const fresh = [];
  for (const c of clusters) {
    const avgMove = c.rows.reduce((s, m) => s + Math.abs(m.moved || 0), 0) / c.rows.length;
    // For totals, a coordinated DOWN move is sharp Under money (our bias side).
    let sharpSide = c.side;
    if (c.market === 'totals') sharpSide = c.direction === 'down' ? 'Under' : 'Over';
    const strength = Math.min(100, c.books.length * 20 + Math.round(avgMove * 10));
    const srcs = new Set(c.rows.map((r) => r.src));
    const prov = srcs.size === 1 ? [...srcs][0] : 'history+memory';
    const sig = {
      sport: c.sport, game_id: c.game_id, market: c.market, side: sharpSide,
      signal_type: 'steam', strength, books: c.books,
      detail: `${c.books.length} books moved ${c.market} ${c.side} ${c.direction} (avg ${avgMove.toFixed(1)}) within ${c.widthMin}m · ${prov}`,
      detected_at: detectedAt,
    };
    signals.push(sig);
    const key = `${c.game_id}|${c.market}|${c.side}|${c.direction}|${c.books.join(',')}|${c.hi}`;
    if (!emitted.has(key)) { emitted.set(key, c.game_id); fresh.push(sig); }
  }

  if (fresh.length) {
    try { await db.insert('sharp_signals', fresh.map((s) => ({ ...s, books: s.books }))); }
    catch (e) { logger.warn('sharp', e.message); }
  }
  setIntel('sharp', signals);
  return {
    summary: `${signals.length} steam · ${rows.length} rows / ${eligible.length} gap-eligible / ${markets} markets · ${slate.length} games · ${source} · window ${STEAM_LOOKBACK_MIN}m${tail}`,
    data: counters({ ...base, markets, signals: signals.length, clusters: clusters.length, inserted: fresh.length }),
  };
}

// Every counter in every state, zeros included (the baselineBit precedent):
// a missing key and a zero must not be confused on /health.
function counters(o = {}) {
  return {
    signals: 0, clusters: 0, inserted: 0, rows: 0, eligible: 0, preFix: 0, markets: 0,
    games: 0, queried: 0, failures: 0, truncated: 0, failRuns: histFailRuns,
    windowMin: STEAM_LOOKBACK_MIN, source: o.source || null, ...o,
  };
}

export default { name: 'sharp', run };
