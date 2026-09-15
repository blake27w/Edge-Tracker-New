// ══════════════════════════════════════════════════════════════
// NCAAF History — closing lines + AP rank for every FBS game, free.
// ESPN's college scoreboard carries each team's AP rank at kickoff
// (curatedRank) and the game summary carries the closing spread and total
// (pickcenter). We grade every completed game since NCAAF_HISTORY_FROM
// and roll up the cuts we bet: Top-25 involvement (ranked vs unranked,
// both ranked, ranked favorite / ranked dog), primetime vs day, slot
// (Thu/Fri night, Sat early/afternoon/night), conference play, total
// band, favorite size, and Top-25 home dogs. Rows → `ncaaf_closing_lines`
// (grading only fetches games not already in the table); rollup on
// /plays → ncaafHistory. Weekly. $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setIntel } from '../../store/index.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const FROM_SEASON = Number(process.env.NCAAF_HISTORY_FROM) || 2024;
const cache = new Map();   // eventId -> row | null

function currentSeason(now = new Date()) { return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; }
async function fetchWeek(year, seasontype, week) {
  const res = await fetch(`${BASE}/scoreboard?dates=${year}&seasontype=${seasontype}&week=${week}&groups=80&limit=400`);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return (await res.json()).events || [];
}
function rankOf(c) { const r = Number(c.curatedRank?.current); return Number.isFinite(r) && r >= 1 && r <= 25 ? r : null; }
function parseEvent(ev, season, week, seasontype) {
  const comp = ev.competitions?.[0]; if (!comp || !comp.status?.type?.completed) return null;
  const h = (comp.competitors || []).find((x) => x.homeAway === 'home'), a = (comp.competitors || []).find((x) => x.homeAway === 'away');
  if (!h || !a) return null;
  const hs = Number(h.score), as = Number(a.score);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  return {
    id: ev.id, season, week, seasontype, date: ev.date, neutral: !!comp.neutralSite, conf: !!comp.conferenceCompetition,
    home: h.team?.displayName, away: a.team?.displayName, homeAbbr: h.team?.abbreviation, awayAbbr: a.team?.abbreviation,
    hs, as, homeRank: rankOf(h), awayRank: rankOf(a),
  };
}
async function seasonFinals(season) {
  const out = [];
  for (let w = 1; w <= 16; w++) {
    let evs = [];
    try { evs = await fetchWeek(season, 2, w); } catch (_) { continue; }
    if (!evs.length && w > 4) break;
    for (const ev of evs) { const g = parseEvent(ev, season, w, 2); if (g) out.push(g); }
  }
  try { for (const ev of await fetchWeek(season, 3, 1)) { const g = parseEvent(ev, season, 99, 3); if (g) out.push(g); } } catch (_) { /* bowls optional */ }
  return out;
}

function slotOf(dateIso) {
  const et = new Date(new Date(dateIso).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(), hr = et.getHours() + et.getMinutes() / 60;
  const night = hr >= 19;
  if (day === 6) return night ? 'SAT-night' : hr >= 15 ? 'SAT-late' : 'SAT-early';
  if (day === 4) return night ? 'THU-night' : 'THU-day';
  if (day === 5) return night ? 'FRI-night' : 'FRI-day';
  return night ? 'OTHER-night' : 'OTHER-day';
}
const PRIME = new Set(['SAT-night', 'THU-night', 'FRI-night', 'OTHER-night']);

async function closingLine(g) {
  const res = await fetch(`${BASE}/summary?event=${g.id}`);
  if (!res.ok) throw new Error(`ESPN summary ${res.status}`);
  const j = await res.json();
  let best = null;
  for (const p of j.pickcenter || j.odds || []) {
    const total = Number(p.overUnder);
    let spreadHome = Number(p.spread);
    if (!Number.isFinite(spreadHome) && p.details) {
      const m = /([A-Z]{2,5})\s*([+-]?\d+(?:\.5)?)/.exec(p.details);
      if (m) { const n = Number(m[2]); spreadHome = m[1] === g.homeAbbr ? -Math.abs(n) : Math.abs(n); }
    }
    const score = (Number.isFinite(total) ? 1 : 0) + (Number.isFinite(spreadHome) ? 1 : 0);
    if (score && (!best || score > best.score)) best = { score, total: Number.isFinite(total) ? total : null, spreadHome: Number.isFinite(spreadHome) ? spreadHome : null, provider: p.provider?.name || null };
  }
  return best;
}

function grade(g, line) {
  const margin = g.hs - g.as, total = g.hs + g.as;
  const row = {
    event_id: g.id, season: g.season, week: g.week, seasontype: g.seasontype, date: g.date, slot: g.slot, primetime: PRIME.has(g.slot),
    home: g.home, away: g.away, home_score: g.hs, away_score: g.as, neutral: g.neutral, conference_game: g.conf,
    home_rank: g.homeRank, away_rank: g.awayRank, ranked_teams: (g.homeRank ? 1 : 0) + (g.awayRank ? 1 : 0),
    close_spread_home: line.spreadHome, close_total: line.total, provider: line.provider,
    fav: null, fav_size: null, fav_covered: null, home_covered: null, total_result: null, ranked_fav: null, ranked_dog: null,
  };
  if (line.spreadHome != null) {
    const hm = margin + line.spreadHome;
    row.home_covered = hm > 0 ? true : hm < 0 ? false : null;
    if (line.spreadHome !== 0) {
      row.fav = line.spreadHome < 0 ? 'home' : 'away';
      row.fav_size = Math.abs(line.spreadHome);
      row.fav_covered = row.home_covered == null ? null : (row.fav === 'home' ? row.home_covered : !row.home_covered);
      const favRank = row.fav === 'home' ? g.homeRank : g.awayRank, dogRank = row.fav === 'home' ? g.awayRank : g.homeRank;
      row.ranked_fav = !!favRank; row.ranked_dog = !!dogRank;
    }
  }
  if (line.total != null) row.total_result = total > line.total ? 'over' : total < line.total ? 'under' : 'push';
  return row;
}

function bucket() { return { n: 0, favW: 0, favL: 0, spush: 0, overs: 0, unders: 0, tpush: 0 }; }
function add(b, r) {
  b.n++;
  if (r.fav_covered === true) b.favW++; else if (r.fav_covered === false) b.favL++; else if (r.close_spread_home != null) b.spush++;
  if (r.total_result === 'over') b.overs++; else if (r.total_result === 'under') b.unders++; else if (r.total_result === 'push') b.tpush++;
}
function fin(b) { const sd = b.favW + b.favL, td = b.overs + b.unders; return { ...b, favPct: sd ? Math.round(b.favW / sd * 1000) / 10 : null, dogPct: sd ? Math.round(b.favL / sd * 1000) / 10 : null, underPct: td ? Math.round(b.unders / td * 1000) / 10 : null }; }
function rollup(rows) {
  const by = (keyFn, subset = rows) => { const m = {}; for (const r of subset) { const k = keyFn(r); if (k == null) continue; (m[k] ||= bucket()); add(m[k], r); } return Object.fromEntries(Object.entries(m).map(([k, b]) => [k, fin(b)])); };
  const top25 = rows.filter((r) => r.ranked_teams > 0);
  const primeTop25 = top25.filter((r) => r.primetime);
  const all = bucket(); rows.forEach((r) => add(all, r));
  return {
    overall: fin(all),
    top25: by((r) => (r.ranked_teams === 2 ? 'both ranked' : 'one ranked'), top25),
    top25Primetime: (() => { const b = bucket(); primeTop25.forEach((r) => add(b, r)); return fin(b); })(),
    top25PrimetimeBySeason: by((r) => r.season, primeTop25),
    top25PrimetimeBySlot: by((r) => r.slot, primeTop25),
    top25PrimetimeVsDay: by((r) => (r.primetime ? 'primetime' : 'day'), top25),
    rankedFavDog: by((r) => (r.ranked_fav && r.ranked_dog ? 'ranked vs ranked' : r.ranked_fav ? 'ranked fav vs unranked' : r.ranked_dog ? 'ranked dog vs unranked' : null)),
    rankedFavDogPrimetime: by((r) => (r.ranked_fav && r.ranked_dog ? 'ranked vs ranked' : r.ranked_fav ? 'ranked fav vs unranked' : r.ranked_dog ? 'ranked dog vs unranked' : null), rows.filter((r) => r.primetime)),
    top25Conference: by((r) => (r.conference_game ? 'conference' : 'non-conf'), top25),
    top25TotalBand: by((r) => (r.close_total == null ? null : r.close_total >= 60 ? '60+' : r.close_total >= 50 ? '50-59.5' : r.close_total >= 45 ? '45-49.5' : '<45'), top25),
    top25FavSize: by((r) => (r.fav_size == null ? null : r.fav_size >= 21 ? 'fav 21+' : r.fav_size >= 14 ? 'fav 14-20.5' : r.fav_size >= 7 ? 'fav 7-13.5' : 'fav 0.5-6.5'), top25),
    top25HomeDogs: by((r) => (r.fav === 'away' && r.home_rank ? 'ranked home dog' : null)),
    bySlot: by((r) => r.slot),
    updated: new Date().toISOString(),
  };
}

async function run() {
  const thisSeason = currentSeason();
  // Skip summaries already graded into the table (survives restarts, keeps ESPN calls low).
  let known = new Map();
  try { const ex = await db.select('ncaaf_closing_lines', '*', { limit: 5000 }); for (const r of ex) known.set(r.event_id, r); } catch (_) { /* fresh */ }
  const rows = [];
  let fetched = 0, missing = 0, total = 0;
  for (let s = FROM_SEASON; s <= thisSeason; s++) {
    let finals = [];
    try { finals = await seasonFinals(s); } catch (e) { logger.warn('ncaaf-history', `${s}: ${e.message}`); }
    for (const g of finals) {
      total++;
      g.slot = slotOf(g.date);
      if (known.has(g.id)) { rows.push(known.get(g.id)); continue; }
      if (!cache.has(g.id)) {
        try { const line = await closingLine(g); fetched++; cache.set(g.id, line ? grade(g, line) : null); } catch (_) { cache.set(g.id, null); }
      }
      const r = cache.get(g.id);
      if (r) rows.push(r); else missing++;
    }
  }
  const report = rollup(rows);
  setIntel('ncaafHistory', report);
  const fresh = rows.filter((r) => !known.has(r.event_id));
  if (fresh.length) {
    try { for (let i = 0; i < fresh.length; i += 200) await db.upsert('ncaaf_closing_lines', fresh.slice(i, i + 200), 'event_id'); }
    catch (e) { logger.warn('ncaaf-history', e.message); }
  }
  const tp = report.top25Primetime;
  return {
    summary: `${rows.length}/${total} games w/ closing lines (${FROM_SEASON}–${thisSeason}) · fetched ${fetched} · Top-25 primetime: favs ${tp.favW}-${tp.favL} ATS, U ${tp.unders}-${tp.overs} (${tp.underPct ?? '—'}%) · free ESPN`,
    data: { games: rows.length, missing, top25Primetime: tp },
  };
}

export default { name: 'ncaaf-history', run };
