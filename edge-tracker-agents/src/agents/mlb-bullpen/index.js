// ══════════════════════════════════════════════════════════════
// MLB Bullpen Fatigue → Over lean. A pen that threw heavy the last two
// days is vulnerable late — books underweight it. The old mlb-context
// fatigue was a crude games-in-3-days count; this measures the real thing:
// relief innings actually pitched, from free StatsAPI box scores.
//
// For each team on today's slate we sum reliever outs over the prior two
// days; if a team's pen is gassed (>= threshold), its games today get an
// OBSERVATIONAL Over lean the signal engine reads as a supporting (Tier-2)
// signal. Cold start / missing box scores = no signal (never fabricated). $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

const DAY = 86400_000;
const RELIEF_OUTS = Number(process.env.BULLPEN_RELIEF_OUTS) || 21; // ~7 IP of relief over 2 days = gassed
function ymd(d) { return d.toISOString().slice(0, 10); }

// "5.2" innings → outs (5*3 + 2). Returns 0 on bad input.
function ipToOuts(ip) {
  const n = parseFloat(ip);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 10); // .1 = 1 out, .2 = 2 outs
  return whole * 3 + (frac >= 1 && frac <= 2 ? frac : 0);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`StatsAPI ${res.status}`);
  return res.json();
}

// Relief outs (non-starters) for both teams in one box score → { teamName: outs }.
function reliefOutsFromBox(box) {
  const out = {};
  for (const side of ['home', 'away']) {
    const t = box?.teams?.[side];
    const name = t?.team?.name;
    if (!name) continue;
    let outs = 0;
    const players = t.players || {};
    for (const pid of Object.keys(players)) {
      const pit = players[pid]?.stats?.pitching;
      if (!pit || pit.inningsPitched == null) continue;
      if (Number(pit.gamesStarted) === 1) continue; // skip the starter
      outs += ipToOuts(pit.inningsPitched);
    }
    out[name] = (out[name] || 0) + outs;
  }
  return out;
}

async function run() {
  const games = getGames().filter((g) => g.sport === 'MLB');
  if (!games.length) { setIntel('bullpenFatigue', []); return { summary: 'no MLB games on the slate' }; }

  const todayTeams = new Set();
  for (const g of games) { todayTeams.add(g.home); todayTeams.add(g.away); }

  const today = new Date();
  let sched;
  try {
    sched = await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${ymd(new Date(today.getTime() - 2 * DAY))}&endDate=${ymd(new Date(today.getTime() - DAY))}&hydrate=team`);
  } catch (e) { setIntel('bullpenFatigue', []); return { summary: `MLB StatsAPI unavailable: ${e.message}` }; }

  // gamePks from the prior 2 days that involve a team playing today.
  const pks = [];
  for (const day of sched.dates || []) {
    for (const gm of day.games || []) {
      const home = gm.teams?.home?.team?.name, away = gm.teams?.away?.team?.name;
      const isFinal = /final/i.test(gm.status?.detailedState || '') || gm.status?.codedGameState === 'F';
      if (isFinal && (todayTeams.has(home) || todayTeams.has(away)) && gm.gamePk) pks.push(gm.gamePk);
    }
  }

  // Sum relief outs per team across those games.
  const reliefOuts = {};
  let boxes = 0;
  for (const pk of pks) {
    try {
      const box = await fetchJson(`https://statsapi.mlb.com/api/v1/game/${pk}/boxscore`);
      boxes++;
      const ro = reliefOutsFromBox(box);
      for (const [team, outs] of Object.entries(ro)) reliefOuts[team] = (reliefOuts[team] || 0) + outs;
    } catch (e) { logger.warn('mlb-bullpen', `box ${pk}: ${e.message}`); }
  }

  const rows = [];
  for (const g of games) {
    const homeOuts = reliefOuts[g.home] || 0, awayOuts = reliefOuts[g.away] || 0;
    const gassed = [];
    if (homeOuts >= RELIEF_OUTS) gassed.push(`${g.home} ${(homeOuts / 3).toFixed(1)} IP`);
    if (awayOuts >= RELIEF_OUTS) gassed.push(`${g.away} ${(awayOuts / 3).toFixed(1)} IP`);
    if (!gassed.length) continue;
    rows.push({
      game_id: g.game_id, sport: 'MLB', home: g.home, away: g.away, lean: 'over',
      home_relief_outs: homeOuts, away_relief_outs: awayOuts,
      note: `Gassed pen (last 2d): ${gassed.join(', ')} → Over`,
    });
  }
  setIntel('bullpenFatigue', rows);

  return {
    summary: `${rows.length} gassed-pen Over leans from ${boxes} box scores (${pks.length} recent games) · free StatsAPI`,
    data: { leans: rows.length, boxes },
  };
}

export default { name: 'mlb-bullpen', run };
