// ══════════════════════════════════════════════════════════════
// NFL Prop Baselines — per-player workload from FREE ESPN box scores.
// (Replaces the old /leaders endpoint, which ESPN retired → 404.)
// For every skill player we build a game log this season plus a
// prior-season baseline, then a regressed projection per stat:
//   rush_att · rush_yds · targets · receptions · rec_yds · pass_att · pass_yds
// projected = w·season_pg + (1−w)·prior_pg, w = games/(games+4), so early
// in the year the prior carries weight and by Week 5 this season dominates.
// last_pg = last-3-game average (the trend), for spotting usage spikes.
// $0 — ESPN summary/box scores, cached per event. Runs daily.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setNflProps, setIntel } from '../../store/index.js';
import { getBox } from '../shared/espn.js';
import { getSeasonSchedule, upcomingSeason } from '../shared/nfl.js';

const PATH = 'football/nfl';
const REG_W = Number(process.env.NFL_PROP_REGRESS_GAMES) || 4;   // games until this season outweighs the prior
const USE_PRIOR = String(process.env.NFL_PROP_PRIOR ?? 'true').toLowerCase() !== 'false';
const STATS = [
  { stat: 'rush_att', label: 'Rush Attempts' }, { stat: 'rush_yds', label: 'Rush Yards' },
  { stat: 'targets', label: 'Targets' }, { stat: 'receptions', label: 'Receptions' }, { stat: 'rec_yds', label: 'Rec Yards' },
  { stat: 'pass_att', label: 'Pass Attempts' }, { stat: 'pass_yds', label: 'Pass Yards' },
];
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const fracAtt = (v) => { const m = /(\d+)\s*\/\s*(\d+)/.exec(String(v || '')); return m ? Number(m[2]) : 0; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
const r1 = (x) => Math.round((x || 0) * 10) / 10;
const avg = (arr, k) => (arr.length ? arr.reduce((t, g) => t + (g[k] || 0), 0) / arr.length : 0);
let priorCache = null;   // { season, logs } — built once per process

// One ESPN box → per-player stat lines for that game.
function parseBox(box) {
  const out = [];
  for (const side of box.players || []) {
    const team = side.team?.abbreviation || side.team?.displayName || '';
    const rows = {};
    for (const grp of side.statistics || []) {
      const g = norm(grp.name || grp.text || grp.type);
      const labels = (grp.labels || grp.keys || []).map((s) => String(s).toUpperCase());
      const idx = (l) => labels.indexOf(l);
      for (const a of grp.athletes || []) {
        const player = a.athlete?.displayName; if (!player) continue;
        const r = (rows[player] ||= { player, team, pos: a.athlete?.position?.abbreviation || null, rush_att: 0, rush_yds: 0, targets: 0, receptions: 0, rec_yds: 0, pass_att: 0, pass_yds: 0 });
        const s = a.stats || [];
        if (g.includes('passing')) { r.pass_att += fracAtt(s[idx('C/ATT')]); r.pass_yds += num(s[idx('YDS')]); }
        else if (g.includes('rushing')) { r.rush_att += num(s[idx('CAR')]); r.rush_yds += num(s[idx('YDS')]); }
        else if (g.includes('receiving')) { r.receptions += num(s[idx('REC')]); r.rec_yds += num(s[idx('YDS')]); const t = idx('TGTS'); r.targets += t >= 0 ? num(s[t]) : num(s[idx('REC')]); }
      }
    }
    out.push(...Object.values(rows));
  }
  return out;
}

// Game logs for a season: player -> { player, team, pos, games: [{week, ...stats}] }
async function seasonLogs(season, tag) {
  const sched = (await getSeasonSchedule(season)).filter((g) => g.completed).sort((a, b) => a.week - b.week);
  const logs = {};
  let boxes = 0;
  for (const g of sched) {
    const box = await getBox(PATH, g.id);
    if (!box) continue;
    boxes++;
    for (const r of parseBox(box)) {
      const p = (logs[r.player] ||= { player: r.player, team: r.team, pos: r.pos, games: [] });
      p.team = r.team || p.team; p.pos = r.pos || p.pos;
      p.games.push({ week: g.week, rush_att: r.rush_att, rush_yds: r.rush_yds, targets: r.targets, receptions: r.receptions, rec_yds: r.rec_yds, pass_att: r.pass_att, pass_yds: r.pass_yds });
    }
  }
  logger.info('nfl-props', `${tag}: ${boxes} boxes, ${Object.keys(logs).length} players`);
  return logs;
}

async function run() {
  const season = upcomingSeason();
  let cur;
  try { cur = await seasonLogs(season, `${season}`); }
  catch (e) { return { summary: `ESPN box fetch failed: ${e.message}` }; }
  if (USE_PRIOR && (!priorCache || priorCache.season !== season - 1)) {
    try { priorCache = { season: season - 1, logs: await seasonLogs(season - 1, `${season - 1} prior`) }; }
    catch (e) { logger.warn('nfl-props', `prior season: ${e.message}`); priorCache = { season: season - 1, logs: {} }; }
  }
  const prior = priorCache?.logs || {};
  const now = new Date().toISOString();

  // Per-player projections.
  const players = [];
  for (const name of new Set([...Object.keys(cur), ...Object.keys(prior)])) {
    const c = cur[name], p = prior[name];
    const games = c?.games || [], pg = p?.games || [];
    if (!games.length && pg.length < 8) continue;            // fringe prior-only players
    const w = games.length / (games.length + REG_W);
    const last3 = games.slice(-3);
    const row = { player: name, team: c?.team || p?.team || '', pos: c?.pos || p?.pos || null, games: games.length, prior_games: pg.length, season, updated_at: now };
    for (const { stat } of STATS) {
      const s = avg(games, stat), pr = avg(pg, stat), l3 = avg(last3, stat);
      row[stat] = { season_pg: r1(s), prior_pg: r1(pr), last3_pg: r1(l3), projected_pg: r1(pg.length ? w * s + (1 - w) * pr : s) };
    }
    players.push(row);
  }

  // Flatten to the baseline table shape (top 40 per stat) — keeps the app's NFL Prep tab working.
  const flat = [];
  for (const { stat, label } of STATS) {
    const top = players.filter((p) => p[stat].projected_pg > 0).sort((a, b) => b[stat].projected_pg - a[stat].projected_pg).slice(0, 40);
    for (const p of top) flat.push({ season, stat, stat_label: label, player: p.player, team: p.team, last_pg: p[stat].last3_pg || p[stat].prior_pg, projected_pg: p[stat].projected_pg, updated_at: now });
  }
  setNflProps(flat);
  setIntel('propLogs', players);
  if (flat.length) { try { await db.upsert('nfl_prop_baselines', flat, 'season,stat,player'); } catch (e) { logger.warn('nfl-props', e.message); } }

  const wks = Object.values(cur).reduce((m, p) => Math.max(m, p.games.length), 0);
  return { summary: `${players.length} players · ${wks} wk${wks === 1 ? '' : 's'} of ${season}${Object.keys(prior).length ? ` + ${season - 1} prior` : ''} · free ESPN boxes`, data: { players: players.length, baselines: flat.length } };
}

export default { name: 'nfl-props', run };
