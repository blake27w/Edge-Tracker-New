// ══════════════════════════════════════════════════════════════
// Injury Intelligence — uses Claude web search to pull injury news
// for today's slate. Flags starters ruled OUT (which the Prop Engine
// consumes for speed-game stale-line alerts).
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { claudeJson, hasClaude, logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

function slate(games) {
  const bySport = {};
  for (const g of games) {
    (bySport[g.sport] ||= []).push(`${g.away} @ ${g.home} [${g.game_id}]`);
  }
  return Object.entries(bySport)
    .map(([sp, list]) => `${sp}:\n${list.join('\n')}`)
    .join('\n\n');
}

async function run() {
  if (!hasClaude()) return { summary: 'skipped — no Claude' };
  const games = getGames();
  if (!games.length) return { summary: 'no games on the slate' };

  const prompt = `You are an injury-report analyst for a sports betting model. For TODAY's slate below, search for the latest injury news and return ONLY JSON: an array of objects with keys:
  game_id (string, copy from the slate), sport, team, player, status (OUT|DOUBTFUL|QUESTIONABLE|GTD|ACTIVE), impact (high|medium|low), detail (one short sentence).
Only include meaningful injuries (starters, rotation players, pitchers). Skip day-to-day minor stuff. Max 40 entries.

SLATE:
${slate(games)}`;

  const json = await claudeJson(prompt, { maxTokens: 3500 });
  const list = Array.isArray(json) ? json : [];
  const now = new Date().toISOString();
  const rows = list
    .filter((r) => r && r.player)
    .map((r) => ({
      sport: r.sport || null, game_id: r.game_id || null, team: r.team || null,
      player: r.player, status: (r.status || '').toUpperCase(), detail: r.detail || null,
      impact: (r.impact || 'medium').toLowerCase(), source: 'claude-web', fetched_at: now,
    }));

  if (rows.length) {
    try { await db.insert('injury_updates', rows); } catch (e) { logger.warn('injury', e.message); }
  }
  setIntel('injuries', rows);
  const outs = rows.filter((r) => r.status === 'OUT').length;
  return { summary: `${rows.length} injuries (${outs} OUT)`, data: { count: rows.length, outs } };
}

export default { name: 'injury', run };
