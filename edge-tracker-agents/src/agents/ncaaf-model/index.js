// ══════════════════════════════════════════════════════════════
// NCAAF Model — college football's first real module, built to cost $0:
//   • Elo power ratings from free ESPN finals (prior season regressed 1/3
//     to the mean, then every FBS game this season), recomputed each run.
//   • Situational spots from the ESPN schedule: rest edge, off-a-bye,
//     lookahead (top-15 opponent next week).
//   • Signal scoring on NCAAF games ALREADY in the odds store (no extra
//     Odds API credits): model-vs-market spread, sharp buy-back vs the
//     opener, the spread bands that have actually paid this season
//     (home dogs +21, road favorites PK to -3), and NO blowout-Under lean
//     (big spreads have gone Over 44-24 through two weeks).
// Rows are written to monitor_scores with observational=true so they're
// graded and tracked but stay out of the headline record until validated.
// Enable with NCAAF_MODEL=true. Runs every 6h; cheap when no games.
// ══════════════════════════════════════════════════════════════
import config, { unitFor } from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setPower, getPower, setIntel } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';
import { getOpenings } from '../odds/index.js';
import { fmtOdds } from '../shared/odds-math.js';

const ENABLED = String(process.env.NCAAF_MODEL || '').toLowerCase() === 'true';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const BASE = 1500, K = 20, HFA_ELO = 65, PTS_PER_ELO = 1 / 25;   // 25 Elo ≈ 1 point; HFA ≈ 2.6 pts
const PRIOR_REGRESS = 1 / 3;                                       // pull last season 1/3 toward 1500
const MODEL_EDGE_T2 = Number(process.env.NCAAF_MODEL_EDGE) || 3;   // pts vs market for a T2 flag
const MODEL_EDGE_T1 = MODEL_EDGE_T2 * 2;
const DAY = 86400_000;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const fired = new Set();
let priorCache = null;       // { season, finals[] } — last season's results, fetched once per process
let seasonCache = { at: 0, season: null, events: [] };

// ── ESPN ──────────────────────────────────────────────────────
async function fetchWeek(year, seasontype, week) {
  const url = `${ESPN}?dates=${year}&seasontype=${seasontype}&week=${week}&groups=80&limit=400`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status} (${year} st${seasontype} wk${week})`);
  return (await res.json()).events || [];
}
function parseEvent(ev, week) {
  const c = ev.competitions?.[0]; if (!c) return null;
  const h = (c.competitors || []).find((x) => x.homeAway === 'home'), a = (c.competitors || []).find((x) => x.homeAway === 'away');
  if (!h || !a) return null;
  return {
    id: ev.id, week, date: ev.date, neutral: !!c.neutralSite,
    home: h.team?.displayName, away: a.team?.displayName,
    hs: Number(h.score), as: Number(a.score), done: !!c.status?.type?.completed,
  };
}
async function seasonEvents(year, { postseason = true, cutoff = 16 } = {}) {
  const out = [];
  for (let w = 1; w <= cutoff; w++) {
    let evs = [];
    try { evs = await fetchWeek(year, 2, w); } catch (e) { logger.warn('ncaaf-model', e.message); continue; }
    if (!evs.length && w > 4) break;   // past the end of the posted schedule
    for (const ev of evs) { const g = parseEvent(ev, w); if (g) out.push(g); }
  }
  if (postseason) {
    try { for (const ev of await fetchWeek(year, 3, 1)) { const g = parseEvent(ev, 99); if (g) out.push(g); } } catch (_) { /* bowls optional */ }
  }
  return out;
}
function currentSeason(now = new Date()) { return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; }

// ── Elo ───────────────────────────────────────────────────────
function movMult(diff, gap) { return Math.log(Math.abs(diff) + 1) * (2.2 / (Math.abs(gap) * 0.001 + 2.2)); }
function applyGame(r, g) {
  if (!g.done || !Number.isFinite(g.hs) || !Number.isFinite(g.as) || !g.home || !g.away) return;
  const hfa = g.neutral ? 0 : HFA_ELO;
  const rh = r[g.home] ?? BASE, ra = r[g.away] ?? BASE;
  const expH = 1 / (1 + Math.pow(10, (ra - (rh + hfa)) / 400));
  const actH = g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5;
  const d = K * movMult(g.hs - g.as, (rh + hfa) - ra) * (actH - expH);
  r[g.home] = rh + d; r[g.away] = ra - d;
}
async function buildRatings(season) {
  const r = {};
  if (!priorCache || priorCache.season !== season - 1) {
    const finals = await seasonEvents(season - 1, { postseason: true, cutoff: 16 });
    priorCache = { season: season - 1, finals };
  }
  for (const g of priorCache.finals) applyGame(r, g);
  for (const t of Object.keys(r)) r[t] = BASE + (r[t] - BASE) * (1 - PRIOR_REGRESS);
  if (Date.now() - seasonCache.at > 3600_000 || seasonCache.season !== season) {
    seasonCache = { at: Date.now(), season, events: await seasonEvents(season, { postseason: false, cutoff: 16 }) };
  }
  let played = 0;
  for (const g of seasonCache.events) { if (g.done) { applyGame(r, g); played++; } }
  for (const t of Object.keys(r)) r[t] = Math.round(r[t] * 10) / 10;
  return { ratings: r, played, events: seasonCache.events };
}

// ── Situational (rest / bye / lookahead) ──────────────────────
function situational(events, ratings) {
  const byTeam = {};
  for (const g of events) { (byTeam[g.home] ||= []).push(g); (byTeam[g.away] ||= []).push(g); }
  const top = Object.entries(ratings).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t);
  const now = Date.now();
  const out = {};   // team -> { rest, bye, lookahead, nextOpp }
  for (const [team, gs] of Object.entries(byTeam)) {
    gs.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const idx = gs.findIndex((g) => Date.parse(g.date) >= now - 6 * 3600_000);
    if (idx < 0) continue;
    const cur = gs[idx], prev = gs[idx - 1], next = gs[idx + 1];
    const rest = prev ? Math.round((Date.parse(cur.date) - Date.parse(prev.date)) / DAY) : null;
    const nextOpp = next ? (next.home === team ? next.away : next.home) : null;
    out[team] = { rest, bye: rest != null && rest >= 13, lookahead: !!(nextOpp && top.includes(nextOpp)), nextOpp, game: cur.id };
  }
  return out;
}

// ── Team-name matching between Odds API and ESPN ──────────────
function matchName(name, pool) {
  const n = norm(name); if (!n) return null;
  if (pool.has(n)) return n;
  for (const p of pool) if (p === n || p.endsWith(' ' + n) || n.endsWith(' ' + p) || p.startsWith(n + ' ') || n.startsWith(p + ' ')) return p;
  return null;
}

// ── Signals ───────────────────────────────────────────────────
function sig(id, tier, label) { return { id, tier, label }; }
function scoreGame(g, ctx) {
  const m = computeMarkets(g);
  const mktHome = m.spread.consensusHome;             // negative = home favored
  if (mktHome == null) return [];
  const { byNorm, situ, openings } = ctx;
  const hKey = matchName(g.home, byNorm.keys), aKey = matchName(g.away, byNorm.keys);
  const rh = hKey ? byNorm.map.get(hKey) : null, ra = aKey ? byNorm.map.get(aKey) : null;
  const cands = [];
  const push = (side, line, sigs, extra = {}) => cands.push({ market: 'spread', side, line, sigs, ...extra });

  // 1) Model vs market
  if (rh != null && ra != null) {
    const modelHome = -((rh + HFA_ELO) - ra) * PTS_PER_ELO;   // model's home spread
    const edge = Math.round((mktHome - modelHome) * 10) / 10; // + → market gives home too many points → home value
    if (Math.abs(edge) >= MODEL_EDGE_T2) {
      const side = edge > 0 ? g.home : g.away;
      const line = edge > 0 ? mktHome : -mktHome;
      push(side, line, [sig('c_model', Math.abs(edge) >= MODEL_EDGE_T1 ? 1 : 2, `Elo ${modelHome > 0 ? '+' : ''}${modelHome.toFixed(1)} vs market ${mktHome > 0 ? '+' : ''}${mktHome} (${Math.abs(edge)} pt edge)`)], { modelHome, edge });
    }
  }
  // 2) Sharp buy-back vs opener (line reversed ≥1 pt toward a side after opening the other way)
  const open = openings.get(`${g.game_id}|spread`);
  if (open && open.line != null) {
    const move = mktHome - open.line;                 // + → market moved toward home getting more points
    if (Math.abs(move) >= 1) {
      const side = move > 0 ? g.home : g.away;
      const line = move > 0 ? mktHome : -mktHome;
      push(side, line, [sig('c_buyback', 2, `opened ${open.line > 0 ? '+' : ''}${open.line}, now ${mktHome > 0 ? '+' : ''}${mktHome} — ${Math.abs(move)} pt move toward ${side}`)]);
    }
  }
  // 3) Spread bands that have paid this season
  if (mktHome >= 21) push(g.home, mktHome, [sig('c_homedog21', 2, `home dog +${mktHome} (80% ATS band, small sample)`)]);
  if (mktHome >= 0 && mktHome <= 3 && mktHome !== 0) push(g.away, -mktHome, [sig('c_roadfav', 3, `road favorite ${-mktHome} (PK to -3 band 5-3 ATS)`)]);
  // 4) Situational
  const sh = hKey && situ[byNorm.orig.get(hKey)], sa = aKey && situ[byNorm.orig.get(aKey)];
  if (sh && sa && sh.rest != null && sa.rest != null && Math.abs(sh.rest - sa.rest) >= 3) {
    const side = sh.rest > sa.rest ? g.home : g.away;
    push(side, side === g.home ? mktHome : -mktHome, [sig('c_rest', 3, `rest edge ${Math.abs(sh.rest - sa.rest)}d (${sh.rest}d vs ${sa.rest}d)`)]);
  }
  if (sh?.lookahead && mktHome <= -14) push(g.away, -mktHome, [sig('c_lookahead', 2, `${g.home} laying ${mktHome} with ${sh.nextOpp} next week`)]);
  if (sa?.lookahead && mktHome >= 14) push(g.home, mktHome, [sig('c_lookahead', 2, `${g.away} laying ${-mktHome} with ${sa.nextOpp} next week`)]);

  // Merge same-side candidates into one play; score = tier weights (T1 3, T2 2, T3 1) scaled to 0–100.
  const merged = {};
  for (const c of cands) {
    const k = c.side;
    if (!merged[k]) merged[k] = { market: 'spread', side: c.side, line: c.line, signals: [], modelHome: c.modelHome, edge: c.edge };
    merged[k].signals.push(...c.sigs);
  }
  return Object.values(merged).map((p) => {
    const raw = p.signals.reduce((t, s) => t + (s.tier === 1 ? 3 : s.tier === 2 ? 2 : 1), 0);
    const t1 = p.signals.filter((s) => s.tier === 1).length;
    p.score = Math.min(99, Math.round(raw * 12 + (t1 ? 10 : 0)));   // 6 raw pts (≈ one T1 + one T2 + one T3) ≈ 72
    p.t1 = t1;
    const best = pickBest(g, p.side);
    p.book = best?.book ?? null; p.price = best?.price ?? null; if (best?.line != null) p.line = best.line;
    return p;
  });
}
// Best available price on a spread side across the books already in the store.
function pickBest(g, side) {
  let best = null;
  for (const [bk, b] of Object.entries(g.books || {})) {
    const sp = b.markets?.[`spreads:${side}`]; if (!sp || sp.price == null) continue;
    if (!best || sp.line > best.line || (sp.line === best.line && sp.price > best.price)) best = { book: b.label || bk, line: sp.line, price: sp.price };
  }
  return best;
}

// ── main ──────────────────────────────────────────────────────
async function run() {
  if (!ENABLED) { setIntel('ncaaf', []); return { summary: 'disabled (set NCAAF_MODEL=true)' }; }
  const season = currentSeason();
  let built;
  try { built = await buildRatings(season); } catch (e) { return { summary: `Elo build failed: ${e.message}` }; }
  const { ratings, played, events } = built;
  const map = {}; for (const [t, r] of Object.entries(ratings)) map[t] = { rating: r };
  setPower('NCAAF', map);
  try {
    const now = new Date().toISOString();
    const rows = Object.entries(ratings).map(([team, rating]) => ({ sport: 'NCAAF', team, rating, off_rating: null, def_rating: null, notes: `Elo · prior-season regressed + ${played}g ${season}`, updated_at: now }));
    if (rows.length) await db.upsert('power_ratings', rows, 'sport,team');
  } catch (e) { logger.warn('ncaaf-model', e.message); }

  const situ = situational(events, ratings);
  const byNorm = { keys: new Set(), map: new Map(), orig: new Map() };
  for (const [t, r] of Object.entries(ratings)) { const k = norm(t); byNorm.keys.add(k); byNorm.map.set(k, r); byNorm.orig.set(k, t); }
  const openings = getOpenings();

  const games = getGames().filter((g) => g.sport === 'NCAAF' && g.commence_time && Date.parse(g.commence_time) > Date.now());
  const nowIso = new Date().toISOString();
  const rows = [], fresh = [];
  for (const g of games) {
    for (const p of scoreGame(g, { byNorm, situ, openings })) {
      const unit = unitFor(p.score);
      const row = {
        sport: 'NCAAF', game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, commence_time: g.commence_time,
        market: 'spread', side: p.side, line: p.line ?? null, price: p.price ?? null, book: p.book ?? null,
        raw_score: p.score, score: p.score, confidence: p.score, tier: unit.label,
        unit_mult: unit.mult, unit_dollars: unit.dollars, t1_count: p.t1, signals: p.signals,
        qualified: unit.mult > 0, over_penalty_applied: false, observational: true, live: false,
        model_spread: p.modelHome ?? null, model_edge: p.edge ?? null,
        status: 'pending', scored_at: nowIso,
      };
      rows.push(row);
      const key = `${g.game_id}|${p.side}`;
      if (row.qualified && !fired.has(key)) { fired.add(key); fresh.push(row); }
    }
  }
  rows.sort((a, b) => b.score - a.score);
  setIntel('ncaaf', rows);

  if (fresh.length) {
    let pending = new Set();
    try {
      const ex = await db.select('monitor_scores', 'game_id,market,side', { match: { status: 'pending', sport: 'NCAAF' }, limit: 2000 });
      pending = new Set(ex.map((r) => `${r.game_id}|${r.market}|${r.side}`));
    } catch (_) { /* in-memory dedupe only */ }
    const dbRows = fresh.filter((r) => !pending.has(`${r.game_id}|${r.market}|${r.side}`))
      .map(({ commence_time, book, model_spread, model_edge, ...r }) => r);
    if (dbRows.length) { try { await db.insert('monitor_scores', dbRows); } catch (e) { logger.warn('ncaaf-model', e.message); } }
  }

  const top = rows[0];
  return {
    summary: `Elo ${Object.keys(ratings).length}t/${played}g · ${games.length} games on board · ${rows.filter((r) => r.qualified).length} obs plays${top ? ` · top: ${top.side} ${fmtOdds(top.line)} (${top.score})` : ''} · free ESPN`,
    data: { teams: Object.keys(ratings).length, played, games: games.length, plays: rows.length },
  };
}

export default { name: 'ncaaf-model', run };
