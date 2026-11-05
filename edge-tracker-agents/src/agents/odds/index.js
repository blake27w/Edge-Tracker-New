// ══════════════════════════════════════════════════════════════
// Odds Ingestion — pulls odds from The Odds API for every in-season
// sport, normalizes them, snapshots to line_snapshots, detects line
// movements, and publishes games to the pipeline store.
//
// Budgeting: the free tier is 500 requests/month. We persist a
// running counter in `api_usage`, allocate the monthly budget by
// sport (MLB 40%, NBA/NHL 20% each, the rest split 20%), and skip
// sports that are out of season or have no games today.
//
// Movement baselines are REHYDRATED, not persisted. `lastLines` is
// process-local, so before this every redeploy wiped it and the next
// fetch of each key detected nothing (D71). The baseline is instead
// refilled lazily from our own `line_snapshots` — rows this agent
// already wrote from odds we had already paid for — so hydration costs
// ZERO Odds API credits by construction: there is no `fetch(` anywhere
// in that path, only bounded `db.select` reads keyed on
// (game_id, market, fetched_at desc).
//
// A rehydrated baseline carries an unknown gap, and a line compared
// across three days conflates an unknown number of moves into one row
// whose `moved` and `direction` are fiction. So every baseline entry
// carries `at`, and a movement is emitted only when the gap is within
// ODDS_MOVE_MAX_GAP_MIN (default 360). Past the bound the entry is
// reseeded and `staleBaseline` counts it (D72).
//
// TWO in-memory feeds are published, because the two consumers ask different
// questions of the same rows (D74):
//   getIntel('movements')    — gap-filtered to STEAM_MAX_GAP_MIN. Read by
//     `sharp`, which treats 3+ co-directional rows in it as a SIMULTANEITY
//     claim (steam), so a rehydrated six-hour drift must never land here.
//   getIntel('movementsAll') — every row this run detected, unfiltered. Read by
//     `public-splits`, which asks only "did the public's own number move" and
//     answers with `moves.total.get(id) ?? 0` — so a WITHHELD row is
//     indistinguishable there from a line that did not move, and a genuine
//     reverse line move gets published as a freeze.
// `line_movements` is the complete record and keeps every row, as before. Every
// row in BOTH feeds carries `gap_min`, so rows stay self-identifying wherever
// they land.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setGames, setIntel, clearDegraded } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';

const { oddsApi, SPORTS, BOOKS, BOOK_LABELS } = config;

// ── Budget state (mirrors the api_usage row, persisted each run) ──
const budget = {
  month: monthKey(),
  used: 0,
  bySport: {},      // sport -> requests used this month
  remaining: oddsApi.monthlyBudget,
  loaded: false,
};

function monthKey() { return new Date().toISOString().slice(0, 7); }

export function getOddsBudget() {
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const used = budget.used || 0;
  const cap = oddsApi.monthlyBudget || 0;
  // Straight-line pace projection for the full month.
  const projectedMonthly = dayOfMonth > 0 ? Math.round((used / dayOfMonth) * daysInMonth) : used;
  return {
    tier: oddsApi.tier,
    month: budget.month,
    budget: cap,
    used,
    remaining: budget.remaining,
    bySport: budget.bySport,
    dayOfMonth,
    daysInMonth,
    perDay: dayOfMonth > 0 ? Math.round((used / dayOfMonth) * 10) / 10 : 0,
    projectedMonthly,
    pctUsed: cap ? Math.round((used / cap) * 1000) / 10 : 0,
    // Burn-rate vs the month's progress: paceRatio > 1 = spending faster than
    // linear (creep). monthPct = how much of the month has elapsed.
    monthPct: daysInMonth > 0 ? Math.round((dayOfMonth / daysInMonth) * 1000) / 10 : 0,
    paceRatio: (cap && dayOfMonth > 0) ? Math.round(((used / cap) / (dayOfMonth / daysInMonth)) * 100) / 100 : null,
    // Reserve below which discretionary scanners (props/tennis/derivatives) pause.
    reserve: config.rules.oddsReserve,
    discretionaryActive: budget.remaining > config.rules.oddsReserve,
  };
}

// The per-sport ceiling table, for the dashboard. getOddsBudget() publishes
// what each sport has SPENT but not what it is allowed to spend, and
// currentCeiling() is module-private — so the one number that explains a
// budget-skip was unreachable from any client.
//
// `denom` is deliberately passed through raw: `null` means nothing has
// published a denominator yet, which is NOT the same claim as "every sport"
// (D65). The consumer renders the difference.
export function getOddsCeilings() {
  const sports = Object.keys(oddsApi.allocation);
  const ceilings = {};
  for (const s of sports) ceilings[s] = currentCeiling(s);
  return { pool: POOL, denom: lastDenom, allocation: { ...oddsApi.allocation }, ceilings };
}

// Budget guard for discretionary Odds-API consumers (props, tennis,
// derivatives). Returns false when fewer than `reserve` monthly credits remain
// so core odds ingestion is protected. `budget.remaining` is reconciled from the
// API's x-requests-remaining header each odds run, so it reflects ALL account
// usage (lagged at most one odds cycle). Allows freely until the budget loads.
export function hasOddsBudget(reserve = 0, sport = null) {
  if (!budget.loaded) return true;
  if (budget.remaining <= reserve) return false;
  // Per-sport ceiling, same counter AND the same ceiling the main loop bills
  // against — so a sport's discretionary and core spend share one budget
  // instead of two, and one bound instead of two.
  if (sport && (budget.bySport[sport] || 0) >= currentCeiling(sport)) return false;
  return true;
}

// Attribute a discretionary consumer's spend. These agents call the Odds API
// with their own fetch, outside the ingestion loop, and used to record nothing:
// in Oct 2026 that left ~1107 credits (9% of the month) governed by no per-sport
// cap and counted against no sport — `used` read 12642 while `bySport` summed to
// 11535. Pass the fetch Response; the API reports the real cost in its headers.
export function recordOddsSpend(sport, res) {
  const h = res && res.headers;
  recordSpend(sport, h ? {
    remaining: h.get('x-requests-remaining'),
    used: h.get('x-requests-used'),
    last: h.get('x-requests-last'),
  } : null);
}

function sportCap(sport) {
  const alloc = oddsApi.allocation[sport] ?? 0.05;
  return Math.floor(oddsApi.monthlyBudget * alloc);
}

// Share of the month allocatable to per-sport ceilings. The remaining 15% is
// deliberate margin — NOT a second pool. It used to be the event-endpoint
// consumers' allocation, but #131 made them bill into bySport and respect the
// sport's ceiling, so there is one budget per sport now and this is simply the
// headroom that keeps the month from ending early.
const POOL = 0.85;

// THE per-sport ceiling formula. One definition, both callers: the core loop in
// run() and hasOddsBudget() for discretionary consumers.
//
// They disagreed before this. The core loop bounded a sport at
// POOL x budget x share/sumAlloc while hasOddsBudget used sportCap() —
// budget x share, with neither the pool fraction nor the normalisation.
//
// Which one was looser depended on the active set, and that is the point:
// they cross over at sumAlloc = POOL. Above it the core ceiling is tighter
// (3.5% on October's billed set at 0.88, 17.7% with every sport in at 1.00),
// so discretionary spend could carry a sport past the ceiling the core loop
// had already stopped at — both bill the same bySport counter. Below it the
// core loop is the looser of the two instead. Either way one consumer was
// bounded by a number the other did not respect, and with every sport in the
// denominator sportCap sums to 20000 — the entire month, with no pool
// fraction and no reserve. One formula removes the incoherence in both
// directions.
export function nominalCap(sport, denomSports) {
  const sumAlloc = denomSports.reduce((t, s) => t + (oddsApi.allocation[s] ?? 0.05), 0) || 1;
  return Math.floor(oddsApi.monthlyBudget * POOL * ((oddsApi.allocation[sport] ?? 0.05) / sumAlloc));
}

// The denominator the core loop last computed. It needs the in-season set,
// which is an async fetch, so it cannot be recomputed inside the synchronous
// hasOddsBudget — the core loop publishes it here instead (every 3 min).
//
// This is NOT a correctness dependency on the odds agent running first: when
// nothing has been published, currentCeiling() falls back to the full
// allocation table, which is the tightest reading available. Odds happens to
// be index 0 in the cold-start stagger and so publishes ~21s before the first
// discretionary run, but reordering the agent registry cannot silently revert
// the fix — only make the first few ceilings slightly conservative.
let lastDenom = null;

export function currentCeiling(sport) {
  // Which denominator to price against, in order of preference:
  //
  //  1. what the core loop last used — the number it is itself billing against;
  //  2. that set plus this sport, when the sport is not in it. `isActive()`
  //     returns false for every `oddsSkip` sport, so TENNIS and GOLF can only
  //     enter via `billed`, i.e. after they have already spent this month. On
  //     the first tennis call of a month `lastDenom` therefore excludes it —
  //     and three of the five discretionary consumers are tennis. Adding the
  //     sport normalises it properly instead;
  //  3. the whole allocation table, when nothing has been published yet. That
  //     maximises sumAlloc and so minimises the ceiling, which is the right
  //     way to be wrong before we know what is in season.
  //
  // What this must NOT do is fall back to `sportCap()` — the unnormalised
  // `budget x share` that #134 exists to remove from this path. Nor to
  // `[sport]` alone: a single-element denominator makes sumAlloc that sport's
  // own share, so TENNIS would be priced at the ENTIRE 17000 pool instead of
  // ~510. The degenerate case is 28x looser than the bug.
  let denom;
  if (lastDenom && lastDenom.length) {
    denom = lastDenom.includes(sport) ? lastDenom : [...lastDenom, sport];
  } else {
    denom = Object.keys(oddsApi.allocation);
    if (!denom.includes(sport)) denom = [...denom, sport];
  }
  // Never below what the sport has already spent, matching the core loop: an
  // arrival mid-month stops granting headroom rather than retroactively
  // stranding a sport that is already past the new nominal.
  return Math.max(budget.bySport[sport] || 0, nominalCap(sport, denom));
}

async function loadBudget() {
  const m = monthKey();
  if (budget.loaded && budget.month === m) return;
  budget.month = m;
  budget.used = 0;
  budget.bySport = {};
  try {
    const rows = await db.select('api_usage', '*', { match: { provider: 'odds', month: m } });
    if (rows[0]) {
      budget.used = rows[0].used || 0;
      budget.bySport = rows[0].by_sport || {};
    }
  } catch (e) { /* DB optional */ }
  budget.remaining = Math.max(0, oddsApi.monthlyBudget - budget.used);
  budget.loaded = true;
}

async function persistBudget() {
  try {
    await db.upsert('api_usage', {
      provider: 'odds', month: budget.month, used: budget.used,
      budget: oddsApi.monthlyBudget, by_sport: budget.bySport,
      updated_at: new Date().toISOString(),
    }, 'provider,month');
  } catch (e) { /* ignore */ }
}

// Each call costs CREDITS = markets × regions (3 here: h2h,spreads,totals × us),
// not 1 — the old count-by-request made the budget look 3× healthier than it was
// and let the per-sport caps never bind. Prefer the API's own per-call cost
// header, and reconcile totals with its account-wide counters so spend by the
// OTHER consumers (props, tennis, derivatives) is captured too.
// `Headers.get()` returns null for an absent header, and `+null` is 0 — which
// IS finite. So `Number.isFinite(+hdr.remaining)` accepted a MISSING header as
// "0 credits remaining", which stops every discretionary consumer
// (hasOddsBudget) and makes the core loop report "budget exhausted" on its next
// run. A single header-less response — any non-200, since no caller checks
// res.ok before recording, or anything that strips headers — shut the whole
// system down until the next good response happened to restore it.
//
// Same trap as the clv-tracker price consensus (D10): Number(null) === 0 and 0
// passes Number.isFinite, so a missing value has to be rejected explicitly
// rather than coerced.
const hdrNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function recordSpend(sport, hdr) {
  const last = hdr ? hdrNum(hdr.last) : null;
  const cost = last != null ? Math.max(1, Math.round(last)) : 3;
  budget.used += cost;
  budget.bySport[sport] = (budget.bySport[sport] || 0) + cost;
  const used = hdr ? hdrNum(hdr.used) : null;
  if (used != null) budget.used = Math.max(budget.used, Math.round(used));
  const remaining = hdr ? hdrNum(hdr.remaining) : null;
  if (remaining != null) budget.remaining = remaining;
  else budget.remaining = Math.max(0, oddsApi.monthlyBudget - budget.used);
}

// ── Adaptive pacing: fetch fast only when it matters ─────────────
// A key's cadence is set by how close its sport's games are:
//   STRIKE (live or starts within 30m) → every 4 min  — PROTECTED
//   NEAR   (starts within 90m)         → every 10 min — PROTECTED
//   MID    (starts within 12h)         → every 30 min
//   IDLE   (nothing near)              → every 3h (slate discovery)
// The pace governor stretches MID/IDLE when the month's burn runs hot — but it
// NEVER throttles STRIKE/NEAR, because that's the window where plays have to
// appear in time to actually bet them. One call covers a whole league's slate,
// so the fast window is cheap (a few calls per game-cluster, not per game).
const STRIKE_MIN = Number(process.env.ODDS_STRIKE_MIN) || 4;
const NEAR_MIN = Number(process.env.ODDS_NEAR_MIN) || 10;
const MID_MIN = Number(process.env.ODDS_MID_MIN) || 30;
const IDLE_MIN = Number(process.env.ODDS_IDLE_MIN) || 180;
const lastKeyFetch = new Map(); // odds-api league key -> ms of last fetch

function paceMult() {
  const now = new Date();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const dayFrac = Math.max(0.02, (now.getUTCDate() - 1 + now.getUTCHours() / 24) / daysInMonth);
  const target = oddsApi.monthlyBudget * dayFrac;
  if (!target || budget.used <= target) return 1;
  const r = budget.used / target;
  return r <= 1.25 ? 1.5 : r <= 1.6 ? 2.5 : 4;
}

// Fetch interval (minutes) for a sport's key. Governor (mult) applies to MID/IDLE
// ONLY — the strike/near windows stay fast no matter how stressed the budget is.
function sportIntervalMin(sport, mult) {
  const now = Date.now();
  let tier = 3; // 3 idle · 2 mid · 1 near · 0 strike
  for (const g of getGames()) {
    if (g.sport !== sport) continue;
    const t = Date.parse(g.commence_time || '');
    if (!Number.isFinite(t)) continue;
    const dt = t - now;
    if (dt <= 30 * 60_000 && dt >= -3.5 * 3600_000) return STRIKE_MIN;      // live or <30m — fastest, protected
    if (dt <= 90 * 60_000 && dt >= -3.5 * 3600_000) { tier = Math.min(tier, 1); continue; }
    if (dt > 0 && dt <= 12 * 3600_000) tier = Math.min(tier, 2);
  }
  if (tier === 1) return NEAR_MIN;        // protected from the governor
  if (tier === 2) return MID_MIN * mult;
  return IDLE_MIN * mult;
}

// ── Movement baseline: in-process observations + rehydrated history ──
// key = `${game_id}|${book}|${market}|${side}` -> { line, price, at, source }.
// `at` is ms: Date.now() for something we just saw, Date.parse(fetched_at) for
// a row read back out of line_snapshots. One stamp, one staleness rule.
const lastLines = new Map();
// Games whose baseline is settled for this process — hydrated SUCCESSFULLY, or
// normalized. A game that missed the cap this run is never hydrated later: a
// backwards baseline arriving after a live observation would manufacture a
// phantom move.
const baselineDone = new Set();
// Games whose hydration READ failed, which is a different thing from settled.
// line_snapshots is the table that statement-timeouts (D68), so a cold run can
// easily fail every read. If a failure counted as settled — here or in
// normalize() — the game would never be retried and a long-lived process would
// behave exactly as it did before this fix, silently and forever. So a failure
// leaves the game unsettled and the next run tries again.
const baselineFailed = new Set();
let hydratedOnce = false;   // false until the first odds run finishes (cold cap)
let hydratedThisRun = 0;    // games hydrated so far this run, for the cap
// Consecutive runs where hydration attempted reads and EVERY game failed. See
// HYDRATE_FAIL_RUNS: not burning the cold allowance on such a run is right for
// a blip and catastrophic for an outage, because the cold cap is then re-spent
// in full on every subsequent run, forever.
let hydrateFailRuns = 0;
// Flipped off the first time PostgREST rejects gap_min/baseline_source, i.e.
// until the two `alter table` lines in scripts/schema.sql are hand-run.
let extraCols = true;

// Beyond this gap a baseline is not comparable — see the header. Read with
// hdrNum, not `||`: ODDS_MOVE_MAX_GAP_MIN=0 is the "prove the bound governs"
// setting in the manual check, and `Number('0') || 360` is 360.
const MOVE_MAX_GAP_MIN = hdrNum(process.env.ODDS_MOVE_MAX_GAP_MIN) ?? 360;
const HYDRATE_MAX_GAMES = Number(process.env.ODDS_HYDRATE_MAX_GAMES) || 24;  // steady state
const HYDRATE_COLD_MAX = Number(process.env.ODDS_HYDRATE_COLD_MAX) || 120;   // first run of the process
// Spreads and totals only — `book-move`'s list, for the same reason. h2h
// outcomes carry no `point`, so every h2h snapshot row has a null `line`,
// baselineFromSnapshots skips it, and no h2h row can ever produce a baseline
// entry. Including it cost a third of the cold read for nothing.
const BASELINE_MARKETS = ['spreads', 'totals'];
// 11 books x 2 outcomes = 22 rows for one full batch of one market, plus slack.
const BASELINE_LIMIT = 40;
const HYDRATE_CHUNK = 6;    // concurrent queries, so a cold start costs ~2s not ~12s

// Circuit breaker on the cold allowance. `line_snapshots` is the table that
// statement-timeouts (D68), and `db.isConnected()` is false only when Supabase
// is UNCONFIGURED — a query-level failure does not short-circuit anything. So a
// persistent read failure means every attempted game fails, `hydratedOnce`
// stays false, and the NEXT run re-spends the full cold cap (120 games x 2
// markets = 240 timing-out selects, 40 chunked waves) before a single
// normalize() runs — every run, indefinitely. At an 8s statement timeout that
// is ~5 minutes of added latency per odds run, and the orchestrator awaits
// `odds` before every other agent, so the whole chain stalls while the one
// table already in distress is hammered 5x harder than the steady cap allows.
//
// After HYDRATE_FAIL_RUNS consecutive all-failed runs the cold allowance is
// forfeited and hydration drops to a HYDRATE_PROBE_GAMES-sized probe (2
// selects a run) purely to notice recovery; one successful game resets the
// streak and normal steady-state hydration resumes next run.
//
// 3 runs: odds runs are 4-30 minutes apart, so three consecutive failures mean
// at least ~12 minutes of continuous failure — well past a transient timeout,
// while still leaving a genuinely cold process its first attempt plus two
// retries at the full cold cap (the point of not burning it on a blip).
const HYDRATE_FAIL_RUNS = 3;
const HYDRATE_PROBE_GAMES = 1;

// The steam feed's simultaneity bound — NOT the same question as whether a
// movement is worth writing down. `sharp` treats >= 3 co-directional rows in
// one `getIntel('movements')` array as STEAM, i.e. coordinated money hitting
// several books at once, and its own window is "the most recent odds run"
// (src/agents/sharp/index.js) — one refetch interval of the keys in it. Pre-fix
// that held by construction: a row could only exist if two consecutive
// in-process fetches of that key straddled the move. Rehydration breaks it — a
// baseline up to MOVE_MAX_GAP_MIN (360) old turns an afternoon's drift at three
// books into `3 books moved totals Over down`.
//
// So the bound is 35 minutes: MID_MIN's default (30, the widest UNGOVERNED
// pre-game cadence) plus headroom, because a real MID gap is never exactly 30.
// The per-key dedup fires at `now - lastFetch >= ivMs`, so an actual mid-tier
// refetch is 30 minutes PLUS the wake grid (the odds agent wakes every 3 min on
// `starter`) PLUS the fetch itself — and gap_min rounds to 1dp, leaving a ~3
// second grace at 30. A MID refetch 3 seconds late yields gap_min 30.1 and was
// dropped, so a 30 bound carried only STRIKE (4) and NEAR (10) in practice and
// excluded the one tier it was chosen to admit. 35 admits MID as intended.
// A literal, NOT live-coupled to MID_MIN — lowering the fetch cadence (the
// tests set it to a fraction of a millisecond) must not silently empty the
// steam feed. Idle-tier gaps (180, up to 720 governed) are still excluded on
// purpose — a three-hour drift is not steam no matter which process observed
// it, and the spec's own rule is that an in-process 12h gap is just as
// conflated as a rehydrated one. `line_movements` still records every row at
// full detail, and `movementsAll` publishes every row in memory; this filters
// only the steam feed. Follow-up: `sharp` should also check `gap_min` itself,
// so it is safe against any other producer — not changed here.
// Never wider than the emit bound: a row we refuse to write cannot be steam.
const STEAM_MAX_GAP_MIN = Math.min(
  MOVE_MAX_GAP_MIN,
  hdrNum(process.env.ODDS_STEAM_MAX_GAP_MIN) ?? 35,
);

// Movements safe to publish as an in-memory steam feed. `gap_min` rides on the
// in-memory rows exactly as it does on the Postgres ones, so the rows stay
// self-identifying wherever they land; a row with no `gap_min` cannot be shown
// to be simultaneous and is therefore dropped rather than trusted.
export function steamSafeMovements(rows) {
  return (rows || []).filter((m) => {
    if (!m) return false;
    const raw = m.gap_min;
    // `Number(x)` is 0 and finite for null, '', '  ', [], false AND true(=1) —
    // the D10 trap again, and here every one of them would read as a row whose
    // gap is ZERO, i.e. the most simultaneous row there is. So the type is
    // checked before the coercion: only a number, or a string that is not
    // blank (Postgres hands numerics back as strings), is a gap at all.
    if (typeof raw !== 'number' && typeof raw !== 'string') return false;
    if (typeof raw === 'string' && raw.trim() === '') return false;
    const gap = Number(raw);
    // `gap >= 0` for the same reason movementFrom refuses a future baseline: a
    // negative gap is not a narrow gap, it is a row that cannot say when.
    return Number.isFinite(gap) && gap >= 0 && gap <= STEAM_MAX_GAP_MIN;
  });
}

// Test seams.
export function getBaseline() { return lastLines; }
export function __resetBaseline() {
  lastLines.clear(); baselineDone.clear(); baselineFailed.clear();
  hydratedOnce = false; hydratedThisRun = 0; hydrateFailRuns = 0; extraCols = true;
}

// Newest-first snapshot rows -> baseline entries. Pure. First occurrence per
// key wins, which IS the "most recent row per key" rule given the DESC order.
// Rows with no line, or a stamp that does not parse, are no baseline at all —
// Number(null) is 0 and would read as a real pick-em line (D10's trap).
export function baselineFromSnapshots(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r || !r.game_id || !r.book || !r.market || !r.side) continue;
    if (r.line == null || r.line === '') continue;   // Number('') is 0, i.e. a pick-em
    const line = Number(r.line);                 // Postgres hands numerics back as strings
    if (!Number.isFinite(line)) continue;
    const at = Date.parse(r.fetched_at || '');
    if (!Number.isFinite(at)) continue;
    const key = `${r.game_id}|${r.book}|${r.market}|${r.side}`;
    if (out.has(key)) continue;
    out.set(key, {
      line, price: r.price != null && Number.isFinite(Number(r.price)) ? Number(r.price) : null,
      at, source: 'rehydrated',
    });
  }
  return out;
}

// THE movement rule, in one place — normalize() used to inline it.
// Returns { move } when a row should be written, { stale: true } when the line
// moved but the baseline is too old to say by how much, and null when there is
// nothing to report at all. The caller reseeds unconditionally either way.
export function movementFrom(prev, cur, nowMs) {
  if (!prev || prev.line == null || cur.line == null) return null;
  // Same trap baselineFromSnapshots guards, guarded again on this function's
  // own arguments because it is exported: Number('') is 0 and finite, so an
  // empty-string line would read as a real pick-em and emit a phantom move off
  // a line that does not exist (the D10/D67 shape).
  if (prev.line === '' || cur.line === '') return null;
  const pl = Number(prev.line);
  const cl = Number(cur.line);
  if (!Number.isFinite(pl) || !Number.isFinite(cl)) return null;
  if (pl === cl) return null;
  const gapMs = nowMs - Number(prev.at);
  // An unparseable or future `at` is not a gap we can defend — treat it as stale.
  if (!(gapMs >= 0 && gapMs <= MOVE_MAX_GAP_MIN * 60_000)) return { stale: true };
  return {
    move: {
      sport: cur.sport, game_id: cur.game_id, market: cur.market, book: cur.book, side: cur.side,
      line_open: pl, line_current: cl, moved: Math.round((cl - pl) * 10) / 10,
      price_open: prev.price, price_current: cur.price,
      direction: cl > pl ? 'up' : 'down',
      gap_min: Math.round((gapMs / 60_000) * 10) / 10,
      baseline_source: prev.source || 'in-process',
    },
  };
}

// Refill absent baseline keys from line_snapshots. NO `fetch(` here and no call
// of any kind outside db.select — the zero-spend property is structural, and
// tools/smoke.mjs reads this function body to keep it that way.
//
// One query per game x market, `match` carrying BOTH game_id and market so the
// full equality prefix of line_snapshots_game_idx (game_id, market,
// fetched_at desc) is used and `fetched_at desc` comes off the index. Drop
// `market` and Postgres sorts every snapshot row that game ever accumulated
// (~35k for a 36h-window game refetched every 4 min). `side` is filtered in JS
// for the same reason. Hydration only ever FILLS absent keys.
//
// Returns { keys, games, attempted, failures } rather than a bare count: the
// caller reports all four, because "hydration found nothing" and "hydration
// never ran" must not print the same line, and a run whose every read failed
// must not be allowed to burn the once-per-process cold allowance.
async function hydrateBaseline(games, cold) {
  const out = { keys: 0, games: 0, attempted: 0, failures: 0 };
  if (!db.isConnected()) return out;
  const now = Date.now();
  // Breaker open: the last HYDRATE_FAIL_RUNS runs hydrated nothing because the
  // reads failed. Forfeit the cold allowance and probe instead of re-spending
  // 240 selects against a table that is plainly in distress.
  const broken = hydrateFailRuns >= HYDRATE_FAIL_RUNS;
  const cap = broken ? HYDRATE_PROBE_GAMES : (cold ? HYDRATE_COLD_MAX : HYDRATE_MAX_GAMES);
  const room = cap - hydratedThisRun;
  if (room <= 0) return out;

  const pending = [];
  for (const g of games || []) {
    const gameId = g && (g.game_id || g.id);
    if (!gameId || baselineDone.has(gameId)) continue;
    const t = Date.parse((g.commence_time) || '');
    pending.push({ gameId, t: Number.isFinite(t) ? t : Infinity });
  }
  // Upcoming kickoffs claim the cap first (book-move's ordering) — pre-game
  // movement is the whole point; started games fill what is left, freshest first.
  const upcoming = pending.filter((x) => x.t >= now).sort((a, b) => a.t - b.t);
  const started = pending.filter((x) => x.t < now).sort((a, b) => b.t - a.t);
  const slate = [...upcoming, ...started].slice(0, room).map((x) => x.gameId);
  if (!slate.length) return out;

  // Same bound as the staleness rule: a row we would refuse to compare against
  // is a row not worth reading.
  const since = new Date(now - MOVE_MAX_GAP_MIN * 60_000).toISOString();
  for (let i = 0; i < slate.length; i += HYDRATE_CHUNK) {
    await Promise.all(slate.slice(i, i + HYDRATE_CHUNK).map(async (gameId) => {
      // Attempted counts against the cap whether or not it worked — a timed-out
      // read cost the same query a successful one would have.
      out.attempted++;
      hydratedThisRun++;
      let failed = false;
      for (const market of BASELINE_MARKETS) {
        try {
          // `last_update` is deliberately NOT selected: baselineFromSnapshots
          // never reads it (the baseline age is `fetched_at`, the origin stamp)
          // and the column exists only via a hand-run `alter table`
          // (scripts/schema.sql). On an environment where that DDL was never
          // applied PostgREST rejects the WHOLE select on the unknown column,
          // so asking for it would fail 100% of hydration reads — the D69/D70
          // shape, and with the breaker above a permanent probe loop.
          const rows = await db.select('line_snapshots', 'game_id,book,market,side,line,price,fetched_at', {
            match: { game_id: gameId, market },
            gte: { fetched_at: since },
            order: { column: 'fetched_at', ascending: false },
            limit: BASELINE_LIMIT,
          });
          for (const [key, entry] of baselineFromSnapshots(rows)) {
            if (lastLines.has(key)) continue;   // never overwrite a live observation
            lastLines.set(key, entry);
            out.keys++;
          }
        } catch (e) {
          // Per game x market, so one failure cannot abort the run — but it is
          // NOT swallowed: the game stays unsettled and the count is reported.
          failed = true;
          out.failures++;
          logger.warn('odds', `baseline read failed for ${gameId}/${market}: ${e.message}`);
        }
      }
      if (failed) { baselineFailed.add(gameId); return; }
      baselineFailed.delete(gameId);
      baselineDone.add(gameId);
      out.games++;
    }));
  }
  return out;
}

// "The COLUMN isn't there", which is narrower than db.isMissingRelation: that
// one also matches 42P01 / "relation does not exist", i.e. a missing TABLE.
// Latching extraCols off on a missing table would be wrong for the life of the
// process — once the table came back we would keep writing rows without
// gap_min, and the reader rule (D73) classifies exactly those rows as
// non-authoritative. Only a missing column may disable the extra columns.
//
// `.code` is usually absent here: db.insert rethrows `new Error('insert <t>:
// <msg>')` and discards the PostgREST code, so the message test below is the
// branch that actually runs in production.
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST202', 'PGRST205']);
export function isMissingColumn(e) {
  if (!e) return false;
  if (e.code && MISSING_COLUMN_CODES.has(e.code)) return true;
  if (e.code && MISSING_TABLE_CODES.has(e.code)) return false;
  const msg = String(e.message || '');
  if (!/does not exist|could not find|schema cache|undefined column|undefined table/i.test(msg)) return false;
  // The word COLUMN is what separates the two. Postgres spells the column case
  // `column "gap_min" of relation "line_movements" does not exist` — which
  // CONTAINS the table case's wording, so the table test cannot come first.
  // The table shapes (`relation "line_movements" does not exist`, `Could not
  // find the table 'public.line_movements' in the schema cache`) never say
  // column, and must leave extraCols alone.
  return /\bcolumns?\b/i.test(msg);
}

// The line_movements insert, with the D70 guard: if the two `alter table` lines
// have not been hand-run, PostgREST rejects the WHOLE insert on the unknown
// columns and movement writes fail silently. Strip them once and retry, so
// behaviour is correct either way.
async function insertMovements(rows) {
  const stripped = () => rows.map(({ gap_min, baseline_source, ...rest }) => rest);
  if (!extraCols) return db.insert('line_movements', stripped());
  try { return await db.insert('line_movements', rows); }
  catch (e) {
    if (!isMissingColumn(e)) throw e;
    extraCols = false;
    logger.warn('odds', `line_movements is missing gap_min/baseline_source — run the alter table lines in scripts/schema.sql; writing without them for now (${e.message})`);
    const res = await db.insert('line_movements', stripped());
    // The probe above already fired reportWriteFailure, so a
    // `write|line_movements` degradation is now standing — and /data-health and
    // the watchdog would report movement writes as failing for the full 90-min
    // TTL while every row is in fact landing. Retract it: that channel exists to
    // surface REAL silent write failure (D70), and a false alarm on the one
    // case it was built for is how it becomes noise nobody reads.
    clearDegraded('write|line_movements');
    return res;
  }
}

// ── Opening lines: the first line we record per game/market sticks ──
const openings = new Map(); // `${game_id}|${market}` -> { game_id, market, line, side, captured_at }
export function getOpenings() { return openings; }

// ── Fetch one sport key's odds ──────────────────────────────────
async function fetchOdds(sportKey) {
  // Limit to games starting in the next 36h to keep payloads small.
  const to = new Date(Date.now() + 36 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const params = new URLSearchParams({
    apiKey: oddsApi.key,
    regions: 'us',
    markets: 'h2h,spreads,totals',
    oddsFormat: 'american',
    bookmakers: BOOKS.join(','),
    commenceTimeTo: to,
  });
  const url = `${oddsApi.base}/sports/${sportKey}/odds?${params}`;
  const res = await fetch(url);
  const hdr = {
    remaining: res.headers.get('x-requests-remaining'),
    used: res.headers.get('x-requests-used'),
    last: res.headers.get('x-requests-last'), // credits this call actually cost
  };
  if (res.status === 422) return { games: [], hdr }; // no events in window
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Odds API ${res.status} for ${sportKey}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return { games: data, hdr };
}

// Free, non-billed endpoint: which sports are currently in season.
async function inSeasonKeys() {
  try {
    const res = await fetch(`${oddsApi.base}/sports?apiKey=${oddsApi.key}`);
    if (!res.ok) return null;
    const data = await res.json();
    return new Set(data.filter((s) => s.active).map((s) => s.key));
  } catch (e) { return null; }
}

// Normalize one Odds API event into our game shape, snapshot rows, movements.
function normalize(sport, ev, snapshots, movements, stats) {
  const now = Date.now();
  // Settled either way: hydrated earlier this run, or settled right here —
  // UNLESS this game's hydration read failed. Marking a failed game settled
  // here was the other half of the latch: hydrateBaseline skips settled games,
  // so one transient timeout would have disabled rehydration for that game for
  // the life of the process.
  if (!baselineFailed.has(ev.id)) baselineDone.add(ev.id);
  const game = {
    game_id: ev.id, sport, home: ev.home_team, away: ev.away_team,
    commence_time: ev.commence_time, books: {},
    // convenience: consensus total/spread filled below
  };
  const totals = [];
  for (const bm of ev.bookmakers || []) {
    const bookKey = bm.key;
    // last_update = when this book last CHANGED its odds (per-market when present,
    // else the bookmaker-level stamp). Kept so the scanners can see quote age and
    // ignore dead/suspended markets. An old stamp = unchanged, not unavailable.
    const bookTs = bm.last_update || null;
    game.books[bookKey] = { label: BOOK_LABELS[bookKey] || bookKey, updated: bookTs, markets: {} };
    for (const mk of bm.markets || []) {
      const mkTs = mk.last_update || bookTs;
      for (const oc of mk.outcomes || []) {
        const side = mk.key === 'totals' ? oc.name : oc.name; // Over/Under or team name
        const line = oc.point != null ? oc.point : null;
        const price = oc.price != null ? Math.round(oc.price) : null;
        game.books[bookKey].markets[`${mk.key}:${side}`] = { line, price, ts: mkTs };
        snapshots.push({
          sport, game_id: ev.id, commence_time: ev.commence_time,
          home: ev.home_team, away: ev.away_team, book: bookKey,
          market: mk.key, side, line, price, last_update: mkTs,
        });
        if (mk.key === 'totals' && side === 'Over' && line != null) totals.push(line);

        // Movement detection vs last seen line for this book/market/side.
        const key = `${ev.id}|${bookKey}|${mk.key}|${side}`;
        const verdict = movementFrom(lastLines.get(key), {
          sport, game_id: ev.id, market: mk.key, book: bookKey, side, line, price,
        }, now);
        if (verdict && verdict.move) movements.push(verdict.move);
        else if (verdict && verdict.stale && stats) stats.staleBaseline++;
        // Reseed unconditionally — including past the bound, which is how a
        // stale baseline stops being stale instead of emitting fiction forever.
        lastLines.set(key, { line, price, at: now, source: 'in-process' });
      }
    }
  }
  if (totals.length) game.consensusTotal = totals.sort((a, b) => a - b)[Math.floor(totals.length / 2)];
  return game;
}

async function run() {
  if (!oddsApi.key) return { summary: 'skipped — no ODDS_API_KEY' };
  await loadBudget();

  if (budget.remaining <= 0) {
    return { summary: `budget exhausted for ${budget.month} (${budget.used}/${oddsApi.monthlyBudget}) — skipping` };
  }

  const active = await inSeasonKeys(); // null = couldn't determine, fetch anyway
  const allGames = [];
  const snapshots = [];
  const movements = [];
  let calls = 0;
  let skippedSeason = 0;
  let skippedBudget = 0;
  let skippedPaced = 0;
  // keys filled vs GAMES hydrated are different units (~44 keys per game), so
  // both are reported rather than one standing in for the other.
  const hydr = { keys: 0, games: 0, attempted: 0, failures: 0 };
  const stats = { staleBaseline: 0 };
  // The cap is per RUN, not per key, so a many-league slate cannot hydrate
  // 120 games twelve times over.
  const coldRun = !hydratedOnce;
  hydratedThisRun = 0;

  // Reallocate the month's budget among IN-SEASON sports only — the static
  // shares sum to 1.0 across all 12 sports, which starves in-season ones while
  // out-of-season budget sits idle. POOL (85%) is allocatable; the rest is
  // margin, not a second pool — see POOL above.
  const isActive = (sport, meta) => {
    if (meta.oddsSkip) return false;
    if (!active) return true;
    return (meta.leagues || [meta.key]).some((k) => active.has(k));
  };
  const footballOn = oddsApi.footballPriorityOn();
  const isFootball = (sport) => oddsApi.footballSports.includes(sport);
  // Football stays in the denominator for the whole of its season, even on days
  // the API lists no slate yet. Otherwise its 0.48 share drops out in early
  // September and every other ceiling inflates to fill the gap: soccer's cap was
  // ~2040 rather than ~700, so its 1704 never tripped a limit. Nothing was
  // overspending — the ceilings were just being recomputed loose.
  const actives = Object.entries(SPORTS)
    .filter(([s, m]) => isActive(s, m) || (footballOn && isFootball(s) && !m.oddsSkip))
    .map(([s]) => s);
  // Two ways a ceiling moves wrongly, both from `actives` changing mid-month:
  //   - a season ENDING drops out, sumAlloc falls, every other ceiling inflates
  //     (the September failure, in its other direction);
  //   - a season STARTING adds its share and shrinks every ceiling retroactively
  //     (NCAAB in November: +0.06 to sumAlloc, ~7% off everyone), so a sport just
  //     under its cap wakes up over it and stops for the rest of the month.
  // Fixed in two places. The denominator is monotonic within a month — a sport
  // that has billed this month stays in it after its season ends, so departures
  // cannot inflate anyone. And a ceiling never falls below what that sport has
  // already spent, so an arrival cannot retroactively strand anyone; it just
  // stops granting further headroom, which is honest.
  // NOT `spent + share × headroom`: that ratchets, because spending raises your
  // own ceiling. One sport hits 94% of the pool in 8 runs that way.
  const billed = Object.keys(budget.bySport || {}).filter((s) => SPORTS[s] && (budget.bySport[s] || 0) > 0);
  const denom = [...new Set([...actives, ...billed])];
  lastDenom = denom;                       // so hasOddsBudget sees the same ceiling
  const nominal = (sport) => nominalCap(sport, denom);   // sumAlloc lives in nominalCap now
  const capOf = (sport) => (denom.includes(sport)
    ? Math.max(budget.bySport[sport] || 0, nominal(sport))
    : sportCap(sport));

  const mult = paceMult();

  // Football floor: in football season, hold back the credits NFL/NCAAF have
  // NOT spent yet so a non-football sport can't drain the month out from under
  // them before their slate fills (see config's FOOTBALL_PRIORITY).
  const footballFloor = footballOn
    ? oddsApi.footballSports.reduce((t, s) => t + Math.max(0, capOf(s) - (budget.bySport[s] || 0)), 0)
    : 0;
  // Credits this sport is actually allowed to touch right now.
  const spendable = (sport) => (isFootball(sport) ? budget.remaining : budget.remaining - footballFloor);
  let skippedFootballFloor = 0;

  for (const [sport, meta] of Object.entries(SPORTS)) {
    // The Odds API has no bare golf/tennis key (event-specific only) — skip to avoid 404s.
    if (meta.oddsSkip) continue;
    const keys = meta.leagues || [meta.key];
    // Per-sport monthly cap (in credits).
    if ((budget.bySport[sport] || 0) >= capOf(sport)) { skippedBudget++; continue; }
    if (spendable(sport) <= 0) { skippedFootballFloor++; continue; }
    // How often this sport's keys deserve a refresh right now (governor applies
    // to mid/idle only; strike/near stay fast).
    const ivMs = sportIntervalMin(sport, mult) * 60_000;

    for (const key of keys) {
      if (active && !active.has(key) && key !== 'golf' && key !== 'tennis') { skippedSeason++; continue; }
      if (budget.remaining <= 0) { skippedBudget++; break; }
      if ((budget.bySport[sport] || 0) >= capOf(sport)) { skippedBudget++; break; }
      if (spendable(sport) <= 0) { skippedFootballFloor++; break; }
      if (Date.now() - (lastKeyFetch.get(key) || 0) < ivMs) { skippedPaced++; continue; }

      try {
        const { games, hdr } = await fetchOdds(key);
        recordSpend(sport, hdr);
        lastKeyFetch.set(key, Date.now());
        calls++;
        // Warm the baseline from line_snapshots BEFORE comparing against it, so
        // the first run of a fresh process detects movement instead of seeding
        // silently. Costs no credits — see hydrateBaseline.
        const h = await hydrateBaseline(games, coldRun);
        hydr.keys += h.keys; hydr.games += h.games;
        hydr.attempted += h.attempted; hydr.failures += h.failures;
        for (const ev of games) allGames.push(normalize(sport, ev, snapshots, movements, stats));
      } catch (e) {
        logger.warn('odds', e.message);
        // Count the spend even on error (the request was made), reconcile loosely.
        recordSpend(sport, null);
        lastKeyFetch.set(key, Date.now());
      }
    }
  }

  // Only a run that actually fetched counts as the first one: a run where
  // every key was paced-skipped would otherwise burn the cold cap on nothing.
  // Nor does a run where every hydration read failed — line_snapshots
  // statement-timeouts (D68), and burning the once-per-process cold allowance
  // on a run that hydrated nothing is how a transient DB failure at boot turns
  // into permanently-disabled rehydration.
  //
  // But "do not burn the allowance" cannot be unconditional: on a PERSISTENT
  // failure it re-spends the full cold cap every run forever. So the streak is
  // counted, and HYDRATE_FAIL_RUNS consecutive all-failed runs open the breaker
  // in hydrateBaseline (probe-sized reads from then on) and are logged at warn,
  // so the condition is visible instead of silent. One hydrated game resets it.
  if (calls) {
    if (hydr.attempted > 0 && hydr.games === 0) {
      hydrateFailRuns++;
      if (hydrateFailRuns === HYDRATE_FAIL_RUNS) {
        logger.warn('odds', `baseline hydration has failed every read for ${hydrateFailRuns} consecutive runs — forfeiting the cold allowance and probing ${HYDRATE_PROBE_GAMES} game/run until line_snapshots answers again (D68)`);
      }
    } else if (hydr.games > 0) {
      hydrateFailRuns = 0;
      hydratedOnce = true;
    }
    // `attempted === 0` is the third case and it changes NOTHING. A run that
    // fetched an empty slate, or one where every game was already settled,
    // hydrated nothing — the same condition the two branches above exist to
    // protect against — so it may neither spend the cold allowance (a redeploy
    // during a dead hour would otherwise leave the first real slate on the
    // steady cap) nor clear a breaker that no successful read has yet retracted.
  }

  // Keep previously-known games whose key was paced-skip this run, so downstream
  // agents never lose the slate between refreshes (drop long-finished games).
  {
    const seen = new Set(allGames.map((g) => g.game_id));
    const cutoff = Date.now() - 6 * 3600_000;
    for (const g of getGames()) {
      if (seen.has(g.game_id)) continue;
      const t = Date.parse(g.commence_time || '');
      if (Number.isFinite(t) && t > cutoff) allGames.push(g);
    }
  }

  // Evict baselines for games that have left the slate — same kickoff + 6h
  // cutoff the retention block above just applied, so `allGames` IS the set
  // still in play. The Map was never pruned before: ~66 keys per game and
  // ~150 new games a day means a month-lived process carries ~300k of them.
  // (`openings` leaks identically, but pruning it would re-issue every
  // opening_lines upsert — left alone deliberately.)
  {
    const live = new Set(allGames.map((g) => g.game_id));
    for (const key of lastLines.keys()) {
      if (!live.has(key.slice(0, key.indexOf('|')))) lastLines.delete(key);
    }
    for (const gameId of baselineDone) if (!live.has(gameId)) baselineDone.delete(gameId);
    for (const gameId of baselineFailed) if (!live.has(gameId)) baselineFailed.delete(gameId);
  }

  // Persist snapshots + movements + budget; publish games to the store.
  if (snapshots.length) {
    try { await db.insert('line_snapshots', snapshots); } catch (e) { logger.warn('odds', `snapshot write: ${e.message}`); }
  }
  if (movements.length) {
    try { await insertMovements(movements); } catch (e) { logger.warn('odds', `movement write: ${e.message}`); }
  }
  // Capture opening lines the first time we see each game/market (accurate
  // "open" from first sight; ignoreDuplicates means the opener never changes).
  const nowIso = new Date().toISOString();
  const newOpens = [];
  for (const g of allGames) {
    const m = computeMarkets(g);
    const cap = (market, line, side) => {
      if (line == null) return;
      const key = `${g.game_id}|${market}`;
      if (!openings.has(key)) {
        const row = { game_id: g.game_id, market, line, side, captured_at: nowIso };
        openings.set(key, row);
        newOpens.push(row);
      }
    };
    cap('total', m.total.consensus, 'Over');
    cap('spread', m.spread.consensusHome, g.home);
    cap('ml', m.ml.consensusHome, g.home);
  }
  if (newOpens.length) {
    try { await db.upsert('opening_lines', newOpens, 'game_id,market', { ignoreDuplicates: true }); }
    catch (e) { logger.warn('odds', `opening capture: ${e.message}`); }
  }

  await persistBudget();
  setGames(allGames);
  // Two feeds, one per question — see the header.
  //
  // `movements` is gap-filtered: `sharp` reads simultaneity out of it (and
  // corroborate / public-fade / sharp-divergence / export read its verdict
  // after that), so a rehydrated baseline's six-hour drift must not arrive
  // there looking like coordinated money — see STEAM_MAX_GAP_MIN.
  //
  // `movementsAll` is every row, because withholding one does not read as
  // "withheld" downstream. `public-splits` asks whether the public's own
  // number moved and takes `moves.total.get(id) ?? 0`, which turns an absent
  // row into a net move of zero and so turns a reverse line move into a
  // freeze — a different, weaker tell about the same game. Filtering is
  // subtractive only for a consumer asking about simultaneity.
  //
  // `line_movements` above is unfiltered too: it is the complete record.
  const steamFeed = steamSafeMovements(movements);
  const steamDropped = movements.length - steamFeed.length;
  setIntel('movements', steamFeed);
  setIntel('movementsAll', movements);

  // Reported ALWAYS, zeros included, and in both units. A silent no-op is this
  // feature's likeliest failure, so "0/0 games" (nothing was due), "0/12 games"
  // with read failures (every read failed) and "12/12 games → 0 keys"
  // (hydration ran and the window held nothing) have to be different lines.
  const baselineBit = `baseline ${hydr.games}/${hydr.attempted} games → ${hydr.keys} keys rehydrated${hydr.failures ? `, ${hydr.failures} read failures` : ''}, ${stats.staleBaseline} stale-baseline${hydrateFailRuns >= HYDRATE_FAIL_RUNS ? `, reads circuit-broken after ${hydrateFailRuns} failed runs` : ''}${steamDropped ? `, ${steamDropped} too wide for steam` : ''}`;

  return {
    summary: `${allGames.length} games, ${snapshots.length} snapshots, ${movements.length} movements · ${baselineBit} · ${calls} calls${skippedPaced ? `, ${skippedPaced} paced` : ''}${mult > 1 ? ` (throttle ×${mult})` : ''} · credits ${budget.used}/${oddsApi.monthlyBudget} (${budget.remaining} left)${skippedBudget ? `, ${skippedBudget} budget-skips` : ''}${skippedFootballFloor ? `, ${skippedFootballFloor} held for football (floor ${footballFloor})` : ''}`,
    gamesMonitored: allGames.length,
    data: {
      games: allGames.length, snapshots: snapshots.length, movements: movements.length, calls,
      // `rehydratedKeys` is keys, `rehydratedGames` is games — never compare
      // either against `games` above without knowing which is which.
      rehydratedKeys: hydr.keys, rehydratedGames: hydr.games,
      hydrateAttempted: hydr.attempted, hydrateFailures: hydr.failures,
      staleBaseline: stats.staleBaseline,
      // `movements` is what was written; `steamFeed` is what sharp can see.
      steamFeed: steamFeed.length, steamDropped, hydrateFailRuns,
      budget: getOddsBudget(),
    },
  };
}

export default { name: 'odds', run };
