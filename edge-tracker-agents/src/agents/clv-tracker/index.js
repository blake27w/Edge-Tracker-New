// ══════════════════════════════════════════════════════════════
// CLV Tracker — measures closing-line value, the north-star metric.
// For each qualifying play it compares the ENTRY line (the number the
// play was logged at, when it qualified) to the CLOSING line (the latest
// market snapshot, captured near game start). The two MUST come from
// different snapshot batches at different times — capturing "closing" too
// early (right after entry) was the bug that made every play read X→X /
// +0 CLV.
//
// Guarantees:
//   • Closing is only recorded once the game is at/near start (≥ commence −
//     CLOSE_LEAD), so the latest snapshot is genuinely the close.
//   • entry_at and close_at are stored; a record is flagged `suspect` if
//     they aren't distinct (so corrupt rows never pollute the stats).
//   • Exactly one clv_record per play (upsert on game_id+market+side).
//   • Line CLV (totals/spreads) AND odds CLV (moneylines) from the
//     consensus of each snapshot batch.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setClvReport } from '../../store/index.js';
import { impliedProb, median } from '../shared/odds-math.js';

const LOOKBACK_MS = (Number(process.env.CLV_LOOKBACK_DAYS) || 4) * 86400_000;
const CLOSE_LEAD_MS = 20 * 60_000;   // start capturing the close ~20 min before first pitch/kick
const REPORT_DAYS = Number(process.env.CLV_REPORT_DAYS) || 90;
const SNAP_MARKET = { total: 'totals', spread: 'spreads', ml: 'h2h' };

// Median line + price across the books in one snapshot batch (same fetched_at).
function batchConsensus(rows) {
  const lines = rows.map((r) => Number(r.line)).filter(Number.isFinite);
  const prices = rows.map((r) => Number(r.price)).filter(Number.isFinite);
  return { line: lines.length ? median(lines) : null, price: prices.length ? Math.round(median(prices)) : null };
}

// Build a CLV record for one play, or null if it's too early / unmeasurable.
async function capture(p) {
  const snapMarket = SNAP_MARKET[p.market];
  if (!snapMarket || !p.side) return null;

  let snaps = [];
  try {
    snaps = await db.select('line_snapshots', 'commence_time,fetched_at,line,price', {
      match: { game_id: p.game_id, market: snapMarket, side: p.side },
      order: { column: 'fetched_at', ascending: true }, limit: 1000,
    });
  } catch (e) { return null; }
  if (!snaps.length) return null;

  // Don't record until the game is at/near start — otherwise "closing" is just
  // an early snapshot ≈ entry (the original bug).
  const commence = snaps.find((s) => s.commence_time)?.commence_time;
  if (commence && Date.now() < new Date(commence).getTime() - CLOSE_LEAD_MS) return null;

  // Group snapshots into batches by capture time.
  const byTs = new Map();
  for (const s of snaps) { const k = s.fetched_at; (byTs.get(k) || byTs.set(k, []).get(k)).push(s); }
  const tss = [...byTs.keys()].sort();
  if (tss.length < 1) return null;
  const closeTs = tss[tss.length - 1];

  // Entry batch = the snapshot nearest to when the play was logged.
  const entryAt = new Date(p.scored_at).getTime();
  let entryTs = tss[0], best = Infinity;
  for (const t of tss) { const d = Math.abs(new Date(t).getTime() - entryAt); if (d < best) { best = d; entryTs = t; } }

  const entry = batchConsensus(byTs.get(entryTs));
  const close = batchConsensus(byTs.get(closeTs));

  // Prefer the actually-logged entry line (what we'd have bet); fall back to the
  // entry snapshot consensus if the play didn't store one.
  const lineEntry = p.line != null ? Number(p.line) : entry.line;
  const lineClose = close.line;

  // suspect = the two points aren't genuinely distinct in time → can't trust it.
  const distinct = new Date(closeTs).getTime() > new Date(entryTs).getTime();
  const suspect = !distinct;

  let clv = null, beat = null;
  if (p.market === 'ml') {
    if (entry.price == null || close.price == null) return null;
    // Beating the close on a moneyline = you locked a better (cheaper) price than
    // the market settled at, i.e. your entry implied prob is BELOW the close's.
    // clv = close implied − entry implied (positive = you beat the close).
    clv = Math.round((impliedProb(close.price) - impliedProb(entry.price)) * 1000) / 10; // pts of implied prob
    beat = clv > 0;
  } else {
    if (lineEntry == null || lineClose == null) return null;
    // Side-aware: Under wants the total to rise; Over wants it to fall; a spread
    // side always wants a higher (more favorable) number.
    if (p.market === 'total') clv = p.side === 'Under' ? lineClose - lineEntry : lineEntry - lineClose;
    else clv = lineClose - lineEntry; // spread, from the bet side's perspective
    clv = Math.round(clv * 10) / 10;
    beat = clv > 0;
  }

  return {
    sport: p.sport, game_id: p.game_id, bet_market: p.market, side: p.side,
    line_logged: lineEntry, line_close: lineClose, odds_logged: entry.price, odds_close: close.price,
    clv, beat_close: beat, entry_at: new Date(entryTs).toISOString(), close_at: new Date(closeTs).toISOString(),
    suspect, recorded_at: new Date().toISOString(),
  };
}

// Aggregate clean (non-suspect) clv_records into the dashboard summary.
async function publishReport() {
  const since = new Date(Date.now() - REPORT_DAYS * 86400_000).toISOString();
  let all = [];
  try { all = await db.select('clv_records', '*', { gte: { recorded_at: since }, order: { column: 'recorded_at', ascending: false }, limit: 2000 }); }
  catch (e) { return; }
  const clean = all.filter((r) => !r.suspect);
  const fin = (rows) => {
    const n = rows.length;
    const beat = rows.filter((r) => r.beat_close).length;
    const avg = n ? Math.round((rows.reduce((s, r) => s + (Number(r.clv) || 0), 0) / n) * 100) / 100 : 0;
    return { n, beat, beat_pct: n ? Math.round((beat / n) * 1000) / 10 : 0, avg_clv: avg };
  };
  const bySport = {};
  for (const r of clean) (bySport[r.sport || '—'] ||= []).push(r);
  setClvReport({
    days: REPORT_DAYS,
    overall: fin(clean),
    bySport: Object.entries(bySport).map(([sport, rows]) => ({ sport, ...fin(rows) })).sort((a, b) => b.n - a.n),
    recent: clean.slice(0, 30).map((r) => ({ sport: r.sport, game_id: r.game_id, market: r.bet_market, side: r.side, line_logged: r.line_logged, line_close: r.line_close, clv: r.clv, beat_close: r.beat_close, recorded_at: r.recorded_at })),
    suspect_excluded: all.length - clean.length,
    updated_at: new Date().toISOString(),
  });
}

async function run() {
  if (!db.isConnected()) return { summary: 'skipped — no DB' };

  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  let plays = [];
  try {
    plays = await db.select('monitor_scores', 'sport,game_id,market,side,line,scored_at', {
      match: { qualified: true }, gte: { scored_at: since }, order: { column: 'scored_at', ascending: false }, limit: 800,
    });
  } catch (e) { await publishReport(); return { summary: `select failed: ${e.message}` }; }

  // Already-finalized (non-suspect) plays — don't re-capture or overwrite a good close.
  let done = new Set();
  try {
    const ex = await db.select('clv_records', 'game_id,bet_market,side,suspect', { gte: { recorded_at: since } });
    done = new Set(ex.filter((r) => !r.suspect).map((r) => `${r.game_id}|${r.bet_market}|${r.side}`));
  } catch (e) { /* none */ }

  const records = [];
  let tooEarly = 0, suspectN = 0;
  for (const p of plays) {
    if (done.has(`${p.game_id}|${p.market}|${p.side}`)) continue;
    const rec = await capture(p);
    if (!rec) { tooEarly++; continue; }
    if (rec.suspect) suspectN++;
    if (rec.suspect && rec.entry_at === rec.close_at) {
      logger.warn('clv', `entry==close timestamp for ${p.game_id} ${p.market} ${p.side} — closing capture not distinct`);
    }
    records.push(rec);
  }

  if (records.length) {
    try { await db.upsert('clv_records', records, 'game_id,bet_market,side'); }
    catch (e) { logger.warn('clv', e.message); }
  }
  await publishReport();
  const beat = records.filter((r) => r.beat_close && !r.suspect).length;
  return { summary: `${records.length} CLV records (${beat} beat close${suspectN ? `, ${suspectN} suspect` : ''})`, data: { recorded: records.length, beat, suspect: suspectN } };
}

export default { name: 'clv', run };
