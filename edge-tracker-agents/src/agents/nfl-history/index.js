// ══════════════════════════════════════════════════════════════
// NFL History — clean closing-line results for every NFL game, free.
// ESPN's game summary carries a `pickcenter` block with the closing
// spread and total from real books (Caesars / DraftKings / ESPN BET…).
// We pull it for every completed game (2024 → today), grade the closing
// number against the final score, and roll it up the ways we actually
// bet: favorite vs dog ATS, Over vs Under, by slot (primetime / Thursday /
// Sunday night / Monday night / early / late), divisional, total band,
// favorite size, and Week 1–3 dogs. Rows go to `nfl_closing_lines`
// (query it any way you like); the rollup is on /plays → history.
// Runs weekly (Tuesday-ish); cheap ESPN summaries, cached per event.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setIntel } from '../../store/index.js';
import { getSeasonFinals, upcomingSeason } from '../shared/nfl.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const FROM_SEASON = Number(process.env.NFL_HISTORY_FROM) || 2024;
const cache = new Map();   // eventId -> row (never re-fetch a graded game)

const DIV = {
  'Buffalo Bills': 'AFCE', 'Miami Dolphins': 'AFCE', 'New England Patriots': 'AFCE', 'New York Jets': 'AFCE',
  'Baltimore Ravens': 'AFCN', 'Cincinnati Bengals': 'AFCN', 'Cleveland Browns': 'AFCN', 'Pittsburgh Steelers': 'AFCN',
  'Houston Texans': 'AFCS', 'Indianapolis Colts': 'AFCS', 'Jacksonville Jaguars': 'AFCS', 'Tennessee Titans': 'AFCS',
  'Denver Broncos': 'AFCW', 'Kansas City Chiefs': 'AFCW', 'Las Vegas Raiders': 'AFCW', 'Los Angeles Chargers': 'AFCW',
  'Dallas Cowboys': 'NFCE', 'New York Giants': 'NFCE', 'Philadelphia Eagles': 'NFCE', 'Washington Commanders': 'NFCE',
  'Chicago Bears': 'NFCN', 'Detroit Lions': 'NFCN', 'Green Bay Packers': 'NFCN', 'Minnesota Vikings': 'NFCN',
  'Atlanta Falcons': 'NFCS', 'Carolina Panthers': 'NFCS', 'New Orleans Saints': 'NFCS', 'Tampa Bay Buccaneers': 'NFCS',
  'Arizona Cardinals': 'NFCW', 'Los Angeles Rams': 'NFCW', 'San Francisco 49ers': 'NFCW', 'Seattle Seahawks': 'NFCW',
};

// Kickoff slot in US Eastern time.
function slotOf(dateIso) {
  const d = new Date(dateIso);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(), hr = et.getHours() + et.getMinutes() / 60;
  if (day === 4) return hr >= 19 ? 'TNF' : 'THU-day';
  if (day === 1) return hr >= 19 ? 'MNF' : 'MON-day';
  if (day === 0) return hr >= 19.5 ? 'SNF' : hr >= 15.5 ? 'SUN-late' : hr >= 12 ? 'SUN-early' : 'SUN-intl';
  if (day === 6) return hr >= 19 ? 'SAT-night' : 'SAT-day';
  return hr >= 19 ? 'OTHER-night' : 'OTHER-day';
}
const PRIME = new Set(['TNF', 'SNF', 'MNF', 'SAT-night', 'OTHER-night']);

// Closing spread (home) and total from the summary's pickcenter. Prefers the
// provider with the most fields; falls back to the first with numbers.
async function closingLine(eventId) {
  const res = await fetch(`${BASE}/summary?event=${eventId}`);
  if (!res.ok) throw new Error(`ESPN summary ${res.status}`);
  const j = await res.json();
  const pc = j.pickcenter || j.odds || [];
  let best = null;
  for (const p of pc) {
    const total = Number(p.overUnder);
    // pickcenter.spread is from the home team's perspective (negative = home favored); details like "KC -6.5" when present.
    let spreadHome = Number(p.spread);
    if (!Number.isFinite(spreadHome) && p.details) {
      const m = /([A-Z]{2,4})\s*([+-]?\d+(?:\.5)?)/.exec(p.details);
      if (m) { const fav = m[1], n = Number(m[2]); const homeAbbr = j.boxscore?.teams?.find((t) => t.homeAway === 'home')?.team?.abbreviation; spreadHome = fav === homeAbbr ? -Math.abs(n) : Math.abs(n); }
    }
    const score = (Number.isFinite(total) ? 1 : 0) + (Number.isFinite(spreadHome) ? 1 : 0);
    if (score && (!best || score > best.score)) best = { score, total: Number.isFinite(total) ? total : null, spreadHome: Number.isFinite(spreadHome) ? spreadHome : null, provider: p.provider?.name || null };
  }
  return best;
}

function grade(g, line) {
  const margin = g.hs - g.as, total = g.hs + g.as;
  const row = {
    season: g.season, week: g.week, seasontype: g.seasontype, event_id: g.id, date: g.date, slot: g.slot, primetime: PRIME.has(g.slot),
    home: g.home, away: g.away, home_score: g.hs, away_score: g.as, divisional: !!(DIV[g.home] && DIV[g.home] === DIV[g.away]),
    close_spread_home: line.spreadHome, close_total: line.total, provider: line.provider,
    fav: null, fav_size: null, fav_covered: null, home_covered: null, total_result: null,
  };
  if (line.spreadHome != null) {
    const homeMargin = margin + line.spreadHome;  // >0 home covers
    row.home_covered = homeMargin > 0 ? true : homeMargin < 0 ? false : null;
    if (line.spreadHome !== 0) {
      row.fav = line.spreadHome < 0 ? 'home' : 'away';
      row.fav_size = Math.abs(line.spreadHome);
      row.fav_covered = row.home_covered == null ? null : (row.fav === 'home' ? row.home_covered : !row.home_covered);
    }
  }
  if (line.total != null) row.total_result = total > line.total ? 'over' : total < line.total ? 'under' : 'push';
  return row;
}

// Rollups: {n, favW, favL, push, overs, unders, tpush, dogPct, underPct}
function bucket() { return { n: 0, favW: 0, favL: 0, spush: 0, overs: 0, unders: 0, tpush: 0 }; }
function add(b, r) {
  b.n++;
  if (r.fav_covered === true) b.favW++; else if (r.fav_covered === false) b.favL++; else if (r.close_spread_home != null) b.spush++;
  if (r.total_result === 'over') b.overs++; else if (r.total_result === 'under') b.unders++; else if (r.total_result === 'push') b.tpush++;
}
function fin(b) {
  const sd = b.favW + b.favL, td = b.overs + b.unders;
  return { ...b, favPct: sd ? Math.round(b.favW / sd * 1000) / 10 : null, dogPct: sd ? Math.round(b.favL / sd * 1000) / 10 : null, underPct: td ? Math.round(b.unders / td * 1000) / 10 : null };
}
function rollup(rows) {
  const by = (keyFn) => { const m = {}; for (const r of rows) { const k = keyFn(r); if (k == null) continue; (m[k] ||= bucket()); add(m[k], r); } return Object.fromEntries(Object.entries(m).map(([k, b]) => [k, fin(b)])); };
  const all = bucket(); rows.forEach((r) => add(all, r));
  return {
    overall: fin(all),
    bySeason: by((r) => r.season),
    bySlot: by((r) => r.slot),
    primetime: by((r) => (r.primetime ? 'primetime' : 'day')),
    primetimeBySeason: by((r) => (r.primetime ? `${r.season} primetime` : null)),
    divisional: by((r) => (r.divisional ? 'divisional' : 'non-div')),
    primetimeDiv: by((r) => (r.primetime ? (r.divisional ? 'prime+div' : 'prime non-div') : null)),
    totalBand: by((r) => (r.close_total == null ? null : r.close_total >= 50 ? '50+' : r.close_total >= 44.5 ? '44.5-49.5' : r.close_total >= 40 ? '40-44' : '<40')),
    favSize: by((r) => (r.fav_size == null ? null : r.fav_size >= 10 ? 'fav 10+' : r.fav_size >= 6.5 ? 'fav 6.5-9.5' : r.fav_size >= 3.5 ? 'fav 3.5-6' : 'fav 0.5-3')),
    dogsWk1to3: by((r) => (r.week <= 3 && r.seasontype === 2 && r.fav_size >= 5.5 ? 'wk1-3 dog 5.5+' : null)),
    updated: new Date().toISOString(),
  };
}

async function run() {
  const thisSeason = upcomingSeason();
  const games = [];
  for (let s = FROM_SEASON; s <= thisSeason; s++) {
    let finals = [];
    try { finals = await getSeasonFinals(s); } catch (e) { logger.warn('nfl-history', `${s}: ${e.message}`); }
    for (const g of finals) games.push({ ...g, season: s, slot: slotOf(g.date) });
  }
  let fetched = 0, missing = 0;
  const rows = [];
  for (const g of games) {
    if (!cache.has(g.id)) {
      try { const line = await closingLine(g.id); fetched++; cache.set(g.id, line ? grade(g, line) : null); }
      catch (e) { cache.set(g.id, null); }
    }
    const r = cache.get(g.id);
    if (r) rows.push(r); else missing++;
  }
  const report = rollup(rows);
  setIntel('history', report);
  if (rows.length) {
    try {
      for (let i = 0; i < rows.length; i += 200) await db.upsert('nfl_closing_lines', rows.slice(i, i + 200), 'event_id');
    } catch (e) { logger.warn('nfl-history', e.message); }
  }
  const pt = report.primetime.primetime || {};
  return {
    summary: `${rows.length} games w/ closing lines (${FROM_SEASON}–${thisSeason}) · fetched ${fetched} · ${missing} missing · primetime U ${pt.unders || 0}-${pt.overs || 0} (${pt.underPct ?? '—'}%) · dogs ${report.overall.dogPct ?? '—'}% ATS · free ESPN`,
    data: { games: rows.length, missing, primetime: pt },
  };
}

export default { name: 'nfl-history', run };
