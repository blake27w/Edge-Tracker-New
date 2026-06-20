// ══════════════════════════════════════════════════════════════
// NFL Schedule / Situational Scanner. Once the upcoming schedule is
// released (≈May), this walks each team's slate in week order and flags
// OBJECTIVE situational spots that historically move ATS value:
//   • short week   — ≤4 days rest (e.g. Sunday → Thursday)
//   • off a bye    — ≥13 days rest (rested ATS bump)
//   • rest edge    — meaningfully more/less rest than the opponent
//   • long road    — 3rd+ consecutive road game
//   • lookahead    — weak opponent this week, strong opponent next week
// Rest is computed from real game dates; opponent strength uses the
// preseason power ratings. Reference data (not a bet) until lines exist.
// $0 — free ESPN schedule.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getPower, setNflSchedule } from '../../store/index.js';
import { getSeasonSchedule, teamSchedules, restDays, upcomingSeason, norm } from '../shared/nfl.js';

const matchTeam = (name, teams) => teams.find((t) => { const x = norm(t), y = norm(name); return x === y || x.includes(y) || y.includes(x) || x.split(' ').pop() === y.split(' ').pop(); });

async function run() {
  const season = upcomingSeason();
  let sched;
  try { sched = await getSeasonSchedule(season); }
  catch (e) { return { summary: `schedule fetch failed: ${e.message}` }; }
  if (!sched.length) { setNflSchedule([]); return { summary: `no ${season} schedule posted yet` }; }

  const bySched = teamSchedules(sched);
  const power = getPower('NFL');
  const teams = Object.keys(power);
  const ratingOf = (team) => { const t = matchTeam(team, teams); return t ? (power[t].rating ?? 1500) : 1500; };
  // Strength tiers for lookahead detection (only if we have ratings).
  const sorted = teams.map((t) => power[t].rating ?? 1500).sort((a, b) => b - a);
  const topCut = sorted.length >= 10 ? sorted[9] : Infinity;     // top-10 rating floor
  const botCut = sorted.length >= 12 ? sorted[sorted.length - 12] : -Infinity; // bottom-12 ceiling

  // Pass 1: rest days per (team, week).
  const restOf = {}; // `${team}|${week}` -> rest days
  for (const [team, games] of Object.entries(bySched)) {
    let prev = null;
    for (const g of games) { restOf[`${team}|${g.week}`] = restDays(prev, g.date); prev = g.date; }
  }

  const now = new Date().toISOString();
  const rows = [];
  for (const [team, games] of Object.entries(bySched)) {
    let roadStreak = 0;
    games.forEach((g, i) => {
      roadStreak = g.home ? 0 : roadStreak + 1;
      const rest = restOf[`${team}|${g.week}`];
      const oppRest = restOf[`${g.opp}|${g.week}`];
      const tags = [];
      if (rest != null && rest <= 4) tags.push('short_week');
      if (rest != null && rest >= 13) tags.push('off_bye');
      if (rest != null && oppRest != null) {
        if (rest - oppRest >= 3) tags.push('rest_edge');
        else if (oppRest - rest >= 3) tags.push('rest_disadv');
      }
      if (!g.home && roadStreak >= 3) tags.push('long_road');
      const next = games[i + 1];
      if (next && ratingOf(g.opp) <= botCut && ratingOf(next.opp) >= topCut) tags.push('lookahead');
      if (!tags.length) return;
      rows.push({
        season, team, week: g.week, opponent: g.opp, home: g.home, game_date: g.date,
        rest_days: rest ?? null, opp_rest_days: oppRest ?? null, tags,
        note: tags.map((t) => ({
          short_week: 'short week', off_bye: 'off a bye', rest_edge: 'rest edge vs opp',
          rest_disadv: 'opp better rested', long_road: `${roadStreak} straight road`, lookahead: 'lookahead trap',
        }[t])).join(', '), updated_at: now,
      });
    });
  }
  rows.sort((a, b) => a.week - b.week || a.team.localeCompare(b.team));
  setNflSchedule(rows);

  if (rows.length) {
    try { await db.del('nfl_schedule_spots', { match: { season } }); } catch (_) { /* table may be empty/new */ }
    try { await db.insert('nfl_schedule_spots', rows); } catch (e) { logger.warn('nfl-schedule', e.message); }
  }
  const counts = {};
  for (const r of rows) for (const t of r.tags) counts[t] = (counts[t] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
  return { summary: `${rows.length} situational spots (${summary})`, data: { spots: rows.length } };
}

export default { name: 'nfl-schedule', run };
