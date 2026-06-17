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
import { setGames, setIntel } from '../../store/index.js';
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
  return {
    tier: oddsApi.tier,
    month: budget.month,
    budget: oddsApi.monthlyBudget,
    used: budget.used,
    remaining: budget.remaining,
    bySport: budget.bySport,
  };
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

function recordSpend(sport, remainingHeader) {
  budget.used += 1;
  budget.bySport[sport] = (budget.bySport[sport] || 0) + 1;
  // Reconcile with the API's own counter when available (source of truth).
  if (remainingHeader != null && Number.isFinite(+remainingHeader)) {
    budget.remaining = +remainingHeader;
  } else {
    budget.remaining = Math.max(0, oddsApi.monthlyBudget - budget.used);
  }
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
  const remaining = res.headers.get('x-requests-remaining');
  if (res.status === 422) return { games: [], remaining }; // no events in window
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Odds API ${res.status} for ${sportKey}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return { games: data, remaining };
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
    game.books[bookKey] = { label: BOOK_LABELS[bookKey] || bookKey, markets: {} };
    for (const mk of bm.markets || []) {
      for (const oc of mk.outcomes || []) {
        const side = mk.key === 'totals' ? oc.name : oc.name; // Over/Under or team name
        const line = oc.point != null ? oc.point : null;
        const price = oc.price != null ? Math.round(oc.price) : null;
        game.books[bookKey].markets[`${mk.key}:${side}`] = { line, price };
        snapshots.push({
          sport, game_id: ev.id, commence_time: ev.commence_time,
          home: ev.home_team, away: ev.away_team, book: bookKey,
          market: mk.key, side, line, price,
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

  for (const [sport, meta] of Object.entries(SPORTS)) {
    // The Odds API has no bare golf/tennis key (event-specific only) — skip to avoid 404s.
    if (meta.oddsSkip) continue;
    const keys = meta.leagues || [meta.key];
    // Per-sport monthly cap.
    if ((budget.bySport[sport] || 0) >= sportCap(sport)) { skippedBudget++; continue; }

    for (const key of keys) {
      if (active && !active.has(key) && key !== 'golf' && key !== 'tennis') { skippedSeason++; continue; }
      if (budget.remaining <= 0) { skippedBudget++; break; }
      if ((budget.bySport[sport] || 0) >= sportCap(sport)) { skippedBudget++; break; }

      try {
        const { games, remaining } = await fetchOdds(key);
        recordSpend(sport, remaining);
        calls++;
        for (const ev of games) allGames.push(normalize(sport, ev, snapshots, movements));
      } catch (e) {
        logger.warn('odds', e.message);
        // Count the spend even on error (the request was made), reconcile loosely.
        recordSpend(sport, null);
      }
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
    summary: `${allGames.length} games, ${snapshots.length} snapshots, ${movements.length} movements · API ${budget.used}/${oddsApi.monthlyBudget} (${budget.remaining} left)${skippedBudget ? `, ${skippedBudget} budget-skips` : ''}`,
    gamesMonitored: allGames.length,
    data: { games: allGames.length, snapshots: snapshots.length, movements: movements.length, calls, budget: getOddsBudget() },
  };
}

export default { name: 'odds', run };
