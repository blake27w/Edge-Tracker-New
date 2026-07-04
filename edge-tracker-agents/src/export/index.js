// ══════════════════════════════════════════════════════════════
// Excel export — pulls the Supabase tables and builds a single, readable
// multi-sheet .xlsx workbook: a computed Summary, a clean Plays sheet,
// and supporting data sheets. Served by GET /export.
// ══════════════════════════════════════════════════════════════
import ExcelJS from 'exceljs';
import db from '../db/index.js';
import { getBacktest } from '../store/index.js';

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
  ws.addRow(['Observational graded (excluded from headline)', graded.filter((p) => p.observational).length]);
  ws.addRow(['Live (in-game) graded', graded.filter((p) => p.live).length]);
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

// Research Findings — the documented conclusions from our backtests/research
// scripts, with the numbers. Lives in CODE so the live CSV feed and the
// workbook both update automatically when a new script run changes a verdict.
export const FINDINGS = [
    ['Key numbers (NFL)', 'Measured margin-landing % (2025, n=271): 3→15.1, 7→9.6, 4→5.5, 6→4.1, 14→4.1, 10→3.7, 17→5.9 (long-run ~3.3). The 4 outlands 6/10/14. Key-number EVs now use these.', 'nfl-backtest.js'],
    ['Power ratings', 'Frozen preseason Elo graded 56.8% straight-up vs a 62-67% floor — it never learned. Fixed: nfl-power now updates weekly from finals in-season.', 'nfl-backtest.js'],
    ['NFL scoring model', '24/39 (61.5%) total leans vs reality — above breakeven but not significant, and untested vs the close. Stays Tier-3 until CLV proves it.', 'nfl-backtest.js'],
    ['Prop baselines', 'Prior-year volume is reference-only: best market pass yds (77% within ±25% = ±57 yds — not line precision). Rush/rec yardage baselines weak (35-38%). Never wired as a signal.', 'nfl-props-backtest.js'],
    ['Prop market stability', 'Yardage props are near-random game to game (rush/rec yds CV ~81%); pass yds (35%) and volume stats (52-55%) are the model-trustable markets. Prop flags require 3+ books.', 'nfl-props-backtest.js'],
    ['Rolling-usage model', 'KILLED by data before building: usage shifts do not persist (receptions 48%, rush att 55%). Books are right to be slow on usage changes.', 'nfl-props-backtest.js'],
    ['Offense style', 'Position shares persist year-over-year (TE r=.60, WR .46, RB .41) — projectable. Pace does NOT (r=.01). Player concentration barely (WR1 .33, RB1 .21).', 'nfl-style-research.js'],
    ['Defensive funnels', 'Real within a season, perishable across seasons (r≈.25). Recomputed in-season only by nfl-style; never carried across years.', 'nfl-style-research.js'],
    ['Totals market', 'LOSING on both results and CLV (81-79-2, -4.5% ROI; 13.6% beat close). On probation/observational — do not bet totals.', 'live record + CLV'],
    ['Core thesis', 'Prediction models keep grading mediocre; price/speed mechanisms keep surviving. The edge is price + speed + discipline, validated by CLV — not out-predicting the market.', 'all of the above'],
];

function findingsSheet(wb) {
  const ws = wb.addWorksheet('Research Findings');
  ws.columns = [{ header: 'Topic', width: 26 }, { header: 'Finding', width: 95 }, { header: 'Source', width: 26 }];
  for (const r of FINDINGS) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (let i = 2; i <= ws.rowCount; i++) ws.getRow(i).alignment = { wrapText: true, vertical: 'top' };
  return ws;
}

export async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Edge Tracker Agents';
  wb.created = new Date();

  const plays = await grab('monitor_scores', { order: { column: 'scored_at', ascending: false }, limit: MAXROW });

  summarySheet(wb, plays);
  findingsSheet(wb);

  // Live analysis from the backtest agent (in-memory): validation + scorecard.
  const bt = getBacktest();
  if (bt && bt.marketValidation) {
    addSheet(wb, 'Market Validation', bt.marketValidation.map((m) => ({
      market: m.market, verdict: m.verdict, graded: m.n, record: `${m.w}-${m.l}-${m.p}`, win_pct: m.winPct,
      roi_pct: m.roi, clv_records: m.clvN, avg_clv: m.avgClv, beat_close_pct: m.beatPct,
    })), ['market', 'verdict']);
  }
  if (bt && bt.signalClv && bt.signalClv.length) {
    addSheet(wb, 'Signal CLV Scorecard', bt.signalClv.map((s) => ({
      signal: s.label, plays_tracked: s.n, beat_close_pct: s.beatPct, avg_clv: s.avgClv,
      graded: s.graded, win_pct: s.winPct, roi_pct: s.roi, flagged_for_removal: s.flag ? 'YES' : '',
    })), ['signal']);
  }

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
    ['fetched_at', 'sport', 'away', 'home', 'book', 'market', 'side', 'line', 'price', 'last_update']);

  // This week's research + scanner layers.
  addSheet(wb, 'Opportunities Graded', await grab('opp_results', { order: { column: 'graded_at', ascending: false }, limit: MAXROW }),
    ['graded_at', 'type', 'sport', 'matchup', 'market', 'side', 'line', 'price', 'status', 'pnl', 'detail']);
  addSheet(wb, 'Book Edge Log', await grab('book_edge_log', { order: { column: 'detected_at', ascending: false }, limit: MAXROW }),
    ['detected_at', 'type', 'sport', 'book', 'market', 'side', 'consensus_line', 'outlier_line', 'pts', 'price', 'corrected_at', 'window_sec']);
  addSheet(wb, 'Public Fades', await grab('public_fades', { order: { column: 'detected_at', ascending: false }, limit: MAXROW }),
    ['detected_at', 'sport', 'matchup', 'market', 'public_side', 'fade_side', 'bets_pct', 'handle_pct', 'divergence', 'rlm', 'score', 'reasons']);
  addSheet(wb, 'Exchange Edges', await grab('pred_market_edges', { order: { column: 'detected_at', ascending: false }, limit: MAXROW }),
    ['detected_at', 'sport', 'matchup', 'side', 'price', 'exch_prob', 'book_prob', 'edge_pct', 'source', 'vol']);
  addSheet(wb, 'Umpire Tendencies', await grab('umpire_runs', { order: { column: 'run_index', ascending: false }, limit: MAXROW }),
    ['umpire', 'games', 'avg_runs', 'run_index', 'league_avg', 'updated_at']);
  addSheet(wb, 'Pitcher Changes', await grab('pitcher_changes', { order: { column: 'detected_at', ascending: false }, limit: MAXROW }),
    ['detected_at', 'matchup', 'team', 'old_pitcher', 'new_pitcher', 'old_era', 'new_era', 'lean']);
  addSheet(wb, 'Weather Shifts', await grab('weather_changes', { order: { column: 'detected_at', ascending: false }, limit: MAXROW }),
    ['detected_at', 'sport', 'matchup', 'lean', 'first_wind', 'cur_wind', 'opener_total', 'cur_total', 'note']);
  addSheet(wb, 'NFL QB Status', await grab('nfl_qb_status', { order: { column: 'detected_at', ascending: false }, limit: MAXROW }),
    ['detected_at', 'team', 'player', 'old_status', 'new_status']);
  addSheet(wb, 'Prop Flags', await grab('prop_snapshots', { order: { column: 'fetched_at', ascending: false }, limit: MAXROW }),
    ['fetched_at', 'sport', 'player', 'stat_type', 'side', 'line', 'price', 'book', 'trigger']);
  addSheet(wb, 'NFL Power', await grab('nfl_power_ratings', { order: { column: 'rating', ascending: false }, limit: MAXROW }),
    ['season', 'team', 'rating', 'end_of_season', 'notes', 'updated_at']);
  addSheet(wb, 'NFL Win Totals', await grab('nfl_win_totals', { order: { column: 'edge', ascending: false }, limit: MAXROW }),
    ['season', 'team', 'posted_total', 'model_wins', 'edge', 'side', 'fair_over_pct']);
  addSheet(wb, 'NFL Pace Map', await grab('nfl_pace', { order: { column: 'lean', ascending: true }, limit: MAXROW }),
    ['season', 'team', 'pace', 'pass', 'lean', 'updated_at']);

  return wb;
}

// ══════════════════════════════════════════════════════════════
// Live CSV feeds — GET /csv?sheet=<name>. A Google Sheet imports each with
// =IMPORTDATA("…/csv?sheet=validation") and Google auto-refreshes it (~hourly),
// so the research document UPDATES ITSELF: no manual export, no credentials,
// no push agent. Findings live in code, so verdict changes flow automatically.
// ══════════════════════════════════════════════════════════════
const csvEsc = (v) => {
  let s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (/^[=+\-@]/.test(s)) s = "'" + s; // formula-injection guard
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
};
function toCsv(rows, order = []) {
  if (!rows || !rows.length) return 'status\nno data yet\n';
  const keys = Object.keys(rows[0]);
  const cols = [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k))];
  return [cols.join(','), ...rows.map((r) => cols.map((k) => csvEsc(r[k])).join(','))].join('\n') + '\n';
}

export const CSV_SHEETS = ['summary', 'findings', 'validation', 'signal-clv', 'plays', 'clv', 'opps', 'book-edges', 'fades', 'splits', 'exchange', 'umpires', 'pitcher-changes', 'weather-shifts', 'qb-status', 'prop-flags', 'nfl-power', 'nfl-win-totals'];

export async function buildCsv(name) {
  const bt = getBacktest();
  switch (String(name || '').toLowerCase()) {
    case 'findings':
      return toCsv(FINDINGS.map(([topic, finding, source]) => ({ topic, finding, source })));
    case 'validation':
      return toCsv((bt?.marketValidation || []).map((m) => ({
        market: m.market, verdict: m.verdict, graded: m.n, record: `${m.w}-${m.l}${m.p ? '-' + m.p : ''}`,
        win_pct: m.winPct, roi_pct: m.roi, clv_records: m.clvN, avg_clv: m.avgClv, beat_close_pct: m.beatPct,
      })));
    case 'signal-clv':
      return toCsv((bt?.signalClv || []).map((s) => ({
        signal: s.label, plays_tracked: s.n, beat_close_pct: s.beatPct, avg_clv: s.avgClv,
        graded: s.graded, win_pct: s.winPct, roi_pct: s.roi, flag: s.flag ? 'REVIEW' : '',
      })));
    case 'summary': {
      const rows = [];
      const push = (metric, value) => rows.push({ metric, value });
      push('generated_utc', new Date().toISOString());
      const o = bt?.overall;
      if (o) { push('headline_record', `${o.w}-${o.l}-${o.p}`); push('headline_win_pct', o.winPct); push('headline_roi_pct', o.roi); push('headline_pnl_$', o.pnl); push('graded', o.n); }
      if (bt?.verdict) push('verdict', bt.verdict.headline);
      if (bt?.clv) { push('clv_avg', bt.clv.avg); push('clv_beat_close_pct', bt.clv.beatPct); push('clv_records', bt.clv.n); }
      if (bt?.fades?.n) push('fades_observational', `${bt.fades.w}-${bt.fades.l} (${bt.fades.roi}% ROI)`);
      if (bt?.totals?.n) push('totals_probation', `${bt.totals.w}-${bt.totals.l}-${bt.totals.p} (${bt.totals.roi}% ROI)`);
      return toCsv(rows);
    }
    case 'plays':
      return toCsv(await grab('monitor_scores', { order: { column: 'scored_at', ascending: false }, limit: 2000 }),
        ['scored_at', 'sport', 'matchup', 'market', 'side', 'line', 'price', 'score', 'tier', 'unit_dollars', 't1_count', 'observational', 'live', 'status', 'result_score', 'pnl', 'graded_at']);
    case 'clv':
      return toCsv(await grab('clv_records', { order: { column: 'recorded_at', ascending: false }, limit: 2000 }),
        ['recorded_at', 'sport', 'bet_market', 'side', 'line_logged', 'line_close', 'clv', 'beat_close', 'suspect']);
    case 'opps':
      return toCsv(await grab('opp_results', { order: { column: 'graded_at', ascending: false }, limit: 2000 }),
        ['graded_at', 'type', 'sport', 'matchup', 'market', 'side', 'line', 'price', 'status', 'pnl', 'detail']);
    case 'book-edges':
      return toCsv(await grab('book_edge_log', { order: { column: 'detected_at', ascending: false }, limit: 2000 }),
        ['detected_at', 'type', 'sport', 'book', 'market', 'side', 'consensus_line', 'outlier_line', 'pts', 'price', 'corrected_at', 'window_sec']);
    case 'fades':
      return toCsv(await grab('public_fades', { order: { column: 'detected_at', ascending: false }, limit: 1000 }),
        ['detected_at', 'sport', 'matchup', 'market', 'public_side', 'fade_side', 'bets_pct', 'handle_pct', 'divergence', 'rlm', 'score', 'reasons']);
    case 'splits':
      return toCsv(await grab('public_splits', { order: { column: 'fetched_at', ascending: false }, limit: 1500 }),
        ['fetched_at', 'sport', 'market', 'side', 'bets_pct', 'handle_pct', 'divergence', 'rlm', 'freeze', 'pileon', 'net_move']);
    case 'exchange':
      return toCsv(await grab('pred_market_edges', { order: { column: 'detected_at', ascending: false }, limit: 1000 }),
        ['detected_at', 'sport', 'matchup', 'side', 'price', 'exch_prob', 'book_prob', 'edge_pct', 'source', 'vol']);
    case 'umpires':
      return toCsv(await grab('umpire_runs', { order: { column: 'run_index', ascending: false }, limit: 300 }),
        ['umpire', 'games', 'avg_runs', 'run_index', 'league_avg', 'updated_at']);
    case 'pitcher-changes':
      return toCsv(await grab('pitcher_changes', { order: { column: 'detected_at', ascending: false }, limit: 500 }),
        ['detected_at', 'matchup', 'team', 'old_pitcher', 'new_pitcher', 'old_era', 'new_era', 'lean']);
    case 'weather-shifts':
      return toCsv(await grab('weather_changes', { order: { column: 'detected_at', ascending: false }, limit: 500 }),
        ['detected_at', 'sport', 'matchup', 'lean', 'first_wind', 'cur_wind', 'opener_total', 'cur_total', 'note']);
    case 'qb-status':
      return toCsv(await grab('nfl_qb_status', { order: { column: 'detected_at', ascending: false }, limit: 500 }),
        ['detected_at', 'team', 'player', 'old_status', 'new_status']);
    case 'prop-flags':
      return toCsv(await grab('prop_snapshots', { order: { column: 'fetched_at', ascending: false }, limit: 1000 }),
        ['fetched_at', 'sport', 'player', 'stat_type', 'side', 'line', 'price', 'book', 'trigger']);
    case 'nfl-power':
      return toCsv(await grab('nfl_power_ratings', { order: { column: 'rating', ascending: false }, limit: 40 }),
        ['season', 'team', 'rating', 'end_of_season', 'notes', 'updated_at']);
    case 'nfl-win-totals':
      return toCsv(await grab('nfl_win_totals', { order: { column: 'edge', ascending: false }, limit: 40 }),
        ['season', 'team', 'posted_total', 'model_wins', 'edge', 'side', 'fair_over_pct']);
    default:
      return null;
  }
}

export default { buildWorkbook, buildCsv, CSV_SHEETS, FINDINGS };
