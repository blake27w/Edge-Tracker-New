// ══════════════════════════════════════════════════════════════
// MLB Home-Plate Umpire → totals lean. The classic free, under-priced
// totals edge: each plate umpire has a measurable run environment (zone
// size). Books barely move totals for the assignment.
//
// We can't BUY ump tendencies, but we can LEARN them for free: walk this
// season's completed games (StatsAPI, no key) with officials + final
// scores, accumulate runs-per-game per home-plate ump, and compare to the
// league average. Then for today's slate we read the assigned plate ump
// and, if they have enough history and a meaningful deviation, emit an
// OBSERVATIONAL totals lean that the signal engine reads as a supporting
// (Tier-2) signal — it can never qualify a play alone, and it's validated
// via CLV before it counts. Cold start = no signal (never fabricated). $0.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

const MIN_GAMES = Number(process.env.UMP_MIN_GAMES) || 25;          // below this = too small to trust
const RUN_THRESH = Number(process.env.UMP_RUN_THRESHOLD) || 0.4;    // runs/game vs league avg to call a lean
function ymd(d) { return d.toISOString().slice(0, 10); }

// Pull the home-plate umpire from a StatsAPI game's officials array.
function platekUmp(gm) {
  for (const o of gm.officials || []) {
    if (/home\s*plate/i.test(o.officialType || '')) return o.official?.fullName || null;
  }
  return null;
}
function finalRuns(gm) {
  const h = gm.teams?.home?.score, a = gm.teams?.away?.score;
  if (Number.isFinite(h) && Number.isFinite(a)) return h + a;
  const lh = gm.linescore?.teams?.home?.runs, la = gm.linescore?.teams?.away?.runs;
  if (Number.isFinite(lh) && Number.isFinite(la)) return lh + la;
  return null;
}
function isFinal(gm) {
  const s = gm.status || {};
  return s.abstractGameState === 'Final' || s.codedGameState === 'F' || s.detailedState === 'Final';
}

async function fetchSchedule(start, end, hydrate) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=${hydrate}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB StatsAPI ${res.status}`);
  return res.json();
}

// Learn each plate ump's runs/game from this season's completed games.
async function learnTendencies(todayStr) {
  const seasonStart = `${new Date().getUTCFullYear()}-03-01`;
  const data = await fetchSchedule(seasonStart, todayStr, 'officials,linescore');
  const acc = {}; // ump -> { games, runs }
  let leagueGames = 0, leagueRuns = 0;
  for (const day of data.dates || []) {
    for (const gm of day.games || []) {
      if (!isFinal(gm)) continue;
      const runs = finalRuns(gm);
      if (runs == null) continue;
      leagueGames++; leagueRuns += runs;
      const ump = platekUmp(gm);
      if (!ump) continue;
      const a = (acc[ump] ||= { games: 0, runs: 0 });
      a.games++; a.runs += runs;
    }
  }
  const leagueAvg = leagueGames ? leagueRuns / leagueGames : null;
  return { acc, leagueAvg, leagueGames };
}

async function run() {
  const games = getGames().filter((g) => g.sport === 'MLB');
  if (!games.length) { setIntel('umpire', []); return { summary: 'no MLB games on the slate' }; }

  const todayStr = ymd(new Date());
  let learned;
  try { learned = await learnTendencies(todayStr); }
  catch (e) { setIntel('umpire', []); return { summary: `MLB StatsAPI unavailable: ${e.message}` }; }

  const { acc, leagueAvg, leagueGames } = learned;
  if (!leagueAvg || !leagueGames) { setIntel('umpire', []); return { summary: 'no completed games to learn from yet' }; }

  // Build the tendency table (umps with a real sample) and persist it.
  const now = new Date().toISOString();
  const tend = {}; // ump -> { idx, games, avg }
  const tendRows = [];
  let withOfficials = 0;
  for (const [ump, a] of Object.entries(acc)) {
    withOfficials += a.games;
    const avg = a.runs / a.games;
    const idx = Math.round((avg - leagueAvg) * 100) / 100; // +runs above league avg = Over-leaning
    if (a.games >= MIN_GAMES) tend[ump] = { idx, games: a.games, avg: Math.round(avg * 100) / 100 };
    tendRows.push({ umpire: ump, games: a.games, avg_runs: Math.round(avg * 100) / 100, run_index: idx, league_avg: Math.round(leagueAvg * 100) / 100, updated_at: now });
  }
  if (tendRows.length) { try { await db.upsert('umpire_runs', tendRows, 'umpire'); } catch (e) { logger.warn('mlb-umpire', e.message); } }
  // If StatsAPI gave us no officials at all, we learned nothing — say so plainly.
  if (!withOfficials) { setIntel('umpire', []); return { summary: `learned 0 ump assignments from ${leagueGames} games (StatsAPI officials unavailable)` }; }

  // Today's assignments → leans for games whose plate ump has a trusted sample.
  let today;
  try { today = await fetchSchedule(todayStr, todayStr, 'officials,team'); }
  catch (e) { setIntel('umpire', []); return { summary: `today's officials unavailable: ${e.message}` }; }

  const assigned = {}; // "Away@Home" -> ump
  for (const day of today.dates || []) {
    for (const gm of day.games || []) {
      const home = gm.teams?.home?.team?.name, away = gm.teams?.away?.team?.name;
      const ump = platekUmp(gm);
      if (home && away && ump) assigned[`${away}@${home}`] = ump;
    }
  }

  const rows = [];
  for (const g of games) {
    const ump = assigned[`${g.away}@${g.home}`];
    const t = ump && tend[ump];
    if (!t || Math.abs(t.idx) < RUN_THRESH) continue;
    rows.push({
      game_id: g.game_id, sport: 'MLB', home: g.home, away: g.away,
      umpire: ump, run_index: t.idx, games: t.games,
      lean: t.idx > 0 ? 'over' : 'under',
      note: `Ump ${ump}: ${t.idx > 0 ? '+' : ''}${t.idx} runs/g vs lg avg over ${t.games} g`,
    });
  }
  setIntel('umpire', rows);

  const assignedToday = Object.keys(assigned).length;
  return {
    summary: `${rows.length} ump totals leans · ${Object.keys(tend).length} umps with ${MIN_GAMES}+ g · ${assignedToday} assigned today · lg avg ${Math.round(leagueAvg * 10) / 10} r/g`,
    data: { leans: rows.length, umpsTracked: Object.keys(tend).length, assignedToday },
  };
}

export default { name: 'mlb-umpire', run };
