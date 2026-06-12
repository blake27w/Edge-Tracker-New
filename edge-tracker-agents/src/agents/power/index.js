// ══════════════════════════════════════════════════════════════
// Power Ratings — Claude-generated team strength ratings for the
// teams on today's slate. Used by the Signal Engine to gauge whether
// the market line is off the projected number.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { claudeJson, hasClaude, logger } from '../../utils/index.js';
import { getGames, setPower } from '../../store/index.js';

// Team sports only (props/individual sports don't use team power ratings here).
const TEAM_SPORTS = new Set(['MLB', 'NBA', 'NHL', 'NFL', 'SOCCER']);

async function run() {
  if (!hasClaude()) return { summary: 'skipped — no Claude' };
  const games = getGames().filter((g) => TEAM_SPORTS.has(g.sport));
  if (!games.length) return { summary: 'no team-sport games on the slate' };

  // Unique (sport, team) pairs on the slate.
  const teams = {};
  for (const g of games) {
    (teams[g.sport] ||= new Set()).add(g.home);
    teams[g.sport].add(g.away);
  }
  const lines = Object.entries(teams)
    .map(([sp, set]) => `${sp}: ${[...set].join(', ')}`)
    .join('\n');

  const prompt = `You are a sports modeler. Produce current power ratings (0-100 scale, 50 = league average) for these teams, reflecting recent form, roster, and injuries. Return ONLY JSON: an array of objects with keys:
  sport, team (exactly as written), rating (number 0-100), off_rating (0-100), def_rating (0-100), notes (short).

TEAMS:
${lines}`;

  const json = await claudeJson(prompt, { maxTokens: 3000 });
  const list = Array.isArray(json) ? json : [];
  const now = new Date().toISOString();
  const rows = list
    .filter((r) => r && r.team && r.sport)
    .map((r) => ({
      sport: r.sport, team: r.team, rating: num(r.rating), off_rating: num(r.off_rating),
      def_rating: num(r.def_rating), notes: r.notes || null, updated_at: now,
    }));

  if (rows.length) {
    try { await db.upsert('power_ratings', rows, 'sport,team'); } catch (e) { logger.warn('power', e.message); }
  }
  // Publish to the store keyed by sport -> team -> rating row.
  const bySport = {};
  for (const r of rows) ((bySport[r.sport] ||= {})[r.team] = r);
  for (const [sp, map] of Object.entries(bySport)) setPower(sp, map);

  return { summary: `${rows.length} team ratings across ${Object.keys(bySport).length} sports`, data: { count: rows.length } };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export default { name: 'power', run };
