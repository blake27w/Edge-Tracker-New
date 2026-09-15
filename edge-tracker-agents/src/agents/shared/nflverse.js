// ══════════════════════════════════════════════════════════════
// Shared nflverse data helpers ($0). nflverse publishes the gold-standard
// open NFL datasets as static CSVs on GitHub releases — play-by-play with
// EPA per play, and per-player weekly stat lines. This gives us the two
// things free ESPN can't: real measured pace/efficiency (the pace agent's
// header used to admit "true snap-pace data needs a feed we don't have")
// and exact per-week player usage (ESPN retired its /leaders endpoint).
//   playerUsage(season) → per-player season usage (carries/targets/attempts
//                         + real games played) from stats_player_week
//   teamProfile(season) → per-team measured identity from play-by-play:
//                         plays/game, pass rate, EPA/play, no-huddle rate
// Long-TTL in-memory cache; files update ~nightly upstream. Data late in
// a season is a few MB gzipped — parsed row-by-row, keeping only the
// columns asked for, so memory stays flat.
// ══════════════════════════════════════════════════════════════
import zlib from 'node:zlib';

const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
const TTL = Number(process.env.NFLVERSE_TTL_MS) || 12 * 3600_000;
const cache = new Map(); // key -> { at, data }

// nflverse team abbreviation → full name (for joining against odds feeds).
export const TEAM_NAMES = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens',
  BUF: 'Buffalo Bills', CAR: 'Carolina Panthers', CHI: 'Chicago Bears',
  CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys',
  DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars',
  KC: 'Kansas City Chiefs', LA: 'Los Angeles Rams', LAC: 'Los Angeles Chargers',
  LV: 'Las Vegas Raiders', MIA: 'Miami Dolphins', MIN: 'Minnesota Vikings',
  NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants',
  NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers',
  SEA: 'Seattle Seahawks', SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers',
  TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};

// Quote-aware CSV field split (pbp's desc column contains commas).
function splitCsv(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchRows(url, { gz = false, columns }) {
  const key = `${url}|${columns.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  // Follows the GitHub → CDN redirect; one retry rides out transient
  // connect timeouts / 5xx from GitHub's release endpoint.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url);
      if (res.ok) break;
      if (attempt >= 1) throw new Error(`nflverse ${res.status} for ${url.split('/').pop()}`);
    } catch (e) {
      if (attempt >= 1) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  let text = gz
    ? zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8')
    : await res.text();

  const nl = text.indexOf('\n');
  const header = splitCsv(text.slice(0, nl).trim());
  const idx = columns.map((c) => header.indexOf(c));
  if (idx.some((i) => i < 0)) {
    const missing = columns.filter((c, j) => idx[j] < 0);
    throw new Error(`nflverse columns missing: ${missing.join(',')} in ${url.split('/').pop()}`);
  }
  const needQuoteParse = text.includes('"');
  const rows = [];
  let start = nl + 1;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line.trim()) continue;
    const f = needQuoteParse ? splitCsv(line) : line.split(',');
    const row = {};
    for (let j = 0; j < columns.length; j++) row[columns[j]] = f[idx[j]];
    rows.push(row);
  }
  text = null; // release the big string before caching the small result
  cache.set(key, { at: Date.now(), data: rows });
  return rows;
}

// Per-player season usage from weekly stat lines. Real games played
// (weeks with a stat line), not an assumed 17.
export async function playerUsage(season) {
  const rows = await fetchRows(
    `${REL}/stats_player/stats_player_week_${season}.csv`,
    { columns: ['player_display_name', 'position', 'team', 'week', 'season_type', 'attempts', 'carries', 'targets'] },
  );
  const players = new Map();
  for (const r of rows) {
    if (r.season_type && r.season_type !== 'REG') continue;
    const name = r.player_display_name;
    if (!name) continue;
    const p = players.get(name) || { name, position: r.position || '', team: r.team || '', games: 0, pass_att: 0, rush_att: 0, targets: 0 };
    p.team = r.team || p.team; // last team of the season wins
    p.games += 1;
    p.pass_att += Number(r.attempts) || 0;
    p.rush_att += Number(r.carries) || 0;
    p.targets += Number(r.targets) || 0;
    players.set(name, p);
  }
  return [...players.values()];
}

// Per-team measured identity from play-by-play. Offensive snaps only
// (pass/run plays with a valid EPA — no kneels, spikes, or special teams).
export async function teamProfile(season) {
  const rows = await fetchRows(
    `${REL}/pbp/play_by_play_${season}.csv.gz`,
    { gz: true, columns: ['game_id', 'week', 'posteam', 'play_type', 'epa', 'no_huddle'] },
  );
  const teams = new Map();
  const weeks = new Set();
  for (const r of rows) {
    if (!r.posteam || (r.play_type !== 'pass' && r.play_type !== 'run')) continue;
    const epa = Number(r.epa);
    if (!Number.isFinite(epa)) continue;
    weeks.add(Number(r.week) || 0);
    const t = teams.get(r.posteam) || { plays: 0, pass: 0, epa: 0, no_huddle: 0, games: new Set() };
    t.plays += 1;
    if (r.play_type === 'pass') t.pass += 1;
    t.epa += epa;
    if (r.no_huddle === '1') t.no_huddle += 1;
    t.games.add(r.game_id);
    teams.set(r.posteam, t);
  }
  const out = {};
  for (const [abbr, t] of teams) {
    if (!t.games.size) continue;
    out[abbr] = {
      team: TEAM_NAMES[abbr] || abbr,
      games: t.games.size,
      plays_pg: Math.round((t.plays / t.games.size) * 10) / 10,
      pass_rate: Math.round((t.pass / t.plays) * 1000) / 1000,
      epa_play: Math.round((t.epa / t.plays) * 1000) / 1000,
      no_huddle_rate: Math.round((t.no_huddle / t.plays) * 1000) / 1000,
    };
  }
  return { season, weeks: Math.max(0, ...weeks), teams: out };
}

export default { playerUsage, teamProfile, TEAM_NAMES };
