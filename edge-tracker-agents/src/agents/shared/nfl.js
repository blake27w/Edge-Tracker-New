// ══════════════════════════════════════════════════════════════
// Shared NFL data helpers (free ESPN), with a long TTL cache. Used by
// the offseason "prep" agents: power ratings (prior season), win-totals
// model, schedule/situational scanner, prop workload baselines. ESPN's
// season schedule rarely changes, so we cache aggressively.
//   seasontype: 2 = regular, 3 = postseason. A season is labeled by the
//   year it STARTS (the 2025 season runs Sep 2025 → Feb 2026).
// ══════════════════════════════════════════════════════════════
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const TTL = Number(process.env.NFL_CACHE_TTL_MS) || 6 * 3600_000;
const cache = new Map(); // key -> { at, data }

export const norm = (s) => String(s || '').toLowerCase().trim();
const REG_WEEKS = 18;

// Most recently COMPLETED season (start-year). Before ~August we're still
// in the prior season's offseason; the last finished season started last year.
export function lastCompletedSeason(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(); // 0=Jan
  return m >= 7 ? y : y - 1; // Aug+ → current year's season is underway/done enough
}
// The upcoming/current season we're projecting for.
export function upcomingSeason(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  return m >= 1 ? y : y - 1; // Feb+ → this calendar year's season is next
}

async function fetchWeek(year, seasontype, week) {
  const url = `${BASE}/scoreboard?dates=${year}&seasontype=${seasontype}&week=${week}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status} (${year} st${seasontype} wk${week})`);
  return (await res.json()).events || [];
}

function parseEvent(ev, week, seasontype) {
  const comp = (ev.competitions || [])[0];
  if (!comp) return null;
  const h = (comp.competitors || []).find((c) => c.homeAway === 'home');
  const a = (comp.competitors || []).find((c) => c.homeAway === 'away');
  if (!h || !a) return null;
  const completed = !!(comp.status?.type?.completed);
  const hs = Number(h.score), as = Number(a.score);
  return {
    id: ev.id, week, seasontype,
    date: ev.date || comp.date || null,
    home: h.team?.displayName, away: a.team?.displayName,
    homeAbbr: h.team?.abbreviation, awayAbbr: a.team?.abbreviation,
    completed,
    hs: Number.isFinite(hs) ? hs : null, as: Number.isFinite(as) ? as : null,
  };
}

// All regular-season (and optionally postseason) games for a season.
async function seasonGames(year, { postseason = false } = {}) {
  const key = `season|${year}|${postseason}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const out = [];
  for (let w = 1; w <= REG_WEEKS; w++) {
    try { for (const ev of await fetchWeek(year, 2, w)) { const g = parseEvent(ev, w, 2); if (g) out.push(g); } }
    catch (_) { /* skip missing week */ }
  }
  if (postseason) {
    for (let w = 1; w <= 5; w++) {
      try { for (const ev of await fetchWeek(year, 3, w)) { const g = parseEvent(ev, w, 3); if (g) out.push(g); } }
      catch (_) { /* skip */ }
    }
  }
  cache.set(key, { at: Date.now(), data: out });
  return out;
}

// Completed finals for a season (regular + postseason) — feeds Elo.
export async function getSeasonFinals(year) {
  return (await seasonGames(year, { postseason: true })).filter((g) => g.completed && g.hs != null && g.as != null);
}

// Full regular-season schedule for a season (any status) — feeds win-totals
// + situational scanner. Returns games with week + date.
export async function getSeasonSchedule(year) {
  return seasonGames(year, { postseason: false });
}

// Per-team list of regular-season games in week order: { team -> [{week,opp,home,date,bye?}] }.
export function teamSchedules(games) {
  const byTeam = {};
  const add = (team, opp, home, week, date) => {
    if (!team) return;
    (byTeam[team] ||= []).push({ week, opp, home, date });
  };
  for (const g of games) {
    add(g.home, g.away, true, g.week, g.date);
    add(g.away, g.home, false, g.week, g.date);
  }
  // Sort each by week and mark the bye week (missing week in 1..18).
  for (const t of Object.keys(byTeam)) {
    const list = byTeam[t].sort((x, y) => x.week - y.week);
    const weeks = new Set(list.map((x) => x.week));
    for (let w = 1; w <= REG_WEEKS; w++) if (!weeks.has(w)) { list.bye = w; break; }
    byTeam[t] = list;
  }
  return byTeam;
}

// Rest days between two ISO dates (whole days).
export function restDays(prevDate, date) {
  if (!prevDate || !date) return null;
  const d = (new Date(date) - new Date(prevDate)) / 86400_000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

export default { norm, lastCompletedSeason, upcomingSeason, getSeasonFinals, getSeasonSchedule, teamSchedules, restDays, REG_WEEKS };
