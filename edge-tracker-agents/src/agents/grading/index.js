// ══════════════════════════════════════════════════════════════
// Grading Agent — checks final scores for completed games, matches
// them against pending monitor_scores entries, sets win/loss/push,
// computes P&L, and writes results back so the dashboard can show a
// verified track record.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { claudeJson, hasClaude, logger } from '../../utils/index.js';

// American odds → profit on a $1 stake (default -110 lines).
function profitPerUnit(odds = -110) {
  return odds < 0 ? 100 / Math.abs(odds) : odds / 100;
}

async function run() {
  if (!db.isConnected()) return { summary: 'skipped — no DB' };

  // Pending plays for games that started 3.5h+ ago (likely final).
  const cutoff = new Date(Date.now() - 3.5 * 3600_000).toISOString();
  let pending = [];
  try {
    pending = await db.select('monitor_scores', '*', {
      match: { status: 'pending', qualified: true },
      lte: { scored_at: cutoff }, order: { column: 'scored_at', ascending: true }, limit: 60,
    });
  } catch (e) { return { summary: `select failed: ${e.message}` }; }
  if (!pending.length) return { summary: 'no completed plays to grade' };
  if (!hasClaude()) return { summary: `${pending.length} plays awaiting grade, but no Claude to fetch finals` };

  // Group by matchup to minimize lookups.
  const byGame = new Map();
  for (const p of pending) byGame.set(p.game_id, { sport: p.sport, matchup: p.matchup });
  const slate = [...byGame.entries()].map(([id, g]) => `${g.sport}: ${g.matchup} [${id}]`).join('\n');

  const prompt = `Search for the FINAL scores of these completed games. Return ONLY JSON: an array of objects with keys:
  game_id, final (boolean), home_score (int), away_score (int), total (int = home+away).
If a game isn't final yet, set final:false. Copy game_id exactly.

GAMES:
${slate}`;

  const json = await claudeJson(prompt, { maxTokens: 2500 });
  const finals = new Map((Array.isArray(json) ? json : []).filter((r) => r && r.game_id).map((r) => [r.game_id, r]));

  let graded = 0, wins = 0, losses = 0, pushes = 0;
  const now = new Date().toISOString();

  for (const p of pending) {
    const f = finals.get(p.game_id);
    if (!f || !f.final) continue;

    const result = gradePlay(p, f);
    if (!result) continue;
    const stake = (p.unit_dollars ?? config.rules.unitDollars);
    let pnl = 0;
    if (result === 'win') pnl = Math.round(stake * profitPerUnit(-110) * 100) / 100;
    else if (result === 'loss') pnl = -stake;
    // push => 0

    try {
      await db.update('monitor_scores', { status: result, result_score: `${f.away_score}-${f.home_score}`, pnl, graded_at: now }, { id: p.id });
    } catch (e) { logger.warn('grading', e.message); continue; }
    graded++;
    if (result === 'win') wins++; else if (result === 'loss') losses++; else pushes++;
  }

  return {
    summary: `graded ${graded} (${wins}W-${losses}L-${pushes}P)`,
    data: { graded, wins, losses, pushes },
  };
}

// Determine win/loss/push for a play given the final.
function gradePlay(p, f) {
  const total = f.total != null ? f.total : (Number(f.home_score) + Number(f.away_score));
  if (p.market === 'total' && p.line != null) {
    if (total === p.line) return 'push';
    if (p.side === 'Under') return total < p.line ? 'win' : 'loss';
    if (p.side === 'Over') return total > p.line ? 'win' : 'loss';
  }
  if (p.market === 'ml') {
    const homeWon = f.home_score > f.away_score;
    const sideHome = String(p.side || '').includes(p.matchup?.split(' @ ')[1] || '###');
    return (homeWon === sideHome) ? 'win' : 'loss';
  }
  // Spreads need the number; without a stored spread line we can't grade reliably.
  return null;
}

export default { name: 'grading', run };
