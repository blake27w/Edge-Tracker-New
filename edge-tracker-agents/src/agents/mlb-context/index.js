// ══════════════════════════════════════════════════════════════
// MLB Context (Agent 10) — home-plate umpire O/U + K tendencies and
// bullpen fatigue (relievers on 2-3 straight days, recent bullpen
// innings). Both feed totals scoring as T2/T3 signals.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { claudeJson, hasClaude, logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

async function run() {
  if (!hasClaude()) return { summary: 'skipped — no Claude' };
  const games = getGames().filter((g) => g.sport === 'MLB');
  if (!games.length) return { summary: 'no MLB games on the slate' };

  const slate = games.map((g) => `${g.away} @ ${g.home} [${g.game_id}]`).join('\n');
  const prompt = `You are an MLB totals analyst. For each game, search for the assigned home-plate umpire and recent bullpen usage, then return ONLY JSON: an array of objects with keys:
  game_id, home, away, ump_name, ump_ou_tendency (over|under|neutral), ump_k_tendency (high|low|neutral),
  home_bullpen_fatigue (high|medium|low), away_bullpen_fatigue (high|medium|low),
  total_lean (under|over|neutral), notes (short).
Tight-zone umps inflate scoring (over); wide-zone umps suppress it (under). Heavy recent bullpen use => fatigue high => over lean. Copy game_id exactly.

GAMES:
${slate}`;

  const json = await claudeJson(prompt, { maxTokens: 3000 });
  const list = Array.isArray(json) ? json : [];
  const now = new Date().toISOString();
  const rows = list
    .filter((r) => r && r.game_id)
    .map((r) => ({
      game_id: r.game_id, home: r.home || null, away: r.away || null,
      ump_name: r.ump_name || null, ump_ou_tendency: low(r.ump_ou_tendency),
      ump_k_tendency: low(r.ump_k_tendency),
      home_bullpen_fatigue: low(r.home_bullpen_fatigue), away_bullpen_fatigue: low(r.away_bullpen_fatigue),
      total_lean: low(r.total_lean) || 'neutral', notes: r.notes || null, fetched_at: now,
    }));

  if (rows.length) {
    try { await db.insert('mlb_context', rows); } catch (e) { logger.warn('mlb-context', e.message); }
  }
  // Tag with sport for signalsForGame consumers.
  setIntel('mlbContext', rows.map((r) => ({ ...r, sport: 'MLB' })));
  return { summary: `${rows.length} MLB context rows`, data: { count: rows.length } };
}

function low(v) { return v ? String(v).toLowerCase() : null; }

export default { name: 'mlb-context', run };
