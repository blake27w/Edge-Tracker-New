// ══════════════════════════════════════════════════════════════
// NFL Coaching / Pace (totals context). True snap-pace data needs a
// verified play-by-play feed we don't have for free, so this uses a
// CURATED team-tempo map (offensive identity: pace + pass tendency) the
// same way the MLB agent uses static park factors. It produces a totals
// lean per matchup — slow + run-heavy → Under (our bias); fast + pass-
// heavy → Over. Only clearly-identified teams are labeled; everything
// else stays neutral, so it can't manufacture a wrong signal.
//
// MAINTENANCE: offensive identity shifts with coaching changes — review
// the map each offseason. Override without a deploy via NFL_PACE_OVERRIDES
// (JSON: {"Chicago Bears":{"pace":"slow","pass":"run"}}). Reference /
// observational — NOT wired into the signal engine until validated. $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setNflPace } from '../../store/index.js';
import { getSeasonSchedule, teamSchedules, upcomingSeason, norm } from '../shared/nfl.js';
import { computeMarkets } from '../../games/lines.js';

// pace: fast | avg | slow   ·   pass: pass | bal | run  (2025-season identities)
const TEMPO = {
  'Miami Dolphins': { pace: 'fast', pass: 'pass' }, 'Buffalo Bills': { pace: 'fast', pass: 'pass' },
  'Cincinnati Bengals': { pace: 'fast', pass: 'pass' }, 'Detroit Lions': { pace: 'fast', pass: 'bal' },
  'Kansas City Chiefs': { pace: 'avg', pass: 'pass' }, 'Tampa Bay Buccaneers': { pace: 'avg', pass: 'pass' },
  'Dallas Cowboys': { pace: 'avg', pass: 'pass' }, 'Los Angeles Rams': { pace: 'avg', pass: 'pass' },
  'Washington Commanders': { pace: 'fast', pass: 'bal' }, 'Jacksonville Jaguars': { pace: 'avg', pass: 'pass' },
  'Green Bay Packers': { pace: 'avg', pass: 'bal' }, 'Los Angeles Chargers': { pace: 'avg', pass: 'pass' },
  // Run-heavy / methodical → Under context
  'Tennessee Titans': { pace: 'slow', pass: 'run' }, 'New England Patriots': { pace: 'slow', pass: 'run' },
  'Atlanta Falcons': { pace: 'slow', pass: 'run' }, 'Chicago Bears': { pace: 'slow', pass: 'run' },
  'Carolina Panthers': { pace: 'slow', pass: 'run' }, 'New York Giants': { pace: 'slow', pass: 'run' },
  'Pittsburgh Steelers': { pace: 'slow', pass: 'bal' }, 'Cleveland Browns': { pace: 'slow', pass: 'run' },
  'Las Vegas Raiders': { pace: 'slow', pass: 'bal' }, 'New York Jets': { pace: 'slow', pass: 'run' },
  'Baltimore Ravens': { pace: 'avg', pass: 'run' }, 'Philadelphia Eagles': { pace: 'avg', pass: 'run' },
  'Indianapolis Colts': { pace: 'avg', pass: 'run' }, 'Minnesota Vikings': { pace: 'avg', pass: 'bal' },
  'New Orleans Saints': { pace: 'slow', pass: 'bal' }, 'Denver Broncos': { pace: 'avg', pass: 'bal' },
};
// Optional env overrides (corrections without a deploy).
try { const o = JSON.parse(process.env.NFL_PACE_OVERRIDES || '{}'); for (const [k, v] of Object.entries(o)) TEMPO[k] = { ...TEMPO[k], ...v }; } catch (_) { /* ignore bad JSON */ }

const matchTeam = (name, teams) => teams.find((t) => { const x = norm(t), y = norm(name); return x === y || x.includes(y) || y.includes(x) || x.split(' ').pop() === y.split(' ').pop(); });

// Tendency score: + = Over-leaning (fast/pass), − = Under-leaning (slow/run).
function leanOf(team) {
  const t = TEMPO[team]; if (!t) return 0;
  let s = 0;
  if (t.pace === 'fast') s += 1; else if (t.pace === 'slow') s -= 1;
  if (t.pass === 'pass') s += 0.5; else if (t.pass === 'run') s -= 0.5;
  return s;
}
function gameLean(a, b) {
  const s = leanOf(a) + leanOf(b);
  return s >= 1 ? 'over' : s <= -1 ? 'under' : 'neutral';
}

async function run() {
  const teams = Object.keys(TEMPO);
  const now = new Date().toISOString();

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
    const lean = gameLean(g.home, g.away);
    if (lean === 'neutral') continue;
    const total = g.consensusTotal ?? computeMarkets(g).total.consensus;
    live.push({ game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, lean, total: total ?? null });
  }

  setNflPace({
    updated: now,
    teams: teams.map((t) => ({ team: t, ...TEMPO[t], lean: leanOf(t) })).sort((a, b) => a.lean - b.lean),
    games: games.slice(0, 64), live,
  });

  if (teams.length) {
    try { await db.upsert('nfl_pace', teams.map((t) => ({ season, team: t, pace: TEMPO[t].pace, pass: TEMPO[t].pass, lean: leanOf(t), updated_at: now })), 'season,team'); }
    catch (e) { logger.warn('nfl-pace', e.message); }
  }
  const unders = games.filter((g) => g.lean === 'under').length;
  return { summary: `NFL pace: ${teams.length} teams mapped · ${games.length} game leans (${unders} Under)${live.length ? ` · ${live.length} live` : ''}`, data: { teams: teams.length, games: games.length, live: live.length } };
}

export default { name: 'nfl-pace', run };
