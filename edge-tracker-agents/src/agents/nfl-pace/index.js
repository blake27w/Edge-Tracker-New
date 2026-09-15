// ══════════════════════════════════════════════════════════════
// NFL Coaching / Pace (totals context) — now MEASURED. Team tempo and
// pass tendency come from nflverse play-by-play (plays/game, pass rate,
// EPA/play, no-huddle rate): the current season once 2+ weeks are in the
// books, else the prior completed season. The old curated tempo map
// remains only as a fallback for when the feed is unreachable. Output is
// unchanged: a totals lean per matchup — slow + run-heavy → Under (our
// bias); fast + pass-heavy → Over. Teams sit in the middle terciles stay
// neutral, so the agent can't manufacture a wrong signal.
//
// Override without a deploy via NFL_PACE_OVERRIDES
// (JSON: {"Chicago Bears":{"pace":"slow","pass":"run"}}). Reference /
// observational — NOT wired into the signal engine until validated. $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setNflPace } from '../../store/index.js';
import { getSeasonSchedule, upcomingSeason, norm } from '../shared/nfl.js';
import { teamProfile } from '../shared/nflverse.js';
import { computeMarkets } from '../../games/lines.js';

// Fallback identities (2025 curation) — used only if nflverse is down.
const CURATED = {
  'Miami Dolphins': { pace: 'fast', pass: 'pass' }, 'Buffalo Bills': { pace: 'fast', pass: 'pass' },
  'Cincinnati Bengals': { pace: 'fast', pass: 'pass' }, 'Detroit Lions': { pace: 'fast', pass: 'bal' },
  'Kansas City Chiefs': { pace: 'avg', pass: 'pass' }, 'Tampa Bay Buccaneers': { pace: 'avg', pass: 'pass' },
  'Dallas Cowboys': { pace: 'avg', pass: 'pass' }, 'Los Angeles Rams': { pace: 'avg', pass: 'pass' },
  'Washington Commanders': { pace: 'fast', pass: 'bal' }, 'Jacksonville Jaguars': { pace: 'avg', pass: 'pass' },
  'Green Bay Packers': { pace: 'avg', pass: 'bal' }, 'Los Angeles Chargers': { pace: 'avg', pass: 'pass' },
  'Tennessee Titans': { pace: 'slow', pass: 'run' }, 'New England Patriots': { pace: 'slow', pass: 'run' },
  'Atlanta Falcons': { pace: 'slow', pass: 'run' }, 'Chicago Bears': { pace: 'slow', pass: 'run' },
  'Carolina Panthers': { pace: 'slow', pass: 'run' }, 'New York Giants': { pace: 'slow', pass: 'run' },
  'Pittsburgh Steelers': { pace: 'slow', pass: 'bal' }, 'Cleveland Browns': { pace: 'slow', pass: 'run' },
  'Las Vegas Raiders': { pace: 'slow', pass: 'bal' }, 'New York Jets': { pace: 'slow', pass: 'run' },
  'Baltimore Ravens': { pace: 'avg', pass: 'run' }, 'Philadelphia Eagles': { pace: 'avg', pass: 'run' },
  'Indianapolis Colts': { pace: 'avg', pass: 'run' }, 'Minnesota Vikings': { pace: 'avg', pass: 'bal' },
  'New Orleans Saints': { pace: 'slow', pass: 'bal' }, 'Denver Broncos': { pace: 'avg', pass: 'bal' },
};

const MIN_LIVE_WEEKS = Number(process.env.NFL_PACE_MIN_WEEKS) || 2;

// Tercile labeler: top third of `key` → hi label, bottom third → lo label.
function labelTerciles(profiles, key, hi, mid, lo) {
  const sorted = [...profiles].sort((a, b) => b[key] - a[key]);
  const n = sorted.length;
  const out = new Map();
  sorted.forEach((p, i) => out.set(p.team, i < n / 3 ? hi : i >= (2 * n) / 3 ? lo : mid));
  return out;
}

// Measured identities from pbp: current season at 2+ weeks, else prior.
async function measuredTempo() {
  const season = upcomingSeason();
  let prof = null, label = '';
  try {
    const cur = await teamProfile(season);
    if (cur.weeks >= MIN_LIVE_WEEKS && Object.keys(cur.teams).length >= 30) {
      prof = cur; label = `measured pbp (${season} wk ${cur.weeks})`;
    }
  } catch (_) { /* fall through to prior season */ }
  if (!prof) {
    const prior = await teamProfile(season - 1); // throws if unreachable → curated fallback
    prof = prior; label = `measured pbp (${season - 1})`;
  }
  const list = Object.values(prof.teams);
  const paceOf = labelTerciles(list, 'plays_pg', 'fast', 'avg', 'slow');
  const passOf = labelTerciles(list, 'pass_rate', 'pass', 'bal', 'run');
  const tempo = {};
  for (const p of list) {
    tempo[p.team] = {
      pace: paceOf.get(p.team), pass: passOf.get(p.team),
      plays_pg: p.plays_pg, pass_rate: p.pass_rate, epa_play: p.epa_play,
      no_huddle_rate: p.no_huddle_rate, games: p.games,
    };
  }
  return { tempo, label };
}

const matchTeam = (name, teams) => teams.find((t) => { const x = norm(t), y = norm(name); return x === y || x.includes(y) || y.includes(x) || x.split(' ').pop() === y.split(' ').pop(); });

// Tendency score: + = Over-leaning (fast/pass), − = Under-leaning (slow/run).
function leanOf(tempo, team) {
  const t = tempo[team]; if (!t) return 0;
  let s = 0;
  if (t.pace === 'fast') s += 1; else if (t.pace === 'slow') s -= 1;
  if (t.pass === 'pass') s += 0.5; else if (t.pass === 'run') s -= 0.5;
  return s;
}

async function run() {
  let tempo, source;
  try { ({ tempo, label: source } = await measuredTempo()); }
  catch (e) {
    logger.warn('nfl-pace', `nflverse unreachable (${e.message}) — curated fallback`);
    tempo = { ...CURATED }; source = 'curated map';
  }
  // Env overrides beat everything (corrections without a deploy).
  try { const o = JSON.parse(process.env.NFL_PACE_OVERRIDES || '{}'); for (const [k, v] of Object.entries(o)) tempo[k] = { ...tempo[k], ...v }; } catch (_) { /* ignore bad JSON */ }

  const teams = Object.keys(tempo);
  const now = new Date().toISOString();
  const gameLean = (a, b) => { const s = leanOf(tempo, a) + leanOf(tempo, b); return s >= 1 ? 'over' : s <= -1 ? 'under' : 'neutral'; };

  // Projected schedule leans (reference, year-round).
  const season = upcomingSeason();
  const games = [];
  try {
    const sched = await getSeasonSchedule(season);
    const seen = new Set();
    for (const g of sched) {
      const home = matchTeam(g.home, teams), away = matchTeam(g.away, teams);
      const key = `${g.week}|${g.away}|${g.home}`;
      if (seen.has(key)) continue; seen.add(key);
      const lean = gameLean(away || g.away, home || g.home);
      if (lean !== 'neutral') games.push({ week: g.week, away: g.away, home: g.home, lean });
    }
  } catch (_) { /* schedule not posted yet */ }
  games.sort((a, b) => a.week - b.week);

  // Live NFL games on the slate → pace lean vs the posted total (in-season).
  const live = [];
  for (const g of getGames().filter((x) => x.sport === 'NFL')) {
    const home = matchTeam(g.home, teams), away = matchTeam(g.away, teams);
    const lean = gameLean(away || g.away, home || g.home);
    if (lean === 'neutral') continue;
    const total = g.consensusTotal ?? computeMarkets(g).total.consensus;
    live.push({ game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, lean, total: total ?? null });
  }

  setNflPace({
    updated: now, source,
    teams: teams.map((t) => ({ team: t, ...tempo[t], lean: leanOf(tempo, t) })).sort((a, b) => a.lean - b.lean),
    games: games.slice(0, 64), live,
  });

  if (teams.length) {
    try { await db.upsert('nfl_pace', teams.map((t) => ({ season, team: t, pace: tempo[t].pace, pass: tempo[t].pass, lean: leanOf(tempo, t), updated_at: now })), 'season,team'); }
    catch (e) { logger.warn('nfl-pace', e.message); }
  }
  const unders = games.filter((g) => g.lean === 'under').length;
  return { summary: `NFL pace [${source}]: ${teams.length} teams · ${games.length} game leans (${unders} Under)${live.length ? ` · ${live.length} live` : ''}`, data: { teams: teams.length, games: games.length, live: live.length, source } };
}

export default { name: 'nfl-pace', run };
