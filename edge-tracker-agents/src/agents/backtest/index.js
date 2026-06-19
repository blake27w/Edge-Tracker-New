// ══════════════════════════════════════════════════════════════
// Backtest / Track-Record Agent — reads graded plays from
// monitor_scores and answers "which signals actually win?". Computes
// record, win%, and ROI overall and broken down by signal, sport,
// market, tier, and confidence bucket. $0 — pure aggregation of data
// the grading agent already produced.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setBacktest } from '../../store/index.js';

const blank = () => ({ n: 0, w: 0, l: 0, p: 0, staked: 0, pnl: 0 });

function tally(a, r) {
  a.n++;
  if (r.status === 'win') a.w++; else if (r.status === 'loss') a.l++; else a.p++;
  a.staked += Number(r.unit_dollars) || 0;
  a.pnl += Number(r.pnl) || 0;
}

function finalize(a) {
  const decided = a.w + a.l;
  return {
    n: a.n, w: a.w, l: a.l, p: a.p,
    winPct: decided ? Math.round((a.w / decided) * 1000) / 10 : 0,
    roi: a.staked ? Math.round((a.pnl / a.staked) * 1000) / 10 : 0,
    pnl: Math.round(a.pnl * 100) / 100,
    staked: Math.round(a.staked * 100) / 100,
  };
}

// Group rows by a key (or keys) function; return top entries sorted by volume.
function group(rows, keyFn, { min = 1, top = 14 } = {}) {
  const m = {};
  for (const r of rows) {
    for (const k of [].concat(keyFn(r))) {
      if (k == null || k === '') continue;
      (m[k] ||= blank()); tally(m[k], r);
    }
  }
  return Object.entries(m)
    .filter(([, a]) => a.n >= min)
    .map(([key, a]) => ({ key, ...finalize(a) }))
    .sort((x, y) => y.n - x.n)
    .slice(0, top);
}

const sign = (n) => (n >= 0 ? '+' + n : '' + n);

async function clvSummary() {
  let rows = [];
  try { rows = await db.select('clv_records', 'clv,beat_close', { limit: 2000 }); } catch (_) { return null; }
  if (!rows.length) return null;
  const avg = rows.reduce((s, r) => s + (Number(r.clv) || 0), 0) / rows.length;
  const beat = rows.filter((r) => r.beat_close).length;
  return { n: rows.length, avg: Math.round(avg * 10) / 10, beatPct: Math.round((beat / rows.length) * 100) };
}

// One honest "are we winning?" read — weights CLV early, ROI once the sample is real.
function verdict(o, clv) {
  const n = o.n || 0, roi = o.roi || 0;
  const beat = clv ? clv.beatPct : null, cAvg = clv ? clv.avg : null;
  let state, headline;
  if (n < 25) {
    if (beat != null && beat >= 55) { state = 'early-good'; headline = `Too early on results (${n} graded) — but CLV is positive (${beat}% beat the close, ${sign(cAvg)} avg). That's the best early sign you're winning.`; }
    else if (beat != null && beat < 45) { state = 'early-warn'; headline = `Only ${n} graded — too early to judge, and CLV is soft (${beat}% beat the close). Watch it.`; }
    else { state = 'early'; headline = `Only ${n} graded plays — too early to call. Need ~100+ before ROI means much; CLV will tell us sooner.`; }
  } else {
    state = roi > 2 ? 'winning' : roi < -2 ? 'losing' : 'breakeven';
    const lead = state === 'winning' ? 'Winning' : state === 'losing' ? 'Losing' : 'Break-even';
    headline = `${lead}: ${sign(roi)}% ROI over ${n} graded (${o.w}-${o.l}-${o.p}, ${o.winPct}% win)` + (cAvg != null ? ` · ${sign(cAvg)} avg CLV, ${beat}% beat close.` : '.');
  }
  return { state, n, roi, winPct: o.winPct, clvAvg: cAvg, beatPct: beat, headline };
}

function confBucket(r) {
  const s = Number(r.score) || 0;
  if (s >= 90) return '90+'; if (s >= 80) return '80–89'; if (s >= 70) return '70–79'; return '<70';
}
function t1Bucket(r) {
  const t = Number(r.t1_count) || 0;
  return t >= 3 ? '3+ T1' : `${t} T1`;
}
function signalLabels(r) {
  const s = r.signals;
  if (!Array.isArray(s)) return [];
  return s.map((x) => x && (x.label || x.id)).filter(Boolean);
}

async function run() {
  if (!db.isConnected()) { setBacktest(null); return { summary: 'skipped — no DB' }; }

  let rows = [];
  try {
    rows = await db.select('monitor_scores', 'sport,market,tier,score,t1_count,signals,status,unit_dollars,pnl,matchup,side,line,player,result_score,graded_at', {
      in: { status: ['win', 'loss', 'push'] },
      order: { column: 'graded_at', ascending: false },
      limit: 5000,
    });
  } catch (e) { logger.warn('backtest', e.message); setBacktest(null); return { summary: `select failed: ${e.message}` }; }

  if (!rows.length) {
    const clv0 = await clvSummary();
    const o0 = finalize(blank());
    setBacktest({ updated: new Date().toISOString(), overall: o0, bySignal: [], bySport: [], byMarket: [], byTier: [], byConfidence: [], byT1: [], clv: clv0, verdict: verdict(o0, clv0) });
    return { summary: 'no graded plays yet' };
  }

  const all = blank();
  for (const r of rows) tally(all, r);

  const report = {
    updated: new Date().toISOString(),
    overall: finalize(all),
    bySignal: group(rows, signalLabels, { min: 3 }),         // headline: which signals win
    bySport: group(rows, (r) => r.sport),
    byMarket: group(rows, (r) => r.market),
    byTier: group(rows, (r) => r.tier),
    byConfidence: group(rows, confBucket),
    byT1: group(rows, t1Bucket),
  };
  // Research picks get their own scorecard (separate from the signal track record).
  try {
    const rr = await db.select('research_notes', 'status,pnl', { match: { type: 'pick' }, in: { status: ['win', 'loss', 'push'] }, limit: 2000 });
    if (rr.length) {
      const a = blank();
      for (const r of rr) { a.staked += config.rules.unitDollars; tally(a, { status: r.status, pnl: r.pnl, unit_dollars: 0 }); }
      report.research = finalize(a);
    } else report.research = finalize(blank());
  } catch (_) { report.research = finalize(blank()); }

  report.clv = await clvSummary();
  report.verdict = verdict(report.overall, report.clv);
  report.recent = rows.slice(0, 50).map((r) => ({
    sport: r.sport, market: r.market, matchup: r.matchup, side: r.side, line: r.line, player: r.player,
    status: r.status, pnl: r.pnl, result_score: r.result_score, graded_at: r.graded_at,
  }));
  setBacktest(report);

  const o = report.overall;
  return { summary: `${o.n} graded · ${o.w}-${o.l}-${o.p} · ${o.winPct}% · ${o.roi >= 0 ? '+' : ''}${o.roi}% ROI`, data: { graded: o.n, roi: o.roi } };
}

export default { name: 'backtest', run };
