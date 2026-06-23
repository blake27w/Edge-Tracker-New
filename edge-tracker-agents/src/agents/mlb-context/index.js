// ══════════════════════════════════════════════════════════════
// MLB Context (Agent 10) — probable pitchers + bullpen fatigue from the
// free MLB StatsAPI (statsapi.mlb.com, no key). One schedule call covers
// the whole slate plus the prior 3 days of games (for fatigue), so this
// is essentially free and fast.
//
// Bullpen fatigue is a games-in-last-3-days heuristic (3-in-3 = high →
// tired pen → slight Over lean). Feeds totals scoring as a T2/T3 signal.
//
// Note: home-plate umpire O/U tendencies are NOT available free or in
// advance, so they're omitted here (they were a minor signal). To add
// them later, reintroduce a small Claude call keyed on the assigned ump.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

const DAY = 86400_000;
function ymd(d) { return d.toISOString().slice(0, 10); }

// Static park factors (well-established run environments), keyed by the home
// team name as The Odds API returns it. Pitcher parks support an Under lean
// (our bias); hitter parks an Over. Unlisted parks are neutral.
const PARK_FACTOR = {
  'Colorado Rockies': 'hitter', 'Cincinnati Reds': 'hitter', 'Boston Red Sox': 'hitter',
  'Baltimore Orioles': 'hitter', 'Arizona Diamondbacks': 'hitter', 'Philadelphia Phillies': 'hitter',
  'Texas Rangers': 'hitter', 'Kansas City Royals': 'hitter',
  'San Diego Padres': 'pitcher', 'San Francisco Giants': 'pitcher', 'Seattle Mariners': 'pitcher',
  'Miami Marlins': 'pitcher', 'New York Mets': 'pitcher', 'Detroit Tigers': 'pitcher',
  'Cleveland Guardians': 'pitcher', 'Tampa Bay Rays': 'pitcher', 'St. Louis Cardinals': 'pitcher',
  'Pittsburgh Pirates': 'pitcher', 'Oakland Athletics': 'pitcher', 'Athletics': 'pitcher',
};

async function fetchSchedule(startStr, endStr) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startStr}&endDate=${endStr}&hydrate=probablePitcher,team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB StatsAPI ${res.status}`);
  return res.json();
}

function fatigueLabel(count) {
  if (count >= 3) return 'high';
  if (count === 2) return 'medium';
  return 'low';
}

async function run() {
  const games = getGames().filter((g) => g.sport === 'MLB');
  if (!games.length) return { summary: 'no MLB games on the slate' };

  const today = new Date();
  const todayStr = ymd(today);
  let data;
  try {
    data = await fetchSchedule(ymd(new Date(today.getTime() - 3 * DAY)), todayStr);
  } catch (e) {
    return { summary: `MLB StatsAPI unavailable: ${e.message}` };
  }

  // Tally prior-3-day game counts per team (fatigue) and capture today's probables.
  const priorCounts = {};
  const probables = {}; // "Away@Home" -> { home, away }
  for (const day of data.dates || []) {
    for (const gm of day.games || []) {
      const home = gm.teams?.home?.team?.name;
      const away = gm.teams?.away?.team?.name;
      if (!home || !away) continue;
      if (gm.officialDate && gm.officialDate < todayStr) {
        priorCounts[home] = (priorCounts[home] || 0) + 1;
        priorCounts[away] = (priorCounts[away] || 0) + 1;
      } else {
        probables[`${away}@${home}`] = {
          home: gm.teams?.home?.probablePitcher?.fullName || null,
          away: gm.teams?.away?.probablePitcher?.fullName || null,
        };
      }
    }
  }

  const now = new Date().toISOString();
  const rows = games.map((g) => {
    const homeFat = fatigueLabel(priorCounts[g.home] || 0);
    const awayFat = fatigueLabel(priorCounts[g.away] || 0);
    const p = probables[`${g.away}@${g.home}`] || {};
    const pf = PARK_FACTOR[g.home] || 'neutral';
    // PARK-FACTOR ONLY. Bullpen fatigue now has its own agent (mlb-bullpen) that
    // measures real relief workload, so we don't double-count it here. Pitcher
    // park → Under (our bias); hitter park → Over; neutral → no lean. The
    // fatigue fields below are kept for display only.
    let lean;
    if (pf === 'pitcher') lean = 'under';
    else if (pf === 'hitter') lean = 'over';
    else lean = 'neutral';
    return {
      game_id: g.game_id, home: g.home, away: g.away,
      ump_name: null, ump_ou_tendency: null, ump_k_tendency: null,
      home_bullpen_fatigue: homeFat, away_bullpen_fatigue: awayFat,
      total_lean: lean,
      notes: `Park: ${pf}; probables ${p.away || '?'} (a) vs ${p.home || '?'} (h); pen fatigue H:${homeFat} A:${awayFat}`,
      fetched_at: now,
    };
  });

  if (rows.length) {
    try { await db.insert('mlb_context', rows); } catch (e) { logger.warn('mlb-context', e.message); }
  }
  setIntel('mlbContext', rows.map((r) => ({ ...r, sport: 'MLB' })));
  const unders = rows.filter((r) => r.total_lean === 'under').length;
  const overs = rows.filter((r) => r.total_lean === 'over').length;
  return {
    summary: `${rows.length} MLB context rows (${unders} Under / ${overs} Over leans) · free StatsAPI`,
    data: { count: rows.length, unders, overs },
  };
}

export default { name: 'mlb-context', run };
