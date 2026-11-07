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
// mutually exclusive summaries; the two a human must act on return a constant
// `blocked` reason and the orchestrator does the rest (D80) — no reportDegraded
// call of our own. A failed history read is reported as blind but does NOT
// discard the memory feed: a DB that times out must not publish less than a
// DB that is absent. Post-tip blindness — a started game whose rows are all
// wider than the per-row bound because the odds agent dropped its sport to
// MID/IDLE 45 min after the tip (D102) — gets its own segment for the same
// reason: it is the one blind state that otherwise renders as `0 steam`, the
// sentence a quiet market prints (D107, postTipBlindness below). Reverse-line-movement vs public money is emitted by the
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
// The two `blocked` reasons are CONSTANT literals. The orchestrator treats a
// changed reason as a new fault and resets the streak (D80), so a reason that
// carried run-varying counts (`N consecutive runs`, `N/N games`) would read
// `blockedRuns: 1` forever and churn reportDegraded every run. Counts live in
// the summary only.
const BLOCKED_HIST_READ = 'history read failed';
const BLOCKED_NO_GAP = 'no row carries gap_min';

let histFailRuns = 0;
// Re-emission guard: the same cluster is re-derived every run for the life of
// the window. Keyed on game_id|market|side|direction -> { game_id, sets }, the
// book sets already written for that market, so entries evict when the game
// leaves the slate (D75). A cluster re-emits only when its book set GAINS a
// member — a strictly stronger claim. The cluster's `hi` is deliberately not
// in the key: it moves whenever a member book ticks again inside the stab
// point, and keying on it inserted a second sharp_signals row naming the same
// three books on every half-point tick. A restart re-emits each live cluster
// once.
const emitted = new Map();

// Test seam.
export function __resetSharp() { histFailRuns = 0; emitted.clear(); }

async function run() {
  const now = Date.now();
  const slate = selectSlate(getGames(), now, HIST_MAX_GAMES);
  const slateIds = new Set(slate.map((g) => g.game_id));
  for (const [k, e] of emitted) if (!slateIds.has(e.game_id)) emitted.delete(k);
  if (!slate.length) { setIntel('sharp', []); return { summary: 'dormant — empty slate', data: counters() }; }

  const memRaw = getIntel('movements'); // the gap-filtered feed, most recent odds run
  const connected = db.isConnected();
  if (!connected && !memRaw.length) {
    setIntel('sharp', []);
    return { summary: 'blind — no DB and no in-memory feed', data: counters({ games: slate.length, source: 'memory' }) };
  }

  // ── History, behind the breaker ───────────────────────────────
  // When every read fails the memory feed still runs below: a DB that times
  // out must not publish LESS than a DB that is absent. History's blindness is
  // reported alongside, and past HIST_FAIL_RUNS it is `blocked` — the agent is
  // not doing its full job even while memory-only steam flows.
  let hist = { rows: [], queried: 0, failures: 0, truncated: 0, preFix: 0 };
  const probe = connected && histFailRuns >= HIST_FAIL_RUNS;
  let histBlind = false;
  if (connected) {
    hist = await readMovementHistory(probe ? slate.slice(0, HIST_PROBE_GAMES) : slate, { now });
    histBlind = hist.queried > 0 && hist.failures === hist.queried;
    histFailRuns = histBlind ? histFailRuns + 1 : 0;
  }
  const source = connected && !histBlind ? 'history+memory' : 'memory';

  // ── Union: history + memory, window-bounded, deduped ──────────
  const since = now - STEAM_LOOKBACK_MIN * 60_000;
  const mem = memRaw.map((m) => normalizeRow(m, 'memory'))
    .filter((m) => m && slateIds.has(m.game_id) && m.at >= since);
  const rows = mergeMovements(hist.rows, mem);
  const preFix = rows.filter((r) => r.gap_min === null).length;
  const eligible = steamSafeMovements(rows); // the per-row bound, over the UNION
  const postTip = postTipBlindness(rows, eligible, slate, now);
  const tail = (hist.failures && !histBlind ? `, ${hist.failures} read failure${hist.failures === 1 ? '' : 's'}` : '')
    + (hist.truncated ? `, ${hist.truncated} truncated` : '');
  // Say what was actually queried: on the run that closes the breaker only
  // HIST_PROBE_GAMES of the slate was read.
  const scope = probe ? `${hist.queried} of ${slate.length} games (probe)` : `${slate.length} games`;
  const base = {
    games: slate.length, queried: hist.queried, failures: hist.failures, truncated: hist.truncated,
    probe, rows: rows.length, eligible: eligible.length, preFix, source,
    postTipBeyondBound: postTip.rows, postTipBlindGames: postTip.games,
  };
  // Its own segment, never folded into the steam count: `0 steam` means the
  // market was quiet, and this means we could not have seen it move.
  const postTipBit = postTip.games
    ? ` · ${postTip.games} started game${postTip.games === 1 ? '' : 's'} beyond steam bound`
      + ` (${postTip.rows} row${postTip.rows === 1 ? '' : 's'}, post-tip tail)`
    : '';

  if (histBlind) {
    const d = await publish(rows, eligible, now);
    const streak = histFailRuns >= HIST_FAIL_RUNS;
    return {
      summary: `blind — history read failed for ${hist.failures}/${hist.queried} games`
        + (streak ? `, ${histFailRuns} consecutive runs` : '')
        + ` · memory-only: ${d.signals.length} steam · ${rows.length} rows / ${eligible.length} gap-eligible${tail}${postTipBit}`,
      blocked: streak ? BLOCKED_HIST_READ : undefined,
      data: counters({ ...base, ...d.counts, failRuns: histFailRuns }),
    };
  }
  if (rows.length && preFix === rows.length) {
    setIntel('sharp', []);
    return {
      summary: `blind — ${rows.length} rows in the last ${STEAM_LOOKBACK_MIN}m, none carry gap_min (writer is stripping it — see odds log)${tail}${postTipBit}`,
      blocked: BLOCKED_NO_GAP, data: counters(base),
    };
  }
  if (!rows.length) {
    setIntel('sharp', []);
    return {
      summary: `0 steam · 0 movement rows in the last ${STEAM_LOOKBACK_MIN}m across ${scope} · ${source}${tail}${postTipBit}`,
      data: counters(base),
    };
  }

  // ── Simultaneity ──────────────────────────────────────────────
  const d = await publish(rows, eligible, now);
  if (!d.clusters.length) {
    return {
      summary: `0 steam · ${rows.length} rows / ${eligible.length} gap-eligible / 0 simultaneous clusters · ${scope} · ${source}${tail}${postTipBit}`,
      data: counters({ ...base, ...d.counts }),
    };
  }
  return {
    summary: `${d.signals.length} steam · ${rows.length} rows / ${eligible.length} gap-eligible / ${d.counts.markets} markets · ${scope} · ${source} · window ${STEAM_LOOKBACK_MIN}m${tail}${postTipBit}`,
    data: counters({ ...base, ...d.counts }),
  };
}

// ── Post-tip blindness: a designed blind spot, reported as one (D107) ──
// Since D102 the odds agent keeps a sport on the fast cadence for only 45
// minutes after a tip unless something is reading its in-play rows. Past that
// a started game sits at MID or IDLE × the governor, so every movement row it
// produces carries a gap of 45-720 minutes — all beyond STEAM_MAX_GAP_MIN, all
// rejected by steamSafeMovements. Three books moving the same market the same
// way post-tip therefore printed `0 steam · 3 rows / 0 gap-eligible`, which is
// the sentence a QUIET market prints. The rows are not the problem and the
// bound is not wrong — a 45-minute gap genuinely cannot prove simultaneity —
// but "the market did not move" and "I cannot see this market move any more"
// must not render alike.
//
// So: for each STARTED slate game, rows contributed, rows the bound rejected
// for being too WIDE, and whether the game ended up with nothing eligible at
// all. A game counts as blind only when at least one of its rows was rejected
// for width: a started game whose rows all carry a null gap is the writer
// fault the no-gap blind state already owns (D73/D93), and two claims about
// one row is one too many.
//
// "Started" is derived from commence_time < now rather than read from the odds
// slot's `data.postTipTail`: the slate is already in hand (no cross-agent read,
// no coupling to another agent's run shape), and a sport-level list cannot say
// which GAME's rows aged out of the bound.
function postTipBlindness(rows, eligible, slate, now) {
  const started = new Set();
  for (const g of slate) {
    const t = g && g.commence_time ? Date.parse(g.commence_time) : NaN;
    if (Number.isFinite(t) && t < now) started.add(g.game_id);
  }
  // steamSafeMovements filters, so an eligible row is the same object.
  const ok = new Set(eligible);
  const per = new Map();
  for (const r of rows) {
    if (!started.has(r.game_id)) continue;
    const e = per.get(r.game_id) || { rows: 0, eligible: 0, beyond: 0 };
    e.rows++;
    if (ok.has(r)) e.eligible++;
    else if (r.gap_min !== null) e.beyond++;   // rejected for WIDTH, not absence
    per.set(r.game_id, e);
  }
  let games = 0;
  let beyond = 0;
  for (const e of per.values()) {
    if (e.eligible || !e.beyond) continue;
    games++;
    beyond += e.beyond;
  }
  return { games, rows: beyond };
}

// Clusters -> signals -> the emitted-set filter -> insert -> setIntel. One
// path for the history+memory union and for the memory-only run under a
// failed history read, so neither can publish differently from the other.
async function publish(rows, eligible, now) {
  const clusters = findSteamClusters(rows, { minBooks: STEAM_MIN_BOOKS });
  const markets = new Set(eligible.map((r) => `${r.game_id}|${r.market}|${r.side}`)).size;
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
    const key = `${c.game_id}|${c.market}|${c.side}|${c.direction}`;
    const entry = emitted.get(key) || { game_id: c.game_id, sets: [] };
    // Already written with these books (or a superset of them): not a new claim.
    if (entry.sets.some((s) => c.books.every((b) => s.has(b)))) continue;
    entry.sets.push(new Set(c.books));
    emitted.set(key, entry);
    fresh.push(sig);
  }

  if (fresh.length) {
    try { await db.insert('sharp_signals', fresh.map((s) => ({ ...s, books: s.books }))); }
    catch (e) { logger.warn('sharp', e.message); }
  }
  setIntel('sharp', signals);
  return { clusters, signals, counts: { markets, signals: signals.length, clusters: clusters.length, inserted: fresh.length } };
}

// Every counter in every state, zeros included (the baselineBit precedent):
// a missing key and a zero must not be confused on /health.
function counters(o = {}) {
  return {
    signals: 0, clusters: 0, inserted: 0, rows: 0, eligible: 0, preFix: 0, markets: 0,
    games: 0, queried: 0, failures: 0, truncated: 0, probe: false, failRuns: histFailRuns,
    // Rows on started games the per-row bound rejected for width, and the
    // started games left with nothing eligible because of it (D107).
    postTipBeyondBound: 0, postTipBlindGames: 0,
    windowMin: STEAM_LOOKBACK_MIN, source: o.source || null, ...o,
  };
}

export default { name: 'sharp', run };
