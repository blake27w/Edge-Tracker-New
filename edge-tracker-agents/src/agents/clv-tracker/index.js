// ══════════════════════════════════════════════════════════════
// CLV Tracker — for qualifying plays whose game has reached its
// closing market, compares the logged line to the closing line and
// records closing-line value. Beating the close is the leading
// indicator that the model is finding real edges.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';

const WINDOW_MS = 12 * 3600_000;

async function run() {
  if (!db.isConnected()) return { summary: 'skipped — no DB' };

  // Plays scored in the last 12h that haven't had CLV recorded.
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  let plays = [];
  try {
    plays = await db.select('monitor_scores', '*', {
      match: { qualified: true }, gte: { scored_at: since }, order: { column: 'scored_at', ascending: false }, limit: 200,
    });
  } catch (e) { return { summary: `select failed: ${e.message}` }; }
  if (!plays.length) return { summary: 'no recent plays for CLV' };

  // Existing CLV rows to avoid duplicates.
  let existing = [];
  try { existing = await db.select('clv_records', 'game_id,side,bet_market', { gte: { recorded_at: since } }); }
  catch (e) { /* ignore */ }
  const seen = new Set(existing.map((r) => `${r.game_id}|${r.bet_market}|${r.side}`));

  const records = [];
  for (const p of plays) {
    if (p.market !== 'total') continue; // line-CLV is cleanest on totals
    const key = `${p.game_id}|${p.market}|${p.side}`;
    if (seen.has(key)) continue;

    // Closing line = most recent totals snapshot for this game.
    let snaps = [];
    try {
      snaps = await db.select('line_snapshots', 'line,fetched_at', {
        match: { game_id: p.game_id, market: 'totals', side: p.side },
        order: { column: 'fetched_at', ascending: false }, limit: 1,
      });
    } catch (e) { continue; }
    const closeLine = snaps[0]?.line;
    if (closeLine == null || p.line == null) continue;

    // For Under, value = closing total moved UP vs your number; Over = down.
    const diff = p.side === 'Under' ? closeLine - p.line : p.line - closeLine;
    const beat = diff > 0;
    records.push({
      sport: p.sport, game_id: p.game_id, bet_market: p.market, side: p.side,
      line_logged: p.line, line_close: closeLine, clv: Math.round(diff * 10) / 10,
      beat_close: beat, recorded_at: new Date().toISOString(),
    });
  }

  if (records.length) {
    try { await db.insert('clv_records', records); } catch (e) { logger.warn('clv', e.message); }
  }
  const beat = records.filter((r) => r.beat_close).length;
  return { summary: `${records.length} CLV records (${beat} beat close)`, data: { count: records.length, beat } };
}

export default { name: 'clv', run };
