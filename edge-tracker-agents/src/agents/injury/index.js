// ══════════════════════════════════════════════════════════════
// Injury Intelligence — pulls injury reports from ESPN's free public
// feed (no key), one call per league on the slate, and attaches them to
// today's games. Replaces the old Claude web-search version: $0 per call.
// Flags starters ruled OUT, which the Prop Engine consumes for
// speed-game stale-line alerts.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

// monitor sport → ESPN path. (Soccer/UFC/Tennis/Golf have no equivalent feed.)
const ESPN_PATH = { MLB: 'baseball/mlb', NBA: 'basketball/nba', NHL: 'hockey/nhl', NFL: 'football/nfl' };

export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

function mapStatus(s) {
  const t = norm(s);
  if (/(^|\b)(out|injured reserve|\d+-day il|\bil\b|suspend)/.test(t)) return 'OUT';
  if (t.includes('doubtful')) return 'DOUBTFUL';
  if (t.includes('questionable')) return 'QUESTIONABLE';
  if (t.includes('day') || t.includes('gtd') || t.includes('probable')) return 'GTD';
  return (s || '').toUpperCase() || 'ACTIVE';
}
function impactOf(status) {
  if (status === 'OUT' || status === 'DOUBTFUL') return 'high';
  if (status === 'QUESTIONABLE') return 'medium';
  return 'low';
}

export async function fetchInjuries(sport) {
  const path = ESPN_PATH[sport];
  if (!path) return new Map();
  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/injuries`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN injuries ${res.status} ${sport}`);
  const data = await res.json();
  // teamName(normalized) -> [{ player, status, impact, detail }]
  const byTeam = new Map();
  for (const team of data.injuries || []) {
    const teamName = team.displayName || team.team?.displayName;
    if (!teamName) continue;
    const list = [];
    for (const inj of team.injuries || []) {
      const player = inj.athlete?.displayName;
      if (!player) continue;
      const status = mapStatus(inj.status);
      const pos = inj.athlete?.position?.abbreviation || null;
      const detail = inj.shortComment || inj.longComment || inj.type?.description || inj.type?.name || null;
      list.push({ player, status, impact: impactOf(status), pos, detail: pos ? `${pos} — ${detail || status}` : detail });
    }
    if (list.length) byTeam.set(norm(teamName), list);
  }
  return byTeam;
}

// Find a team's injuries allowing nickname-contains matching.
export function lookup(byTeam, oddsName) {
  const key = norm(oddsName);
  if (byTeam.has(key)) return byTeam.get(key);
  for (const [name, list] of byTeam) {
    const nick = name.split(' ').slice(-1)[0];
    if (key.includes(nick) || name.includes(key)) return list;
  }
  return [];
}

async function run() {
  const games = getGames().filter((g) => ESPN_PATH[g.sport]);
  if (!games.length) return { summary: 'no games on the slate' };

  // One injuries fetch per league present on the slate.
  const sports = [...new Set(games.map((g) => g.sport))];
  const feeds = {};
  for (const sport of sports) {
    try { feeds[sport] = await fetchInjuries(sport); }
    catch (e) { logger.warn('injury', e.message); feeds[sport] = new Map(); }
  }

  const now = new Date().toISOString();
  const rows = [];
  const seen = new Set();
  for (const g of games) {
    const feed = feeds[g.sport];
    if (!feed) continue;
    for (const [team, side] of [[g.home, 'home'], [g.away, 'away']]) {
      for (const inj of lookup(feed, team)) {
        const k = `${g.game_id}|${team}|${inj.player}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({
          sport: g.sport, game_id: g.game_id, team, player: inj.player,
          status: inj.status, detail: inj.detail, impact: inj.impact, pos: inj.pos,
          source: 'espn', fetched_at: now,
        });
      }
    }
  }

  if (rows.length) {
    // `pos` is engine-only (no column in injury_updates) — strip before persisting.
    const dbRows = rows.map(({ pos, ...r }) => r);
    try { await db.insert('injury_updates', dbRows); } catch (e) { logger.warn('injury', e.message); }
  }
  setIntel('injuries', rows);
  const outs = rows.filter((r) => r.status === 'OUT').length;
  return { summary: `${rows.length} injuries (${outs} OUT) · free ESPN`, data: { count: rows.length, outs } };
}

export default { name: 'injury', run };
