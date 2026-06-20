// ══════════════════════════════════════════════════════════════
// CLV Tracker — for qualifying plays whose game has reached its
// closing market, compares the logged line to the closing line and
// records closing-line value. Beating the close is the leading
// indicator that the model is finding real edges.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setClvReport } from '../../store/index.js';

const WINDOW_MS = 12 * 3600_000;
const REPORT_DAYS = Number(process.env.CLV_REPORT_DAYS) || 90;

// Aggregate clv_records into the dashboard summary (overall + by sport + recent).
async function publishReport() {
  const since = new Date(Date.now() - REPORT_DAYS * 86400_000).toISOString();
  let all = [];
  try {
    all = await db.select('clv_records', '*', { gte: { recorded_at: since }, order: { column: 'recorded_at', ascending: false }, limit: 1000 });
  } catch (e) { return; }
  const fin = (rows) => {
    const n = rows.length;
    const beat = rows.filter((r) => r.beat_close).length;
    const avg = n ? Math.round((rows.reduce((s, r) => s + (Number(r.clv) || 0), 0) / n) * 100) / 100 : 0;
    return { n, beat, beat_pct: n ? Math.round((beat / n) * 1000) / 10 : 0, avg_clv: avg };
  };
  const bySport = {};
  for (const r of all) (bySport[r.sport || '—'] ||= []).push(r);
  setClvReport({
    days: REPORT_DAYS,
    overall: fin(all),
    bySport: Object.entries(bySport).map(([sport, rows]) => ({ sport, ...fin(rows) })).sort((a, b) => b.n - a.n),
    recent: all.slice(0, 30).map((r) => ({ sport: r.sport, game_id: r.game_id, market: r.bet_market, side: r.side, line_logged: r.line_logged, line_close: r.line_close, clv: r.clv, beat_close: r.beat_close, recorded_at: r.recorded_at })),
    updated_at: new Date().toISOString(),
  });
}

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
  if (!plays.length) { await publishReport(); return { summary: 'no recent plays for CLV (dashboard refreshed)' }; }

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
  await publishReport();
  const beat = records.filter((r) => r.beat_close).length;
  return { summary: `${records.length} CLV records (${beat} beat close)`, data: { count: records.length, beat } };
}

export default { name: 'clv', run };
