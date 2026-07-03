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
export function hasOddsBudget(reserve = 0) {
  if (!budget.loaded) return true;
  return budget.remaining > reserve;
}

function sportCap(sport) {
  const alloc = oddsApi.allocation[sport] ?? 0.05;
  return Math.floor(oddsApi.monthlyBudget * alloc);
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
function recordSpend(sport, hdr) {
  const cost = hdr && Number.isFinite(+hdr.last) ? Math.max(1, Math.round(+hdr.last)) : 3;
  budget.used += cost;
  budget.bySport[sport] = (budget.bySport[sport] || 0) + cost;
  if (hdr && Number.isFinite(+hdr.used)) budget.used = Math.max(budget.used, Math.round(+hdr.used));
  if (hdr && Number.isFinite(+hdr.remaining)) budget.remaining = +hdr.remaining;
  else budget.remaining = Math.max(0, oddsApi.monthlyBudget - budget.used);
}

// ── Adaptive pacing: fetch fast only when it matters ─────────────
// A key is fetched on a cadence set by how close its sport's games are:
//   NEAR (a game is live or starts within 60m) → every 10 min
//   MID  (a game starts within 12h)            → every 30 min
//   IDLE (nothing near)                        → every 3h (slate discovery)
// On top, a pace governor stretches every interval when the month's burn is
// ahead of linear pace — self-correcting toward the monthly budget.
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

function sportIntervalMin(sport) {
  const now = Date.now();
  let best = IDLE_MIN;
  for (const g of getGames()) {
    if (g.sport !== sport) continue;
    const t = Date.parse(g.commence_time || '');
    if (!Number.isFinite(t)) continue;
    const dt = t - now;
    if (dt <= 60 * 60_000 && dt >= -4 * 3600_000) return NEAR_MIN; // live or <60m out
    if (dt > 0 && dt <= 12 * 3600_000) best = Math.min(best, MID_MIN);
  }
  return best;
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
  // out-of-season budget sits idle. 15% held back for the event-endpoint
  // consumers (props, tennis, derivatives).
  const isActive = (sport, meta) => {
    if (meta.oddsSkip) return false;
    if (!active) return true;
    return (meta.leagues || [meta.key]).some((k) => active.has(k));
  };
  const actives = Object.entries(SPORTS).filter(([s, m]) => isActive(s, m)).map(([s]) => s);
  const sumAlloc = actives.reduce((t, s) => t + (oddsApi.allocation[s] ?? 0.05), 0) || 1;
  const capOf = (sport) => (actives.includes(sport)
    ? Math.floor(oddsApi.monthlyBudget * 0.85 * ((oddsApi.allocation[sport] ?? 0.05) / sumAlloc))
    : sportCap(sport));
  const mult = paceMult();

  for (const [sport, meta] of Object.entries(SPORTS)) {
    // The Odds API has no bare golf/tennis key (event-specific only) — skip to avoid 404s.
    if (meta.oddsSkip) continue;
    const keys = meta.leagues || [meta.key];
    // Per-sport monthly cap (in credits).
    if ((budget.bySport[sport] || 0) >= capOf(sport)) { skippedBudget++; continue; }
    // How often this sport's keys deserve a refresh right now.
    const ivMs = sportIntervalMin(sport) * mult * 60_000;

    for (const key of keys) {
      if (active && !active.has(key) && key !== 'golf' && key !== 'tennis') { skippedSeason++; continue; }
      if (budget.remaining <= 0) { skippedBudget++; break; }
      if ((budget.bySport[sport] || 0) >= capOf(sport)) { skippedBudget++; break; }
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
    summary: `${allGames.length} games, ${snapshots.length} snapshots, ${movements.length} movements · ${calls} calls${skippedPaced ? `, ${skippedPaced} paced` : ''}${mult > 1 ? ` (throttle ×${mult})` : ''} · credits ${budget.used}/${oddsApi.monthlyBudget} (${budget.remaining} left)${skippedBudget ? `, ${skippedBudget} budget-skips` : ''}`,
    gamesMonitored: allGames.length,
    data: { games: allGames.length, snapshots: snapshots.length, movements: movements.length, calls, budget: getOddsBudget() },
  };
}

export default { name: 'odds', run };
