// ══════════════════════════════════════════════════════════════
// Excel export — pulls the Supabase tables and builds a single, readable
// multi-sheet .xlsx workbook: a computed Summary, a clean Plays sheet,
// and supporting data sheets. Served by GET /export.
// ══════════════════════════════════════════════════════════════
import ExcelJS from 'exceljs';
import db from '../db/index.js';

const MAXROW = 5000; // cap big tables so the file stays openable

async function grab(table, opts) {
  try { return await db.select(table, '*', opts); } catch (e) { return []; }
}

function fmtCell(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

// Generic sheet: bold frozen header, autofilter, derived columns from the data.
function addSheet(wb, name, rows, preferredOrder = []) {
  const ws = wb.addWorksheet(name);
  if (!rows.length) { ws.addRow(['(no data yet)']); return ws; }
  // Column order: preferred first, then the rest.
  const keys = Object.keys(rows[0]);
  const ordered = [...preferredOrder.filter((k) => keys.includes(k)), ...keys.filter((k) => !preferredOrder.includes(k))];
  ws.columns = ordered.map((k) => ({ header: k, key: k, width: Math.min(40, Math.max(12, k.length + 2)) }));
  for (const r of rows) ws.addRow(Object.fromEntries(ordered.map((k) => [k, fmtCell(r[k])])));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ordered.length } };
  return ws;
}

function summarySheet(wb, plays) {
  const ws = wb.addWorksheet('Summary');
  const graded = plays.filter((p) => ['win', 'loss', 'push'].includes(p.status));
  const wins = graded.filter((p) => p.status === 'win').length;
  const losses = graded.filter((p) => p.status === 'loss').length;
  const pushes = graded.filter((p) => p.status === 'push').length;
  const pending = plays.filter((p) => p.status === 'pending').length;
  const pnl = graded.reduce((s, p) => s + (Number(p.pnl) || 0), 0);
  const staked = graded.reduce((s, p) => s + (Number(p.unit_dollars) || 0), 0);
  const roi = staked ? (pnl / staked) * 100 : 0;
  const units = graded.reduce((s, p) => s + (p.status === 'win' ? (Number(p.unit_mult) || 0) : p.status === 'loss' ? -(Number(p.unit_mult) || 0) : 0), 0);

  const title = ws.addRow(['EDGE TRACKER — SUMMARY']);
  title.font = { bold: true, size: 14 };
  ws.addRow([`Generated ${new Date().toLocaleString()}`]);
  ws.addRow([]);
  const head = (label) => { const r = ws.addRow([label]); r.font = { bold: true }; };

  head('Overall record');
  ws.addRow(['Wins', wins]); ws.addRow(['Losses', losses]); ws.addRow(['Pushes', pushes]);
  ws.addRow(['Pending', pending]);
  ws.addRow(['Win %', graded.length ? `${((wins / (wins + losses || 1)) * 100).toFixed(1)}%` : '—']);
  ws.addRow(['Net units', Math.round(units * 100) / 100]);
  ws.addRow(['Net P&L ($)', Math.round(pnl * 100) / 100]);
  ws.addRow(['ROI', `${roi.toFixed(1)}%`]);
  ws.addRow([]);

  const breakdown = (label, keyFn) => {
    head(`By ${label}`);
    const hdr = ws.addRow([label, 'W', 'L', 'P', 'Net $']); hdr.font = { bold: true };
    const groups = {};
    for (const p of graded) {
      const k = keyFn(p) || '—';
      (groups[k] ||= { w: 0, l: 0, p: 0, pnl: 0 });
      if (p.status === 'win') groups[k].w++; else if (p.status === 'loss') groups[k].l++; else groups[k].p++;
      groups[k].pnl += Number(p.pnl) || 0;
    }
    for (const [k, g] of Object.entries(groups).sort((a, b) => b[1].pnl - a[1].pnl)) {
      ws.addRow([k, g.w, g.l, g.p, Math.round(g.pnl * 100) / 100]);
    }
    ws.addRow([]);
  };
  breakdown('sport', (p) => p.sport);
  breakdown('market', (p) => p.market);

  ws.getColumn(1).width = 22;
  ws.views = [{ state: 'frozen', ySplit: 0 }];
  return ws;
}

export async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Edge Tracker Agents';
  wb.created = new Date();

  const plays = await grab('monitor_scores', { order: { column: 'scored_at', ascending: false }, limit: MAXROW });

  summarySheet(wb, plays);

  // Curated Plays sheet (readable column order).
  addSheet(wb, 'Plays', plays, [
    'scored_at', 'sport', 'matchup', 'market', 'side', 'line', 'confidence', 'score',
    'tier', 'unit_mult', 'unit_dollars', 't1_count', 'over_penalty_applied',
    'status', 'result_score', 'pnl', 'graded_at', 'signals', 'game_id',
  ]);

  // Supporting data sheets.
  addSheet(wb, 'CLV', await grab('clv_records', { order: { column: 'recorded_at', ascending: false }, limit: MAXROW }),
    ['recorded_at', 'sport', 'game_id', 'bet_market', 'side', 'line_logged', 'line_close', 'clv', 'beat_close']);
  addSheet(wb, 'Sharp Signals', await grab('sharp_signals', { order: { column: 'detected_at', ascending: false }, limit: MAXROW }),
    ['detected_at', 'sport', 'game_id', 'market', 'side', 'signal_type', 'strength', 'detail']);
  addSheet(wb, 'Public Splits', await grab('public_splits', { order: { column: 'fetched_at', ascending: false }, limit: MAXROW }),
    ['fetched_at', 'sport', 'game_id', 'market', 'side', 'bets_pct', 'handle_pct', 'divergence', 'rlm']);
  addSheet(wb, 'Injuries', await grab('injury_updates', { order: { column: 'fetched_at', ascending: false }, limit: MAXROW }),
    ['fetched_at', 'sport', 'team', 'player', 'status', 'impact', 'detail']);
  addSheet(wb, 'Weather', await grab('game_weather', { order: { column: 'fetched_at', ascending: false }, limit: MAXROW }),
    ['fetched_at', 'sport', 'away', 'home', 'venue', 'dome', 'temp_f', 'wind_mph', 'wind_dir', 'conditions', 'total_impact']);
  addSheet(wb, 'MLB Context', await grab('mlb_context', { order: { column: 'fetched_at', ascending: false }, limit: MAXROW }),
    ['fetched_at', 'away', 'home', 'home_bullpen_fatigue', 'away_bullpen_fatigue', 'total_lean', 'notes']);
  addSheet(wb, 'Schedule Spots', await grab('schedule_spots', { order: { column: 'fetched_at', ascending: false }, limit: MAXROW }),
    ['fetched_at', 'sport', 'team', 'spot_type', 'tier', 'detail']);
  addSheet(wb, 'Power Ratings', await grab('power_ratings', { order: { column: 'sport', ascending: true }, limit: MAXROW }),
    ['sport', 'team', 'rating', 'off_rating', 'def_rating', 'updated_at', 'notes']);
  addSheet(wb, 'Alerts', await grab('alert_log', { order: { column: 'sent_at', ascending: false }, limit: MAXROW }),
    ['sent_at', 'type', 'channel', 'sport', 'recipients', 'body']);
  addSheet(wb, 'Agent Runs', await grab('scan_runs', { order: { column: 'started_at', ascending: false }, limit: 1000 }),
    ['started_at', 'agent', 'status', 'duration_ms', 'games_monitored', 'result', 'error']);
  addSheet(wb, 'Odds Snapshots', await grab('line_snapshots', { order: { column: 'fetched_at', ascending: false }, limit: MAXROW }),
    ['fetched_at', 'sport', 'away', 'home', 'book', 'market', 'side', 'line', 'price']);

  return wb;
}

export default { buildWorkbook };
