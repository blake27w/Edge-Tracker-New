// ══════════════════════════════════════════════════════════════
// NFL Prop Workload-Regression Baselines. Player props live and die on
// VOLUME (carries, targets, pass attempts), and last year's volume is
// the strongest free prior. This pulls per-player usage from nflverse
// weekly stat lines (ESPN retired its /leaders endpoint), converts to a
// per-game rate over REAL games played, and REGRESSES toward the
// positional mean (volume is sticky but not fully — role changes,
// committees). The output is a per-player workload baseline that seeds
// in-season prop edges once books post lines; it is NOT a bet by itself.
//   projected/g = mean + (lastYear/g − mean) × carryover
// Per the props backtest (#119): baselines only — no rolling in-season
// usage model. Reference data, refreshed weekly. $0 — free nflverse.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setNflProps } from '../../store/index.js';
import { upcomingSeason } from '../shared/nfl.js';
import { playerUsage } from '../shared/nflverse.js';

const CARRY = Number(process.env.NFL_PROP_CARRYOVER) || 0.70; // volume stickiness year to year
const MIN_GAMES = Number(process.env.NFL_PROP_MIN_GAMES) || 4; // below this a per-game rate is noise
const WANTED = [
  { stat: 'rush_att', label: 'Rush Attempts' },
  { stat: 'targets', label: 'Targets' },
  { stat: 'pass_att', label: 'Pass Attempts' },
];

async function run() {
  const season = upcomingSeason();       // the season these baselines are FOR
  const prior = season - 1;              // the completed season they come FROM
  let players;
  try { players = await playerUsage(prior); }
  catch (e) { return { summary: `nflverse usage fetch failed: ${e.message}` }; }

  const now = new Date().toISOString();
  const out = [];
  for (const { stat, label } of WANTED) {
    const list = players
      .filter((p) => p.games >= MIN_GAMES && p[stat] > 0)
      .map((p) => ({ ...p, pg: p[stat] / p.games }))
      .sort((a, b) => b.pg - a.pg)
      .slice(0, 60); // the volume-relevant tier; the mean below is THEIR mean
    if (!list.length) continue;
    const mean = list.reduce((s, p) => s + p.pg, 0) / list.length;
    for (const p of list) {
      const projected = Math.round((mean + (p.pg - mean) * CARRY) * 10) / 10;
      out.push({
        season, stat, stat_label: label, player: p.name, team: p.team,
        last_pg: Math.round(p.pg * 10) / 10, projected_pg: projected,
        games: p.games, position: p.position, updated_at: now,
      });
    }
  }
  // Keep the top of each stat for the app + DB.
  const top = [];
  for (const { stat } of WANTED) {
    top.push(...out.filter((r) => r.stat === stat).sort((a, b) => b.projected_pg - a.projected_pg).slice(0, 40));
  }
  setNflProps(top);

  if (top.length) {
    try { await db.upsert('nfl_prop_baselines', top.map(({ games, position, ...r }) => r), 'season,stat,player'); }
    catch (e) { logger.warn('nfl-props', e.message); }
  }
  const byStat = WANTED.map(({ stat, label }) => `${label}:${out.filter((r) => r.stat === stat).length}`).join(', ');
  return { summary: out.length ? `workload baselines from ${prior} (nflverse, real games) · ${byStat}` : `no ${prior} usage data yet`, data: { players: top.length } };
}

export default { name: 'nfl-props', run };
