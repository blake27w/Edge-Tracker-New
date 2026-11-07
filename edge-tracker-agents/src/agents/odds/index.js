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
// SEASONALITY IS DERIVED, NOT CONFIGURED. A ceiling is
// `budget x POOL x share / sumAlloc`, where sumAlloc sums the shares of the
// sports in the DENOMINATOR — so membership of that set is worth as much as the
// shares themselves, and it used to be decided by today's board plus a
// hand-coded football month range. Every season change therefore needed a human
// to notice and retune (D86: MLB held 0.14 of the pool through its offseason on
// the strength of ONE credit, because `billed` put any sport with spend into the
// denominator and never took it out).
//
// The signal is the free `/sports` active flag we ALREADY fetch every run
// (inSeasonKeys) — zero new credits by construction, there is no `fetch(`
// anywhere in the season path. The flag itself flaps, which is what D6 is about,
// so what we act on is a persisted per-sport "last seen active" date with an
// ASYMMETRIC release grace:
//
//   entry   — immediate, on a single active observation;
//   release — only after ODDS_SEASON_GRACE_DAYS (14, floored at 7) consecutive
//             OBSERVED quiet days.
//
// OBSERVED, not elapsed, and that word is the whole of it. A calendar age would
// make an OUTAGE indistinguishable from a season ending: the month's credits
// exhaust around day 13 at the measured 2.3x demand (D87), and if the clock kept
// ticking while nothing was watching, the first run of the next month would find
// every sport ~18 days idle and release the lot on a SINGLE observation — D6, by
// a different road. So the counter counts DAYS WE ACTUALLY LOOKED AND SAW THE
// SPORT ABSENT (`quiet`, with `obs` naming the day last counted so the ~20
// runs/hr count once), it resets to zero on any active observation, and a day
// nobody observed cannot age a sport out. The season observation therefore also
// runs BEFORE the budget-exhausted early return: /sports is free, so there is no
// reason for an exhausted month to stop watching.
//
// The asymmetry is the whole design. Entry only ever tightens other sports'
// ceilings, which is harmless; release loosens them, which is the September
// failure (D6) where football left the denominator on a Tuesday and soccer's cap
// went ~700 -> ~2040. Rate-limiting release to one transition per sport per
// grace window is what makes a slate-derived denominator safe at all.
//
// FAIL-SAFE DIRECTION, STATED: every unknown resolves to IN the denominator —
// an unreadable feed, an un-seeded sport, an oddsSkip sport with spend. Holding a
// dead sport too long makes everyone's ceiling slightly too tight and strands a
// few thousand recoverable credits; releasing a live sport early lets the wrong
// sports eat the month and takes the live one dark. Stranding is cheaper, so be
// wrong on the tight side (7c6571d, D65).
//
// State lives in a sentinel `api_usage` row (`provider: 'odds-season'`,
// `month: 'state'`) in the existing `by_sport jsonb` — no DDL to hand-run, which
// in this repo has a history of shipping unapplied (D69/D70).
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
import { getGames, setGames, setIntel, reportDegraded, clearDegraded } from '../../store/index.js';
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
  // Who is in the denominator AND WHY each sport is in or out. The membership
  // alone leaves the next reader inferring the decision from a share table,
  // which is exactly how D86 had to be diagnosed — so the reason ships with it.
  //
  // Before any run has published one, this is recomputed with no feed, which is
  // the same claim the ceilings above are priced against: every non-skip sport
  // held in, reason `feed-unreadable`.
  //
  // COPIED, never aliased. `lastSeason` is live agent state and this is a READ
  // path: returning it directly handed /budget a reference into the agent, and
  // the top-up loop below then wrote through it — permanently marking any
  // allocation sport that is absent from SPORTS as `in: true` while leaving it
  // out of `denom`, a contradiction that would then be published every run.
  const base = lastSeason
    || seasonDenominator(
      seasonVerdicts(null, seasonState, SPORTS, new Date(), graceDays(), oddsApi.footballPriorityOn()).verdicts,
      budget.bySport,
    ).season;
  const season = {};
  for (const [s, v] of Object.entries(base)) season[s] = { ...v };
  // An allocation sport missing from SPORTS still gets an entry, so the panel
  // never renders a share with no reason beside it. Written into the copy.
  for (const s of sports) {
    if (!season[s]) season[s] = { in: true, reason: 'feed-unreadable', last: null, first: null };
  }
  // The set the ceilings above were actually priced against — `lastDenom` when a
  // run has published one, otherwise the full table (currentCeiling's own
  // fallback, and the tightest reading available). Published so a reader can
  // check the arithmetic instead of reconstructing it, which means it has to be
  // the EFFECTIVE sum, floor included (sumAllocOf), not the raw addition.
  const priced = (lastDenom && lastDenom.length) ? lastDenom : sports;
  const sumAlloc = sumAllocOf(priced);
  // ONE sumAlloc cannot describe every ceiling above: a sport outside the
  // denominator is priced against `denom + itself` (the D65 branch-2 shape), so
  // the footer's single number describes the members only and the next
  // D86-style analysis would divide a released sport's ceiling by the wrong
  // denominator. So each sport carries the sum ITS OWN ceiling was priced
  // against, and the arithmetic closes for every row rather than most of them.
  for (const s of sports) {
    const d = (lastDenom && lastDenom.length)
      ? (lastDenom.includes(s) ? lastDenom : [...lastDenom, s])
      : (sports.includes(s) ? sports : [...sports, s]);
    season[s].pricedSum = Math.round(sumAllocOf(d) * 1000) / 1000;
  }
  return {
    pool: POOL, denom: lastDenom, allocation: { ...oddsApi.allocation }, ceilings,
    sumAlloc: Math.round(sumAlloc * 1000) / 1000,
    graceDays: graceDays(),
    season,
  };
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
// INVARIANT: the denominator can never collapse. `sumAlloc` is floored at
// MIN_SUM_ALLOC, so no sport's ceiling may exceed `pool x share / 0.25` — a
// one-element denominator prices MLB at 9520 of the 17000 pool instead of the
// WHOLE pool, and a two-element one cannot hand the month to a 0.02 sport.
// Without the floor the degenerate case currentCeiling's own comment forbids
// became REACHABLE the moment `billed` was gated by `!out`: a thin or
// partially-recovered /sports board that lists one league for a grace window
// would price that league at everything and, being active, let it spend it.
//
// 0.15 is below every real in-season set, INCLUDING the ones the recommended
// env shape produces — and that is the whole reason it is 0.15 and not 0.25.
// Under the default shares deep winter is 0.31 and midsummer 0.30, but under the
// winter ODDS_ALLOC_* shape (MLB at 0.02) the summer board after football,
// hoops and hockey release sums to 0.18; a 0.25 floor would have bound there and
// stranded ~28% of the pool for the month, which is precisely the "high floor
// quietly undoes the feature" failure this comment exists to warn about. The
// single-sport degenerate case is bounded by MAX_SPORT_POOL below, not by this
// floor, so lowering it costs nothing there: this only has to catch sums so
// small that no board we would believe produces them.
const MIN_SUM_ALLOC = 0.15;
// The second half of the same invariant, because a floor on the SUM cannot bound
// a sport whose own share is larger than the floor: NFL at 0.32, alone in the
// denominator, still divides by 0.32 and still gets the whole pool. So no single
// sport may be priced above this fraction of it, whatever the denominator says.
// 0.6 is above every ratio a real board produces — the tightest real case is
// midsummer, MLB's 0.14 of a 0.30 in-season sum, i.e. 0.47 — and well below the
// 1.0 that is the failure. Like the floor, it is a guard and not a share table:
// if it ever binds, the denominator is not credible.
const MAX_SPORT_POOL = 0.6;

export function nominalCap(sport, denomSports) {
  const share = (oddsApi.allocation[sport] ?? 0.05) / sumAllocOf(denomSports);
  return Math.floor(oddsApi.monthlyBudget * POOL * Math.min(share, MAX_SPORT_POOL));
}

// The denominator sum the ceilings are ACTUALLY priced against, floor included —
// exported so /budget can publish the number a reader would divide by rather
// than one they have to re-derive (the D86/D88 gap).
export function sumAllocOf(denomSports) {
  const raw = (denomSports || []).reduce((t, s) => t + (oddsApi.allocation[s] ?? 0.05), 0);
  return Math.max(MIN_SUM_ALLOC, raw || 1);
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
  //  2. that set plus this sport, when the sport is not in it. The season
  //     verdict for an `oddsSkip` sport is neither in nor out, so TENNIS and
  //     GOLF can still only enter via spend. On
  //     the first tennis call of a month `lastDenom` therefore excludes it —
  //     and three of the five discretionary consumers are tennis. Adding the
  //     sport normalises it properly instead;
  //  3. the whole allocation table, when nothing has been published yet. That
  //     maximises sumAlloc and so minimises the ceiling, which is the right
  //     way to be wrong before we know what is in season.
  //
  // What this must NOT do is fall back to the unnormalised `budget x share`
  // that #134 exists to remove from this path — `sportCap()` is now DELETED
  // outright, since this and the core loop were its only callers, which closes
  // the D61/D64 reintroduction surface permanently. Nor to
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

// ── Derived seasonality ─────────────────────────────────────────
// `seasonState` mirrors the sentinel api_usage row:
// sport -> { first, last, in, quiet, obs }.
//   first — the day this sport was first observed by this mechanism (the seeding
//           day; the clock starts at deploy, not at the sport's real death —
//           no per-sport activity date is persisted anywhere today);
//   last  — the last day /sports reported it active, or null if never;
//   in    — the membership we last published, kept only so a CHANGE can be
//           logged once instead of every run;
//   quiet — THE RELEASE CLOCK: how many consecutive days we have LOOKED and seen
//           this sport absent. Zeroed by any active observation. This, not the
//           calendar, is what releases a sport, so an outage (or an exhausted
//           month, or a dead process) cannot age one out while nothing watches;
//   obs   — the day `quiet` last counted, so the ~20 runs an hour count once.
// `quiet`/`obs` are what make the decision AUDITABLE: /budget's season block and
// the sentinel row both carry them, so "released after 15 quiet days we actually
// observed" is readable rather than inferred from a date subtraction.
let seasonState = {};
// Sentinel row, not a new table: `unique (provider, month)` already exists in
// the live DB (the odds budget upserts on it and persists across restarts), so
// there is nothing to hand-run — the D70/D73 failure mode.
const SEASON_ROW = { provider: 'odds-season', month: 'state' };
// Read per call, not frozen at boot — same reason footballPriorityOn is a
// function: the grace is config, and a test (or a long-running process) must be
// able to see the configured value rather than whichever one was live at import.
// `?? 14` only covers a config object that predates the knob; config itself
// reads it through intEnv, so 0 arrives here as 0.
const graceDays = () => oddsApi.seasonGraceDays ?? 14;
// The last published season block, for /budget. Null until a run publishes one.
let lastSeason = null;
// Consecutive failed sentinel writes, and the streak at which a silent failure
// becomes a loud one — see persistBudget.
let seasonWriteFailRuns = 0;
const SEASON_WRITE_FAIL_RUNS = 3;
const SEASON_WRITE_KEY = 'odds|season-state';

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Whole UTC calendar days between two YYYY-MM-DD strings. Never negative: a
// future stamp (clock skew, a hand-edited row) reads as "today", which is the
// tight direction — it keeps the sport in.
function ageDays(from, today) {
  if (!DAY_RE.test(from || '') || !DAY_RE.test(today || '')) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// The season rules, as a PURE function so the behaviour can be driven without
// run(): `now` and `activeKeys` are both parameters, so a season boundary is
// simulated deterministically rather than waited for.
//
// `activeKeys === null` means the /sports read FAILED (non-200, throw, DNS). We
// then write NOTHING and hold every sport in. Not writing is the load-bearing
// half: refreshing `last` on an unreadable feed would silently extend a dead
// sport's season by another full grace window, forever, on a flaky network.
//
// `reason` is drawn from a closed set of authored strings and is never
// interpolated from env or from an API payload (D80):
//   active-now · grace (Nd ago) · seeding (Nd left) · released (Nd idle) ·
//   football-backstop · feed-unreadable · billed (event-only sport) ·
//   skip (ODDS_SKIP_SPORTS)
export function seasonVerdicts(activeKeys, state, sports, now, graceDays, footballOn) {
  const today = dayKey(now);
  const verdicts = {};
  const nextState = { ...(state || {}) };
  const transitions = [];
  const football = oddsApi.footballSports || [];
  // An EMPTY active set is not a credible board, so it is folded into the
  // unreadable path rather than believed. `new Set()` is truthy, so a 200 with a
  // body of `[]` — or every item failing an upstream rename of the `active`
  // field — used to walk straight past the `!activeKeys` fail-safe and be
  // accepted as evidence that nothing on earth is in season, which releases the
  // entire table one grace window later. We cannot tell "the board is genuinely
  // empty" from "the board is unreadable", and only one of those two readings is
  // survivable, so we take that one.
  const readable = !!activeKeys && activeKeys.size > 0;
  for (const [sport, meta] of Object.entries(sports)) {
    // oddsSkip sports (TENNIS, GOLF) have no bare Odds API key, never appear in
    // `active`, and are deliberately outside the sweep (D64/D65). They are
    // neither `in` nor `out` here: they can still enter the denominator via
    // spend, exactly as they do today, and `out` is what would block that.
    if (meta.oddsSkip) {
      verdicts[sport] = { in: false, out: false, reason: 'skip (ODDS_SKIP_SPORTS)', last: null, first: null };
      continue;
    }
    const prev = (state || {})[sport];
    if (!readable) {
      verdicts[sport] = {
        in: true, out: false, reason: 'feed-unreadable',
        last: (prev && prev.last) || null, first: (prev && prev.first) || null,
      };
      continue;
    }
    const activeNow = (meta.leagues || [meta.key]).some((k) => activeKeys.has(k));
    // A malformed stamp reseeds rather than being parsed loosely — seeding holds
    // the sport in for a full grace window, which is tight. BOTH stamps have to
    // be judged, not just `first`: a half-written row like
    // `{first:'2026-09-06', last:'2026-11'}` (a truncated by_sport jsonb) used to
    // take the seeded branch, throw the unparseable `last` away as null, and then
    // date the release clock from `first` — releasing a sport on the spot, and
    // every quiet sport in the table in one run, which is the opposite of what
    // the comment above claimed. An ABSENT `last` is legitimate (never seen
    // active); a present-but-unparseable one is a row we cannot read.
    const firstOk = !!prev && DAY_RE.test(prev.first || '');
    const lastOk = !!prev && (prev.last == null || DAY_RE.test(prev.last));
    const seeded = firstOk && lastOk;
    // The release clock is a COUNT OF OBSERVATIONS, so every field it reads is
    // validated before it is trusted: a non-integer `quiet` reads as 0 (tight —
    // it holds the sport in), and an `obs` we cannot parse reads as "today was
    // already counted" (also tight, and self-healing on the next day).
    const prevQuiet = (seeded && Number.isInteger(prev.quiet) && prev.quiet >= 0) ? prev.quiet : 0;
    const countedToday = seeded && !(DAY_RE.test(prev.obs || '') && prev.obs !== today);

    let entry;
    if (!seeded) {
      // Seeding. The seeding day is itself a quiet day for a sport we have never
      // seen active — which is what makes graceDays=0 release such a sport on
      // its first run, the boundary-on-demand the manual recipe uses.
      entry = { first: today, last: activeNow ? today : null, quiet: activeNow ? 0 : 1, obs: today };
    } else if (activeNow) {
      entry = { first: prev.first, last: today, quiet: 0, obs: today };
    } else {
      entry = {
        first: prev.first, last: prev.last ?? null,
        quiet: countedToday ? prevQuiet : prevQuiet + 1, obs: today,
      };
    }

    let inSeason;
    let reason;
    if (activeNow) {
      inSeason = true;
      reason = 'active-now';
    } else {
      // `idle` is CALENDAR days since the last positive signal (or since
      // seeding) and is reported, not decided on. `entry.quiet` is the decision:
      // days we actually observed the sport absent.
      const idle = ageDays(entry.last || entry.first, today) ?? 0;
      // Release needs the observed count past the window AND the calendar to
      // agree. The calendar half is near-redundant — a quiet day is a distinct
      // calendar day, so `quiet > graceDays` already implies `idle >= graceDays`
      // whenever the row is self-consistent — and it is kept precisely for the
      // rows that are NOT: a hand-edited or corrupted `quiet` cannot release a
      // sport whose last active day is yesterday. It is a secondary condition
      // only; the primary is the observation count.
      if (entry.quiet <= graceDays || idle < graceDays) {
        inSeason = true;
        // Clamped: the secondary calendar condition can hold an inconsistent
        // row in past its observed count, and a reason string is a closed set
        // of authored shapes (D80) — `seeding (-1d left)` is not one of them.
        reason = entry.last
          ? `grace (${idle}d ago)`
          : `seeding (${Math.max(0, graceDays - (entry.quiet - 1))}d left)`;
      } else {
        inSeason = false;
        reason = `released (${idle}d idle)`;
      }
    }
    // D6's football priority, generalised but not dropped. The grace window now
    // gives every sport the protection football was given by hand, so this term
    // is redundant — and it stays anyway, demoted to a labelled backstop. It
    // costs nothing (it only ever holds a sport IN, the tight direction), and if
    // /sports ever reports football inactive for a whole grace window it is the
    // only thing between us and D6's measured failure.
    if (!inSeason && footballOn && football.includes(sport)) {
      inSeason = true;
      reason = 'football-backstop';
    }
    entry.in = inSeason;
    nextState[sport] = entry;
    verdicts[sport] = { in: inSeason, out: !inSeason, reason, last: entry.last, first: entry.first };
    // Only a CHANGE is a transition. A fresh entry is not one: seeding is this
    // mechanism meeting the sport, not the sport's season moving.
    if (prev && typeof prev.in === 'boolean' && prev.in !== inSeason) {
      transitions.push({ sport, in: inSeason, reason, share: oddsApi.allocation[sport] ?? 0.05 });
    }
  }
  return { verdicts, nextState, transitions };
}

// Denominator = { in-season } ∪ { has spent this month AND not released }.
//
// The second term is what keeps oddsSkip sports entering exactly as they do
// today, and `&& !out` is the whole fix: `billed` alone put any sport with a
// single credit into the denominator for the rest of the month and never took it
// out, which is what held MLB's 0.14 through November (D86).
export function seasonDenominator(verdicts, bySport) {
  const season = {};
  const denom = [];
  for (const [sport, v] of Object.entries(verdicts)) {
    let inDenom = v.in;
    let reason = v.reason;
    if (!inDenom && !v.out && (bySport || {})[sport] > 0) {
      inDenom = true;
      reason = 'billed (event-only sport)';
    }
    season[sport] = { in: inDenom, reason, last: v.last || null, first: v.first || null };
    if (inDenom) denom.push(sport);
  }
  return { denom, season };
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
  // The season sentinel is month-independent (`month: 'state'`) — a month
  // rollover must not reset a sport's season clock. A failed read leaves it
  // `{}`, which reseeds every sport and so holds every sport in: tight.
  try {
    const rows = await db.select('api_usage', '*', { match: SEASON_ROW });
    if (rows[0] && rows[0].by_sport && typeof rows[0].by_sport === 'object') seasonState = rows[0].by_sport;
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
  // Separate try/catch and written second: a sentinel failure must never cost
  // us the month's credit counter, which is the row that matters.
  //
  // But swallowing the error outright was this repo's signature failure, and
  // here it is the worst version of it: with no sentinel row the state resets
  // every process, every sport reseeds forever, and the ONLY symptom is /budget
  // reading `seeding (Nd left)` — which the manual check recipe tells the
  // operator to EXPECT on day 1. An RLS change on api_usage would disable the
  // whole feature while looking exactly like a successful deploy.
  //
  // So a sustained failure announces itself, by the same mechanism #137 used for
  // a persistently-blocked agent: count the consecutive failures, and past a
  // threshold report it as a degradation and log it at warn. The threshold is
  // not 1 because a single upsert failure is a transient the next run (3 min)
  // fixes, and an alert channel that fires on transients is one nobody reads
  // (D80). One success clears it — unconditionally, since an unretracted
  // reportDegraded latches for its full TTL and goes on repeating an obsolete
  // reason (D73).
  try {
    await db.upsert('api_usage', {
      ...SEASON_ROW, used: 0, budget: 0, by_sport: seasonState,
      updated_at: new Date().toISOString(),
    }, 'provider,month');
    if (seasonWriteFailRuns > 0) {
      logger.info('odds', `season state persisted again after ${seasonWriteFailRuns} failed write(s)`);
    }
    seasonWriteFailRuns = 0;
    clearDegraded(SEASON_WRITE_KEY);
  } catch (e) {
    seasonWriteFailRuns++;
    if (seasonWriteFailRuns >= SEASON_WRITE_FAIL_RUNS) {
      const detail = `season state has failed to persist for ${seasonWriteFailRuns} consecutive runs (${e.message}) — the release clock cannot survive a restart and every sport will reseed forever, which reads as a healthy day 1`;
      reportDegraded(SEASON_WRITE_KEY, detail);
      logger.warn('odds', detail);
    }
  }
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
// The FULL post-tip tail: a sport in `oddsApi.liveSports` stays on STRIKE/NEAR
// this long after a game starts, because something is reading those rows.
// Also the CEILING on the short tail below — it is the longest window this
// agent has ever polled, so a NON-live sport asking for more than it is a typo
// rather than a policy, and `tier > fullTier` cannot report that either: a
// tail wider than the full tail lowers no tier, so the demotion segment would
// read 0 at exactly the moment the spend went up.
const FULL_TAIL_MIN = 3.5 * 60;
const FULL_TAIL_MS = FULL_TAIL_MIN * 60_000;
// How long a sport with NO live in-play consumer stays on STRIKE/NEAR AFTER a
// game has started. The env knob is read in config through intEnv — the one
// reader that cleans before it coerces, so `ODDS_POSTTIP_MIN='  '` is unset
// and not a finite 0 — and `0` is a legitimate setting there ("drop the moment
// a game tips"). The `?? 45` is the mocked-config path only (the odds tests
// mock.module the WHOLE config object, so a new key is absent there), exactly
// like `liveSports ?? []`; the real default lives in config. Read per call, so
// a config change needs no restart.
const POSTTIP_FALLBACK_MIN = 45;
let clampWarned = false;
function postTipTailMin() {
  const raw = oddsApi.postTipMin ?? POSTTIP_FALLBACK_MIN;
  // Defence in depth: config already rejects negatives and non-integers, but
  // a mocked or hand-built config could hand us either, and a negative tail
  // would invert the window onto PRE-tip games (D107). Non-numeric → fallback.
  const asked = Number.isFinite(raw) ? Math.max(0, raw) : POSTTIP_FALLBACK_MIN;
  if (asked <= FULL_TAIL_MIN) return asked;
  if (!clampWarned) {
    clampWarned = true;
    logger.warn('odds', `ODDS_POSTTIP_MIN is longer than the full post-tip tail — clamped to ${FULL_TAIL_MIN} min`);
  }
  return FULL_TAIL_MIN;
}
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
//
// ── The post-tip tail, and who actually reads it (D102) ──
// The tail used to be an unconditional -3.5h for every sport: a game stayed
// "live" for three and a half hours after kickoff, so the last tip of a night
// held its whole league on STRIKE (4 min) until ~3.5h later. The sports with a
// real in-play consumer need that; the rest do not, and the arithmetic is
// lopsided — most of those fetches land after every consumer has stopped
// looking.
//
// What genuinely reads post-tip rows, measured rather than assumed:
//   book-move      — reads a -3h slate and scores started games; its FRESHEST
//                    post-tip rows are the ones that matter.
//   sharp          — same -3h slate, and its steam verdict needs three books
//                    inside a 35-min window, so it needs the rows to KEEP
//                    arriving for a while after a tip.
//   clv-tracker    — bounds its close at `commence_time`; a post-tip row can
//                    never be its close.
//   nfl-line-move  — happy path closes at -30m PRE-tip.
// So 45 minutes is not "nothing reads post-tip" — it is exactly the span
// book-move's freshest started games and one of sharp's 35-min steam windows
// need. What drops is the ~2h45m tail beyond it, which no consumer above can
// use. Sports in `liveSports` (NFL when NFL_LIVE is on) keep the full -3.5h.
//
// What the shortening COSTS, stated because it is paid and not free: past the
// tail a started non-live game sits at MID/IDLE × the governor, i.e. gaps of
// 45-720 minutes, every one of them beyond STEAM_MAX_GAP_MIN — so post-tip
// steam is undetectable for those sports by construction. `sharp` reports that
// as its own summary segment rather than letting it read as a quiet market
// (D107); see the STEAM_MAX_GAP_MIN comment below.
//
// Pre-tip behaviour is byte-identical: the three dt bands below are the same
// mutually exclusive bands as before (dt <= 30m, 30m < dt <= 90m, dt <= 12h),
// and only the NEGATIVE edge of the FIRST moved — the second band is entirely
// pre-tip (dt > 30m), which is why it carries no tail test at all.
//
// `lowered` is an optional Map the caller passes to collect the sports whose
// tier this rule actually demoted on this run, each against the tier it landed
// at — reported, because a cadence that quietly halved itself must not look
// like a cadence nobody changed, and "how slow did it get" belongs on /health
// rather than in arithmetic over four cadence knobs and an unseen governor.
//
// How a demoted sport is NAMED: the tier it landed at, with the governor
// multiplier when one applies (the governor touches MID/IDLE only, so a NEAR
// landing never carries one).
function tierLabel(tier, mult) {
  const name = ['STRIKE', 'NEAR', 'MID', 'IDLE'][tier] || String(tier);
  return tier >= 2 && mult > 1 ? `${name}×${mult}` : name;
}

export function sportIntervalMin(sport, mult, lowered = null) {
  const now = Date.now();
  // `?? []` and not `.includes` straight off the config: the odds tests
  // mock.module the WHOLE config object, so a new key is absent there.
  const tailMs = (oddsApi.liveSports ?? []).includes(sport) ? FULL_TAIL_MS : postTipTailMin() * 60_000;
  let tier = 3;      // 3 idle · 2 mid · 1 near · 0 strike
  let fullTier = 3;  // the tier the old unconditional -3.5h tail would have given
  for (const g of getGames()) {
    if (g.sport !== sport) continue;
    const t = Date.parse(g.commence_time || '');
    if (!Number.isFinite(t)) continue;
    const dt = t - now;
    if (dt <= 30 * 60_000) {                                     // live or <30m — fastest, protected
      if (dt >= -tailMs) { tier = 0; fullTier = 0; break; }
      if (dt >= -FULL_TAIL_MS) fullTier = 0;
    } else if (dt <= 90 * 60_000) {
      // 30m < dt <= 90m, so dt is POSITIVE: a started game is always dt <= 30m
      // and was handled above. There is no post-tip case in this arm, which is
      // why neither tier is conditioned on a tail here — the two `dt >= -tail`
      // guards this used to carry were vacuously true and read as if NEAR had
      // a post-tip window of its own.
      tier = Math.min(tier, 1); fullTier = Math.min(fullTier, 1);
    } else if (dt <= 12 * 3600_000) {
      tier = Math.min(tier, 2); fullTier = Math.min(fullTier, 2);
    }
  }
  if (lowered && tier > fullTier) lowered.set(sport, tierLabel(tier, mult));
  if (tier === 0) return STRIKE_MIN;
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
// conflated as a rehydrated one.
//
// That rule was written when a STARTED game could not reach a governed tier:
// the post-tip tail was an unconditional -3.5h, so every in-play row arrived
// at STRIKE (4) or NEAR (10) and sailed through this bound. Since D102 it does
// not. Past the short tail a started game in a sport outside `liveSports` sits
// at MID or IDLE × the governor — gaps of 45 to 720 minutes — so EVERY row
// it produces is beyond this bound, and post-tip steam for those sports is
// undetectable by construction. The bound is still right (a 45-minute gap
// genuinely cannot prove simultaneity, and widening it to admit the governed
// tiers would be exactly the D77 conflation it exists to prevent); what
// changed is that the blindness is now a DESIGNED state rather than an
// impossible one, so `sharp` counts and names those rows instead of printing
// `0 steam` over them (D107).
//
// `line_movements` still records every row at full detail, and `movementsAll`
// publishes every row in memory; this filters only the steam feed. `sharp` applies this same bound to its own union of
// history and memory, so it is safe against any other producer (D92).
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
      // The in-memory row must carry the same interval the Postgres row does.
      detected_at: new Date(nowMs).toISOString(),
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
//
// Nobody reads the inserted rows back, so ask for the minimal return (see
// db.insert) rather than making the server aggregate them inside the timed
// statement.
const MINIMAL = { returning: 'minimal' };
async function insertMovements(rows) {
  const stripped = () => rows.map(({ gap_min, baseline_source, ...rest }) => rest);
  if (!extraCols) return db.insert('line_movements', stripped(), MINIMAL);
  try { return await db.insert('line_movements', rows, MINIMAL); }
  catch (e) {
    if (!isMissingColumn(e)) throw e;
    extraCols = false;
    logger.warn('odds', `line_movements is missing gap_min/baseline_source — run the alter table lines in scripts/schema.sql; writing without them for now (${e.message})`);
    const res = await db.insert('line_movements', stripped(), MINIMAL);
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

// ── The snapshot write, chunked ─────────────────────────────────
// A busy slate builds ~4,800 snapshot rows a run, and `db.insert` of the whole
// array is ONE PostgREST statement into a 7M-row table with four btree indexes
// to maintain per row (the random-placement uuid PK is the expensive one).
// Under evening load that statement exceeded the 8s statement_timeout (57014,
// server-side), Postgres rolled back the WHOLE batch, and the warn-only catch
// below was the only trace: 15 of 60 runs in the 7-10pm ET window lost every
// snapshot they took, while the summary went on reading "4800 snapshots".
//
// Chunk size: the failures were observed at ~1.67 ms/row (8s / 4,800), so 500
// rows is ~0.8s a chunk; 5x worse than that is still 4s, inside the 8s timeout
// with margin. Chunks are written SERIALLY, not Promise.all: parallel chunks
// contend for the same pool connections and the same hot index pages, which is
// the load that produced the timeout in the first place. Env-overridable so a
// test can drive the size-dependent failure with a small batch.
//
// The knob is a loop STEP, so it is sanitized harder than the other `Number(env)
// || default` knobs: a negative value (`-5`) is `i += -5` — the loop never
// terminates, the odds agent hangs, and the orchestrator awaits odds before
// every other agent; a fractional one (`0.5`) emits empty chunks and visits
// rows twice. Anything that is not a whole number ≥ 1 collapses to the default.
const SNAPSHOT_CHUNK = (() => {
  const n = Math.floor(Number(process.env.ODDS_SNAPSHOT_CHUNK));
  return Number.isFinite(n) && n >= 1 ? n : 500;
})();
const SNAPSHOT_WRITE_KEY = 'write|line_snapshots';
const isStatementTimeout = (e) => e?.code === '57014';

// Writes `rows` in SNAPSHOT_CHUNK pieces and reports what actually landed.
// A chunk that times out is retried once — a timeout is load, not a fault in
// the rows — and a retry that succeeds retracts the degradation the failed
// first attempt fired (D73: a false `write|line_snapshots` alarm standing for
// the full TTL while every row lands is how that channel becomes noise). A
// chunk that fails twice, or fails for any other reason, is counted LOST and
// the next chunk is still attempted: partial data honestly reported beats an
// all-or-nothing batch.
async function insertSnapshots(rows) {
  const out = { written: 0, lost: 0, timeouts: 0, retried: 0, error: null };
  for (let i = 0; i < rows.length; i += SNAPSHOT_CHUNK) {
    const chunk = rows.slice(i, i + SNAPSHOT_CHUNK);
    try {
      await db.insert('line_snapshots', chunk, MINIMAL);
      out.written += chunk.length;
      continue;
    } catch (e) {
      if (!isStatementTimeout(e)) { out.lost += chunk.length; out.error = e; continue; }
      out.timeouts++;
    }
    try {
      await db.insert('line_snapshots', chunk, MINIMAL);
      out.written += chunk.length;
      out.retried++;
    } catch (e) {
      if (isStatementTimeout(e)) out.timeouts++;
      out.lost += chunk.length;
      out.error = e;
    }
  }
  // The retraction is decided for the RUN, not per chunk: a chunk lost for
  // good earns the alarm, and a later chunk landing on retry must not take it
  // back. Clearing inside the loop did exactly that — chunk 3 lost twice, chunk
  // 7 recovered, alarm gone, 500 rows missing with nothing standing for the
  // watchdog. Only a run in which every row landed may call its alarm false.
  if (out.retried && !out.lost) clearDegraded(SNAPSHOT_WRITE_KEY);
  return out;
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

// Free, non-billed endpoint: which sports are currently in season. `null` means
// WE DO NOT KNOW — non-200, a throw, a body we cannot read, and also a body that
// yields NO active keys at all. That last one is the point: an empty Set is
// truthy, so a 200 carrying `[]`, or a payload whose `active` field has been
// renamed upstream, used to be handed on as a confident "nothing is in season"
// and would release the whole table a grace window later. Zero active leagues
// across twelve sports has never been a real board; it is a broken read, and the
// only survivable reading of a broken read is that we did not get one.
async function inSeasonKeys() {
  try {
    const res = await fetch(`${oddsApi.base}/sports?apiKey=${oddsApi.key}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    const keys = new Set(data.filter((s) => s && s.active).map((s) => s.key));
    return keys.size ? keys : null;
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

  // THE SEASON OBSERVATION COMES FIRST, BEFORE THE BUDGET GATE BELOW.
  // /sports is free, so an exhausted month is no reason to stop watching — and
  // watching is now what moves the release clock. The other order was the whole
  // bug: `return`ing above this made the agent blind for the ~17 days a month
  // that demand at 2.3x the pool (D87) leaves exhausted, while a calendar-aged
  // clock kept running, so the next month's first run met a table of sports
  // ~18 days idle and released all of them on one observation. On the free tier
  // (500 credits) that happened within hours of day 1, every month.
  const footballOn = oddsApi.footballPriorityOn();
  const active = await inSeasonKeys(); // null = couldn't determine, fetch anyway
  // Membership is DERIVED — see the header. Today's flag no longer decides it
  // on its own: entry is immediate, release takes graceDays() consecutive
  // OBSERVED quiet days, and the football month range survives inside
  // seasonVerdicts as a labelled backstop rather than as the only such
  // protection.
  const { verdicts, nextState, transitions } = seasonVerdicts(
    active, seasonState, SPORTS, new Date(), graceDays(), footballOn,
  );
  seasonState = nextState;
  const { denom, season } = seasonDenominator(verdicts, budget.bySport);
  lastDenom = denom;                       // so hasOddsBudget sees the same ceiling
  lastSeason = season;                     // so /budget can report WHY, not just who
  for (const t of transitions) {
    const share = Math.round(t.share * 100) / 100;
    logger.info('odds', t.in
      ? `season: ${t.sport} back in the denominator (${t.reason}) — share ${share} now priced in`
      : `season: ${t.sport} released (${t.reason}) — share ${share} returned to the pool`);
  }
  const released = Object.entries(verdicts).filter(([, v]) => v.out).map(([s]) => s);
  const denomBit = `denom ${denom.length}/${Object.keys(SPORTS).length} (${denom.join(', ') || 'none'})${released.length ? `; released ${released.join(', ')}` : ''}`;

  if (budget.remaining <= 0) {
    // Persisted anyway: the observation above is only worth making if it
    // survives the restart, and this is the path a starved month spends most of
    // its days on.
    await persistBudget();
    return { summary: `budget exhausted for ${budget.month} (${budget.used}/${oddsApi.monthlyBudget}) — skipping, still watching · ${denomBit}` };
  }

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
  const isFootball = (sport) => oddsApi.footballSports.includes(sport);
  // Two ways a ceiling moves wrongly, both from the denominator changing mid-month:
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
  //
  // What CHANGED: the denominator is no longer monotonic within a month. It is
  // monotonic within a GRACE WINDOW instead — `billed` can still only add a
  // sport, but a sport the season signal has RELEASED leaves even if it has
  // spent, which is the only thing that ever returns a dead share to the pool.
  // Departures are therefore possible again, and are rate-limited to one per
  // sport per grace window by construction (any active observation zeroes the
  // quiet counter), which is what distinguishes this from the September bug.
  // Both are computed ABOVE the budget gate — see the top of run().
  //
  // A sport outside the denominator is priced as if it were in it, which is the
  // D65 branch-2 shape. It must NOT fall back to an unnormalised `budget × share`
  // — that handed a RELEASED sport a LOOSER ceiling for being out of season.
  const capOf = (sport) => Math.max(
    budget.bySport[sport] || 0,
    nominalCap(sport, denom.includes(sport) ? denom : [...denom, sport]),
  );

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
  // Sports whose cadence the shortened post-tip tail demoted on THIS run
  // (D102) — a tier change nobody can see is a tier change nobody can audit.
  // sport -> the tier it landed at ('MID×4'), so the report says how slow it
  // got and not only how many sports it happened to (D107).
  const postTipTail = new Map();

  for (const [sport, meta] of Object.entries(SPORTS)) {
    // The Odds API has no bare golf/tennis key (event-specific only) — skip to avoid 404s.
    if (meta.oddsSkip) continue;
    const keys = meta.leagues || [meta.key];
    // Per-sport monthly cap (in credits).
    if ((budget.bySport[sport] || 0) >= capOf(sport)) { skippedBudget++; continue; }
    if (spendable(sport) <= 0) { skippedFootballFloor++; continue; }
    // How often this sport's keys deserve a refresh right now (governor applies
    // to mid/idle only; strike/near stay fast).
    const ivMs = sportIntervalMin(sport, mult, postTipTail) * 60_000;

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
  // `snapshotsWritten` is what LANDED; `snapshots.length` is what was built.
  // The two were the same number in the summary for as long as this write was
  // one statement, which is how a run that persisted nothing read as healthy.
  let snapshotsWritten = 0;
  let snapshotsLost = 0;
  if (snapshots.length) {
    const w = await insertSnapshots(snapshots);
    snapshotsWritten = w.written;
    snapshotsLost = w.lost;
    if (w.lost) {
      // Error, not warn: a warn in a 100-entry ring buffer is how this went
      // unnoticed for 15 runs. The degradation fired by db.insert stands.
      logger.error('odds', `snapshot write: ${w.lost}/${snapshots.length} rows lost${w.timeouts ? ` after ${w.timeouts} statement timeout(s) (chunk ${SNAPSHOT_CHUNK}, retried once)` : ''} — ${w.error?.message}`);
    } else if (w.retried) {
      logger.warn('odds', `snapshot write: ${w.retried} chunk(s) timed out once and landed on retry (chunk ${SNAPSHOT_CHUNK})`);
    }
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
  // `denomBit` (built above the budget gate) names the denominator and the
  // sports the season signal has released, every run and not only on the
  // transition: the denominator was previously unknowable from anywhere but a
  // model of it (D88), which is why November's analysis had to be inferred.
  const baselineBit = `baseline ${hydr.games}/${hydr.attempted} games → ${hydr.keys} keys rehydrated${hydr.failures ? `, ${hydr.failures} read failures` : ''}, ${stats.staleBaseline} stale-baseline${hydrateFailRuns >= HYDRATE_FAIL_RUNS ? `, reads circuit-broken after ${hydrateFailRuns} failed runs` : ''}${steamDropped ? `, ${steamDropped} too wide for steam` : ''}`;

  return {
    summary: `${allGames.length} games, ${snapshots.length} snapshots (${snapshotsWritten} written${snapshotsLost ? `, ${snapshotsLost} lost` : ''}), ${movements.length} movements · ${baselineBit} · ${calls} calls${skippedPaced ? `, ${skippedPaced} paced` : ''}${mult > 1 ? ` (throttle ×${mult})` : ''} · ${postTipTail.size} sports post-tip tail${postTipTail.size ? ` (${[...new Set(postTipTail.values())].join(', ')})` : ''} · credits ${budget.used}/${oddsApi.monthlyBudget} (${budget.remaining} left)${skippedBudget ? `, ${skippedBudget} budget-skips` : ''}${skippedFootballFloor ? `, ${skippedFootballFloor} held for football (floor ${footballFloor})` : ''} · ${denomBit}`,
    gamesMonitored: allGames.length,
    data: {
      games: allGames.length, snapshots: snapshots.length, movements: movements.length, calls,
      // `snapshots` is built, `snapshotsWritten` is persisted. A loss is the
      // difference, named here so a run that lost its batch cannot be read as
      // one that landed it.
      snapshotsWritten, snapshotsLost,
      // `rehydratedKeys` is keys, `rehydratedGames` is games — never compare
      // either against `games` above without knowing which is which.
      rehydratedKeys: hydr.keys, rehydratedGames: hydr.games,
      hydrateAttempted: hydr.attempted, hydrateFailures: hydr.failures,
      staleBaseline: stats.staleBaseline,
      // `movements` is what was written; `steamFeed` is what sharp can see.
      steamFeed: steamFeed.length, steamDropped, hydrateFailRuns,
      // The sports the shortened post-tip tail demoted this run — names, not a
      // count, so "which league stopped being polled" is answerable (D102) —
      // plus the tier each one landed at, so "how slow is it now" is
      // answerable without re-deriving it from the cadence knobs (D107).
      postTipTail: [...postTipTail.keys()],
      postTipTailTier: Object.fromEntries(postTipTail),
      budget: getOddsBudget(),
    },
  };
}

export default { name: 'odds', run };
