// ══════════════════════════════════════════════════════════════
// Odds Ingestion — pulls odds from The Odds API for every in-season
// sport, normalizes them, snapshots to line_snapshots, detects line
// movements, and publishes games to the pipeline store.
//
// Budgeting: the free tier is 500 requests/month. We persist a
// running counter in `api_usage`, allocate the monthly budget by
// sport (MLB 40%, NBA/NHL 20% each, the rest split 20%), and skip
// sports that are out of season or have no games today.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setGames, setIntel } from '../../store/index.js';
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
// hasOddsBudget — the core loop publishes it instead (every 3 min).
let lastDenom = null;
export function currentCeiling(sport) {
  if (!lastDenom || !lastDenom.includes(sport)) return sportCap(sport);
  // Never below what the sport has already spent, matching the core loop: an
  // arrival mid-month stops granting headroom rather than retroactively
  // stranding a sport that is already past the new nominal.
  return Math.max(budget.bySport[sport] || 0, nominalCap(sport, lastDenom));
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

// ── In-memory last-line map for movement detection ──────────────
const lastLines = new Map(); // key -> { line, price }

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
function normalize(sport, ev, snapshots, movements) {
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
        const prev = lastLines.get(key);
        if (prev && prev.line != null && line != null && prev.line !== line) {
          movements.push({
            sport, game_id: ev.id, market: mk.key, book: bookKey, side,
            line_open: prev.line, line_current: line, moved: Math.round((line - prev.line) * 10) / 10,
            price_open: prev.price, price_current: price,
            direction: line > prev.line ? 'up' : 'down',
          });
        }
        lastLines.set(key, { line, price });
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
        for (const ev of games) allGames.push(normalize(sport, ev, snapshots, movements));
      } catch (e) {
        logger.warn('odds', e.message);
        // Count the spend even on error (the request was made), reconcile loosely.
        recordSpend(sport, null);
        lastKeyFetch.set(key, Date.now());
      }
    }
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

  // Persist snapshots + movements + budget; publish games to the store.
  if (snapshots.length) {
    try { await db.insert('line_snapshots', snapshots); } catch (e) { logger.warn('odds', `snapshot write: ${e.message}`); }
  }
  if (movements.length) {
    try { await db.insert('line_movements', movements); } catch (e) { logger.warn('odds', `movement write: ${e.message}`); }
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
  setIntel('movements', movements);

  return {
    summary: `${allGames.length} games, ${snapshots.length} snapshots, ${movements.length} movements · ${calls} calls${skippedPaced ? `, ${skippedPaced} paced` : ''}${mult > 1 ? ` (throttle ×${mult})` : ''} · credits ${budget.used}/${oddsApi.monthlyBudget} (${budget.remaining} left)${skippedBudget ? `, ${skippedBudget} budget-skips` : ''}${skippedFootballFloor ? `, ${skippedFootballFloor} held for football (floor ${footballFloor})` : ''}`,
    gamesMonitored: allGames.length,
    data: { games: allGames.length, snapshots: snapshots.length, movements: movements.length, calls, budget: getOddsBudget() },
  };
}

export default { name: 'odds', run };
