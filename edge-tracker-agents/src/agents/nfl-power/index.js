// ══════════════════════════════════════════════════════════════
// NFL Preseason Power Ratings. In the offseason the live Elo agent has
// no recent games to chew on, so this builds a PRESEASON baseline from
// the most recently completed season: run Elo over every final (regular
// + playoffs), then REGRESS toward the mean to account for offseason
// roster churn (last year's record is only ~⅔ predictive). The result
// seeds early-season spread fair-lines and the win-totals model.
//   1500 = average. Output is published to the shared power store under
//   'NFL' so downstream agents can read it like any other power rating.
// $0 — free ESPN finals only.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setPower } from '../../store/index.js';
import { getSeasonFinals, lastCompletedSeason } from '../shared/nfl.js';

const BASE = 1500, K = 20, HFA = 55;
// Fraction of each team's deviation from average to CARRY into next season.
// ~0.65 is the classic NFL year-to-year carryover; the rest regresses to mean.
const CARRYOVER = Number(process.env.NFL_PRESEASON_CARRYOVER) || 0.65;

function movMult(diff, ratingGap) {
  return Math.log(Math.abs(diff) + 1) * (2.2 / (Math.abs(ratingGap) * 0.001 + 2.2));
}

async function run() {
  const season = lastCompletedSeason();
  let finals;
  try { finals = await getSeasonFinals(season); }
  catch (e) { return { summary: `ESPN fetch failed: ${e.message}` }; }
  if (!finals.length) return { summary: `no completed ${season} NFL finals yet` };

  // Elo over the full completed season, in chronological (week) order.
  finals.sort((a, b) => (a.seasontype - b.seasontype) || (a.week - b.week));
  const ratings = {};
  let processed = 0;
  for (const g of finals) {
    if (!g.home || !g.away) continue;
    const rh = ratings[g.home] ?? BASE, ra = ratings[g.away] ?? BASE;
    const expH = 1 / (1 + Math.pow(10, (ra - (rh + HFA)) / 400));
    const actH = g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5;
    const delta = K * movMult(g.hs - g.as, (rh + HFA) - ra) * (actH - expH);
    ratings[g.home] = Math.round((rh + delta) * 10) / 10;
    ratings[g.away] = Math.round((ra - delta) * 10) / 10;
    processed++;
  }

  // Regress each team toward 1500 for the PRESEASON baseline.
  const now = new Date().toISOString();
  const preseason = {};
  for (const [team, r] of Object.entries(ratings)) {
    preseason[team] = Math.round((BASE + (r - BASE) * CARRYOVER) * 10) / 10;
  }

  // Persist + publish to the shared power store so spread fair-lines can use it.
  const rows = Object.entries(preseason).map(([team, rating]) => ({
    season: season + 1, team, rating,
    end_of_season: ratings[team], carryover: CARRYOVER,
    notes: `preseason baseline · ${season} EOS Elo regressed ${Math.round((1 - CARRYOVER) * 100)}% to mean (${processed}g)`,
    updated_at: now,
  }));
  if (rows.length) { try { await db.upsert('nfl_power_ratings', rows, 'season,team'); } catch (e) { logger.warn('nfl-power', e.message); } }

  const map = {};
  for (const [team, rating] of Object.entries(preseason)) map[team] = { rating };
  setPower('NFL', map);

  const top = Object.entries(preseason).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, r]) => `${t.split(' ').pop()} ${r}`);
  return { summary: `NFL preseason ratings: ${rows.length} teams from ${season} (${processed}g) · top: ${top.join(', ')}`, data: { teams: rows.length, season } };
}

export default { name: 'nfl-power', run };
