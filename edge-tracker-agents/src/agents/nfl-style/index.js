// ══════════════════════════════════════════════════════════════
// NFL Style & Funnels — measured scheme fingerprints, live.
// From the 2025 research run (scripts/nfl-style-research.js):
//   • offense POSITION SHARES persist year-over-year (TE r=.60, WR .46,
//     RB .41) → the one projectable style trait;
//   • pace does NOT persist (r=.01) and player concentration barely
//     (WR1 .33, RB1 .21) → never projected here;
//   • defensive funnels are real but perishable (r≈.25) → recomputed
//     from the CURRENT season only.
// Until the current season has enough games (3+ weeks), serves the last
// completed season's numbers, clearly labeled. Free ESPN box scores via
// the shared cached fetchers. $0.
// ══════════════════════════════════════════════════════════════
import { logger } from '../../utils/index.js';
import { setIntel } from '../../store/index.js';
import { getSeasonSchedule, upcomingSeason, lastCompletedSeason } from '../shared/nfl.js';
import { getBox } from '../shared/espn.js';

const MIN_GAMES_LIVE = 32; // ~2 full weeks before current-season numbers mean anything
const POS = ['WR', 'TE', 'RB'];
const norm = (s) => String(s || '').toLowerCase();
const statNum = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const fracAtt = (v) => { const p = String(v ?? '').split('/'); return p.length === 2 ? parseFloat(p[1]) : null; };

// Current-roster position fallback (box scores don't always carry position).
let posMap = null, posMapAt = 0;
async function rosterPositions() {
  if (posMap && Date.now() - posMapAt < 24 * 3600_000) return posMap;
  const map = new Map();
  try {
    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40');
    if (res.ok) {
      const teams = (await res.json())?.sports?.[0]?.leagues?.[0]?.teams || [];
      for (const t of teams) {
        try {
          const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${t.team?.id}/roster`);
          if (!r.ok) continue;
          for (const grp of (await r.json()).athletes || []) {
            for (const a of grp.items || []) if (a.displayName && a.position?.abbreviation) map.set(norm(a.displayName), a.position.abbreviation);
          }
        } catch (_) { /* skip team */ }
      }
    }
  } catch (_) { /* roster fallback unavailable — box positions only */ }
  posMap = map; posMapAt = Date.now();
  return map;
}

async function run() {
  // Pick the season: current one once it has enough completed games, else last.
  let season = upcomingSeason();
  let sched = await getSeasonSchedule(season).catch(() => []);
  let completed = sched.filter((g) => g.completed && g.id);
  let liveSeason = true;
  if (completed.length < MIN_GAMES_LIVE) {
    season = lastCompletedSeason();
    sched = await getSeasonSchedule(season).catch(() => []);
    completed = sched.filter((g) => g.completed && g.id);
    liveSeason = false;
  }
  if (!completed.length) { setIntel('nflStyle', []); return { summary: 'no completed NFL games to profile' }; }

  const posOf = await rosterPositions();
  const off = new Map(), def = new Map();
  const bump = (m, t) => m.get(t) || m.set(t, { g: 0, passAtt: 0, rushAtt: 0, rec: { WR: 0, TE: 0, RB: 0 }, recTotal: 0 }).get(t);
  let boxes = 0;
  for (const g of completed) {
    const box = await getBox('football/nfl', g.id);
    if (!box) continue;
    boxes++;
    const sides = [];
    for (const team of box.players || []) {
      const name = team.team?.displayName;
      if (!name) continue;
      const T = { team: name, passAtt: 0, rushAtt: 0, rec: { WR: 0, TE: 0, RB: 0 }, recTotal: 0 };
      for (const grp of team.statistics || []) {
        const gname = norm(grp.name || grp.text || grp.type);
        const labels = (grp.labels || grp.keys || []).map((s) => String(s).toUpperCase());
        const idx = (l) => labels.indexOf(l);
        for (const a of grp.athletes || []) {
          const player = a.athlete?.displayName;
          if (!player) continue;
          const pos = a.athlete?.position?.abbreviation || posOf.get(norm(player)) || null;
          if (gname.includes('passing')) { const i = idx('C/ATT'); const att = i >= 0 ? fracAtt(a.stats?.[i]) : null; if (att) T.passAtt += att; }
          if (gname.includes('rushing')) { const i = idx('CAR'); const c = i >= 0 ? statNum(a.stats?.[i]) : null; if (c) T.rushAtt += c; }
          if (gname.includes('receiving')) {
            const i = idx('REC'); const r = i >= 0 ? statNum(a.stats?.[i]) : null;
            if (r) { T.recTotal += r; if (POS.includes(pos)) T.rec[pos] += r; }
          }
        }
      }
      sides.push(T);
    }
    if (sides.length === 2) { sides[0].opp = sides[1].team; sides[1].opp = sides[0].team; }
    for (const T of sides) {
      const o = bump(off, T.team);
      o.g++; o.passAtt += T.passAtt; o.rushAtt += T.rushAtt; o.recTotal += T.recTotal;
      for (const p of POS) o.rec[p] += T.rec[p];
      if (T.opp) {
        const d = bump(def, T.opp);
        d.g++; d.recTotal += T.recTotal;
        for (const p of POS) d.rec[p] += T.rec[p];
      }
    }
  }

  const share = (o, p) => Math.round((o.rec[p] / (o.recTotal || 1)) * 1000) / 10;
  const teams = [...off.keys()];
  const lg = { WR: 0, TE: 0, RB: 0 };
  for (const p of POS) lg[p] = Math.round((teams.reduce((t, x) => t + share(off.get(x), p), 0) / (teams.length || 1)) * 10) / 10;

  const rows = teams.sort().map((t) => {
    const o = off.get(t), d = def.get(t);
    const devs = POS.map((p) => ({ p, dev: Math.round((share(o, p) - lg[p]) * 10) / 10 })).sort((a, b) => b.dev - a.dev);
    return {
      team: t, season, live: liveSeason, games: o.g,
      pass_rate: Math.round((o.passAtt / ((o.passAtt + o.rushAtt) || 1)) * 1000) / 10,
      wr_share: share(o, 'WR'), te_share: share(o, 'TE'), rb_share: share(o, 'RB'),
      key_pos: devs[0].dev >= 2 ? `${devs[0].p} +${devs[0].dev}%` : 'balanced',
      def_funnel: d ? POS.map((p) => ({ p, dev: Math.round((Math.round((d.rec[p] / (d.recTotal || 1)) * 1000) / 10 - lg[p]) * 10) / 10 })).sort((a, b) => b.dev - a.dev)[0] : null,
    };
  });
  setIntel('nflStyle', rows);

  return {
    summary: `${rows.length} team fingerprints from ${boxes} ${season} box scores${liveSeason ? '' : ' (last season — switches live at ~2 wks of ' + upcomingSeason() + ')'}`,
    data: { teams: rows.length, boxes, season, live: liveSeason },
  };
}

export default { name: 'nfl-style', run };
