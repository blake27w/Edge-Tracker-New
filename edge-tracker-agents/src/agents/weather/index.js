// ══════════════════════════════════════════════════════════════
// Weather Intelligence — outdoor-game weather via Claude web search.
// Wind is the headline edge: 15+ mph favors Unders (and, for the Prop
// Engine, QB passing-yard Unders). Dome games are flagged neutral.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { claudeJson, hasClaude, logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

// Only outdoor-relevant sports.
const OUTDOOR = new Set(['MLB', 'NFL', 'SOCCER', 'GOLF']);

function slate(games) {
  return games
    .filter((g) => OUTDOOR.has(g.sport))
    .map((g) => `${g.sport}: ${g.away} @ ${g.home} [${g.game_id}]`)
    .join('\n');
}

async function run() {
  if (!hasClaude()) return { summary: 'skipped — no Claude' };
  const games = getGames();
  const outdoor = games.filter((g) => OUTDOOR.has(g.sport));
  if (!outdoor.length) return { summary: 'no outdoor games on the slate' };

  const prompt = `You are a weather analyst for a sports betting model. For each outdoor game below, search current game-time forecasts and return ONLY JSON: an array of objects with keys:
  game_id, sport, venue, dome (boolean), temp_f (number), wind_mph (number), wind_dir (string), precip (string), conditions (short string), total_impact (under|over|neutral).
Rules: domes/retractable-closed = dome:true, total_impact:neutral. Wind 15+ mph outdoors => total_impact:"under" unless clearly wind-aided. Cold + wind => "under". Copy game_id exactly.

GAMES:
${slate(outdoor)}`;

  const json = await claudeJson(prompt, { maxTokens: 3000 });
  const list = Array.isArray(json) ? json : [];
  const now = new Date().toISOString();
  const byId = new Map(outdoor.map((g) => [g.game_id, g]));
  const rows = list
    .filter((r) => r && r.game_id)
    .map((r) => {
      const g = byId.get(r.game_id);
      return {
        sport: r.sport || g?.sport || null, game_id: r.game_id,
        home: g?.home || null, away: g?.away || null, venue: r.venue || null,
        dome: !!r.dome, temp_f: num(r.temp_f), wind_mph: num(r.wind_mph),
        wind_dir: r.wind_dir || null, precip: r.precip || null,
        conditions: r.conditions || null,
        total_impact: (r.total_impact || 'neutral').toLowerCase(), fetched_at: now,
      };
    });

  if (rows.length) {
    try { await db.insert('game_weather', rows); } catch (e) { logger.warn('weather', e.message); }
  }
  setIntel('weather', rows);
  const windy = rows.filter((r) => !r.dome && r.wind_mph >= 15).length;
  return { summary: `${rows.length} forecasts (${windy} windy → Under lean)`, data: { count: rows.length, windy } };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export default { name: 'weather', run };
