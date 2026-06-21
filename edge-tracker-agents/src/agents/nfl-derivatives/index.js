// ══════════════════════════════════════════════════════════════
// NFL Derivative Ingestion — team totals (and optionally alt lines), the
// softer derivative markets where books are slower. For NFL games it pulls
// the per-event additional markets, devigs each team's Over/Under to a fair
// price, and flags any book paying over fair (Under preferred, per the bias).
//
// COST: additional markets are billed per event on The Odds API, so this is
// OFF by default — set NFL_DERIVATIVES=true to enable. It also self-gates to
// NFL games and is daily-capped, so spend stays bounded. Observational.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setNflDerivs } from '../../store/index.js';
import { impliedProb, toDecimal, toAmerican } from '../shared/odds-math.js';

const { oddsApi, BOOKS } = config;
const MARKETS = (process.env.NFL_DERIVATIVE_MARKETS || 'team_totals').split(',').map((s) => s.trim()).filter(Boolean);
const MIN_BOOKS = Number(process.env.NFL_DERIV_MIN_BOOKS) || 3;
const SHOW_EV = Number(process.env.NFL_DERIV_EV) || 0.03;
const MAX_PER_RUN = Number(process.env.NFL_DERIV_MAX_GAMES) || 6;
const MAX_PER_DAY = Number(process.env.NFL_DERIV_MAX_SCANS) || 30;
const WINDOW_H = Number(process.env.NFL_DERIV_WINDOW_H) || 48;

let day = today(), scansToday = 0;
function today() { return new Date().toISOString().slice(0, 10); }

async function fetchEvent(eventId) {
  const params = new URLSearchParams({ apiKey: oddsApi.key, regions: 'us', oddsFormat: 'american', markets: MARKETS.join(','), bookmakers: BOOKS.join(',') });
  const res = await fetch(`${oddsApi.base}/sports/americanfootball_nfl/events/${eventId}/odds?${params}`);
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw new Error(`Odds derivatives ${res.status}`);
  return res.json();
}

// Team-totals edges: per team, devig the most-booked line and flag +EV prices.
function teamTotalEdges(data, g) {
  const grp = {}; // team -> line -> { Over:[{book,price}], Under:[...] }
  for (const bm of data.bookmakers || []) {
    for (const mk of bm.markets || []) {
      if (mk.key !== 'team_totals') continue;
      for (const oc of mk.outcomes || []) {
        const team = oc.description, side = oc.name, line = oc.point, price = oc.price;
        if (!team || line == null || price == null || (side !== 'Over' && side !== 'Under')) continue;
        ((grp[team] ||= {})[line] ||= { Over: [], Under: [] })[side].push({ book: bm.title || bm.key, price });
      }
    }
  }
  const edges = [];
  for (const [team, lines] of Object.entries(grp)) {
    let line = null, n = -1;
    for (const [ln, s] of Object.entries(lines)) { const c = s.Over.length + s.Under.length; if (c > n) { n = c; line = ln; } }
    const s = lines[line];
    if (!s || s.Over.length < MIN_BOOKS || s.Under.length < MIN_BOOKS) continue;
    const ao = s.Over.reduce((a, x) => a + impliedProb(x.price), 0) / s.Over.length;
    const au = s.Under.reduce((a, x) => a + impliedProb(x.price), 0) / s.Under.length;
    const t = ao + au; if (!t) continue;
    const fair = { Over: ao / t, Under: au / t };
    for (const side of ['Under', 'Over']) {
      let best = null;
      for (const o of s[side]) { const ev = fair[side] * toDecimal(o.price) - 1; if (ev >= SHOW_EV && (!best || ev > best.ev)) best = { ...o, ev }; }
      if (!best) continue;
      edges.push({
        game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, market: 'team_total', team, side,
        line: Number(line), book: best.book, price: best.price, fair_price: toAmerican(fair[side]),
        ev_pct: Math.round(best.ev * 1000) / 10,
      });
    }
  }
  return edges;
}

async function run() {
  if (!config.nflDerivatives) { setNflDerivs([]); return { summary: 'disabled (set NFL_DERIVATIVES=true)' }; }
  if (!oddsApi.key) { setNflDerivs([]); return { summary: 'skipped — no ODDS_API_KEY' }; }
  if (today() !== day) { day = today(); scansToday = 0; }

  const now = Date.now();
  const games = getGames().filter((g) => g.sport === 'NFL' && g.commence_time && new Date(g.commence_time).getTime() <= now + WINDOW_H * 3600_000 && new Date(g.commence_time).getTime() >= now - 3 * 3600_000);
  if (!games.length) { setNflDerivs([]); return { summary: 'dormant — no NFL games in window' }; }

  const edges = [];
  let scanned = 0;
  for (const g of games) {
    if (scanned >= MAX_PER_RUN || scansToday >= MAX_PER_DAY) break;
    let data;
    try { data = await fetchEvent(g.game_id); } catch (e) { logger.warn('nfl-derivatives', `${g.away}@${g.home}: ${e.message}`); continue; }
    scanned++; scansToday++;
    if (!data) continue;
    edges.push(...teamTotalEdges(data, g));
  }
  edges.sort((a, b) => (a.side === b.side ? b.ev_pct - a.ev_pct : a.side === 'Under' ? -1 : 1)); // Under first, then by EV
  setNflDerivs(edges);

  if (edges.length) {
    const nowIso = new Date().toISOString();
    try { await db.insert('nfl_derivatives', edges.map((e) => ({ ...e, fetched_at: nowIso }))); } catch (e) { logger.warn('nfl-derivatives', e.message); }
  }
  return { summary: `${scanned} NFL events scanned · ${edges.length} derivative edges (${MARKETS.join(',')})`, data: { scanned, edges: edges.length, scansToday } };
}

export default { name: 'nfl-derivatives', run };
