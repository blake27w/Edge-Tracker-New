// ══════════════════════════════════════════════════════════════
// NFL Prop Workload-Regression Baselines. Player props live and die on
// VOLUME (carries, targets, pass attempts), and last year's volume is
// the strongest free prior. This pulls prior-season usage leaders from
// ESPN, converts to a per-game rate, and REGRESSES toward the positional
// mean (volume is sticky but not fully — role changes, committees). The
// output is a per-player workload baseline that seeds in-season prop
// edges once books post lines; it is NOT a bet by itself.
//   projected/g = mean + (lastYear/g − mean) × carryover
// Reference data, refreshed weekly. $0 — free ESPN leaders.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setNflProps } from '../../store/index.js';
import { lastCompletedSeason } from '../shared/nfl.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CARRY = Number(process.env.NFL_PROP_CARRYOVER) || 0.70; // volume stickiness year to year
// ESPN leader category → our normalized workload stat. Multiple candidate
// names per stat (ESPN naming drifts); first that resolves wins.
const WANTED = [
  { stat: 'rush_att', label: 'Rush Attempts', cats: ['rushingAttempts'] },
  { stat: 'targets', label: 'Targets', cats: ['receivingTargets', 'receptions'] },
  { stat: 'pass_att', label: 'Pass Attempts', cats: ['passingAttempts'] },
];

async function fetchLeaders(season) {
  const res = await fetch(`${BASE}/leaders?season=${season}&seasontype=2`);
  if (!res.ok) throw new Error(`ESPN leaders ${res.status}`);
  const data = await res.json();
  const cats = data?.leaders?.categories || data?.categories || [];
  const map = {}; // category name -> [{ name, team, value, games }]
  for (const c of cats) {
    const name = c.name || c.abbreviation;
    if (!name) continue;
    map[name] = (c.leaders || []).map((l) => {
      const a = l.athlete || {};
      return {
        name: a.displayName || a.shortName || '',
        team: (l.team || a.team || {}).abbreviation || (l.team || {}).displayName || '',
        value: Number(l.value),
        // ESPN sometimes nests games played in the athlete statistics; best-effort.
        games: Number(a.gamesPlayed) || null,
      };
    }).filter((x) => x.name && Number.isFinite(x.value));
  }
  return map;
}

async function run() {
  const season = lastCompletedSeason();
  let leaders;
  try { leaders = await fetchLeaders(season); }
  catch (e) { return { summary: `ESPN leaders fetch failed: ${e.message}` }; }

  const now = new Date().toISOString();
  const out = [];
  for (const { stat, label, cats } of WANTED) {
    const catName = cats.find((c) => (leaders[c] || []).length);
    const list = catName ? leaders[catName] : [];
    if (!list.length) continue;
    // Per-game rates (÷ games if known, else assume a full 17-game season).
    const perGame = list.map((p) => ({ ...p, pg: p.value / (p.games && p.games >= 1 ? p.games : 17) }));
    const mean = perGame.reduce((s, p) => s + p.pg, 0) / perGame.length;
    for (const p of perGame) {
      const projected = Math.round((mean + (p.pg - mean) * CARRY) * 10) / 10;
      out.push({
        season: season + 1, stat, stat_label: label, player: p.name, team: p.team,
        last_pg: Math.round(p.pg * 10) / 10, projected_pg: projected,
        games_est: !(p.games >= 1), updated_at: now,
      });
    }
  }
  // Keep the volume-relevant players (top by projected per game, per stat).
  const top = [];
  for (const { stat } of WANTED) {
    top.push(...out.filter((r) => r.stat === stat).sort((a, b) => b.projected_pg - a.projected_pg).slice(0, 40));
  }
  setNflProps(top);

  if (top.length) {
    try { await db.upsert('nfl_prop_baselines', top.map(({ games_est, ...r }) => r), 'season,stat,player'); }
    catch (e) { logger.warn('nfl-props', e.message); }
  }
  const byStat = WANTED.map(({ stat, label }) => `${label}:${out.filter((r) => r.stat === stat).length}`).join(', ');
  return { summary: out.length ? `workload baselines from ${season} · ${byStat}` : `no leader data for ${season} yet`, data: { players: top.length } };
}

export default { name: 'nfl-props', run };
