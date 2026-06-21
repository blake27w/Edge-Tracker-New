// ══════════════════════════════════════════════════════════════
// NFL Scoring-Environment / Totals Model. Builds each team's offensive
// and defensive scoring rate from the prior completed season's finals
// (free ESPN, the same data the power agent uses), regresses toward the
// league mean for offseason turnover, and projects each upcoming game's
// total from the four units involved:
//   projTotal = (offA + defB) + (offB + defA) − 2·leagueAvg
// Offseason this is reference data; in-season, when a real NFL game is on
// the slate with a posted total, it leans Under/Over vs the projection.
// Under bias applies — the Under lean is the actionable one. Observational
// until the per-signal CLV scorecard validates it. $0 — free ESPN finals.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setNflTotals } from '../../store/index.js';
import { getSeasonFinals, getSeasonSchedule, teamSchedules, lastCompletedSeason, upcomingSeason, norm } from '../shared/nfl.js';

const CARRY = Number(process.env.NFL_TOTALS_CARRYOVER) || 0.55; // scoring regresses hard year to year
const EDGE = Number(process.env.NFL_TOTALS_EDGE) || 3;          // pts of model-vs-posted gap to flag a lean
const matchTeam = (name, teams) => teams.find((t) => { const x = norm(t), y = norm(name); return x === y || x.includes(y) || y.includes(x) || x.split(' ').pop() === y.split(' ').pop(); });

async function run() {
  const season = lastCompletedSeason();
  let finals;
  try { finals = await getSeasonFinals(season); }
  catch (e) { return { summary: `ESPN fetch failed: ${e.message}` }; }
  if (!finals.length) return { summary: `no completed ${season} NFL finals yet` };

  // Per-team points for / against per game.
  const agg = {}; // team -> { pf, pa, g }
  let totalPts = 0, teamGames = 0;
  for (const f of finals) {
    if (!f.home || !f.away || f.hs == null || f.as == null) continue;
    (agg[f.home] ||= { pf: 0, pa: 0, g: 0 }); (agg[f.away] ||= { pf: 0, pa: 0, g: 0 });
    agg[f.home].pf += f.hs; agg[f.home].pa += f.as; agg[f.home].g++;
    agg[f.away].pf += f.as; agg[f.away].pa += f.hs; agg[f.away].g++;
    totalPts += f.hs + f.as; teamGames += 2;
  }
  const leagueAvg = teamGames ? totalPts / teamGames : 22; // avg points scored per team-game

  // Regress each unit toward the league mean for the offseason.
  const ratings = {}; // team -> { off_pg, def_pg, off_rating, def_rating }
  for (const [team, a] of Object.entries(agg)) {
    if (!a.g) continue;
    const offPg = a.pf / a.g, defPg = a.pa / a.g;
    const off = leagueAvg + (offPg - leagueAvg) * CARRY;
    const def = leagueAvg + (defPg - leagueAvg) * CARRY;
    ratings[team] = {
      off_pg: Math.round(offPg * 10) / 10, def_pg: Math.round(defPg * 10) / 10,
      off_rating: Math.round((off - leagueAvg) * 10) / 10, // + = scores above avg
      def_rating: Math.round((def - leagueAvg) * 10) / 10, // + = allows above avg (worse D)
      _off: off, _def: def,
    };
  }
  const teams = Object.keys(ratings);
  const projFor = (off, opp) => off + ratings[opp]._def - leagueAvg;        // expected points for `off` team
  const projTotal = (a, b) => Math.round((projFor(ratings[a]._off, b) + projFor(ratings[b]._off, a)) * 10) / 10;

  // Projected totals for the upcoming schedule (reference).
  const upSeason = upcomingSeason();
  const games = [];
  try {
    const sched = await getSeasonSchedule(upSeason);
    const seen = new Set();
    for (const g of sched) {
      const home = matchTeam(g.home, teams), away = matchTeam(g.away, teams);
      if (!home || !away) continue;
      const key = `${g.week}|${away}|${home}`;
      if (seen.has(key)) continue; seen.add(key);
      games.push({ week: g.week, away: g.away, home: g.home, proj_total: projTotal(away, home) });
    }
  } catch (e) { /* schedule not posted yet — ratings still useful */ }
  games.sort((a, b) => a.week - b.week);

  // In-season: lean any live NFL game with a posted total vs our projection.
  const leans = [];
  for (const g of getGames().filter((x) => x.sport === 'NFL' && x.consensusTotal != null)) {
    const home = matchTeam(g.home, teams), away = matchTeam(g.away, teams);
    if (!home || !away) continue;
    const proj = projTotal(away, home);
    const diff = Math.round((proj - g.consensusTotal) * 10) / 10; // + = model higher than posted (Over lean)
    if (Math.abs(diff) >= EDGE) leans.push({ game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, posted: g.consensusTotal, proj, diff, side: diff < 0 ? 'Under' : 'Over' });
  }
  leans.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  setNflTotals({
    season: upSeason, leagueAvg: Math.round(leagueAvg * 10) / 10,
    teams: teams.map((t) => ({ team: t, ...strip(ratings[t]) })).sort((a, b) => b.off_rating - a.off_rating),
    games: games.slice(0, 64), leans,
  });

  if (teams.length) {
    const now = new Date().toISOString();
    try {
      await db.upsert('nfl_scoring', teams.map((t) => ({
        season: upSeason, team: t, off_pg: ratings[t].off_pg, def_pg: ratings[t].def_pg,
        off_rating: ratings[t].off_rating, def_rating: ratings[t].def_rating, league_avg: Math.round(leagueAvg * 10) / 10, updated_at: now,
      })), 'season,team');
    } catch (e) { logger.warn('nfl-totals', e.message); }
  }

  return { summary: `NFL scoring env: ${teams.length} teams (lg avg ${Math.round(leagueAvg * 10) / 10}/tm) · ${games.length} games projected${leans.length ? ` · ${leans.length} live leans` : ''}`, data: { teams: teams.length, games: games.length, leans: leans.length } };
}

// Drop internal _off/_def before publishing.
function strip(r) { const { _off, _def, ...rest } = r; return rest; }

export default { name: 'nfl-totals', run };
