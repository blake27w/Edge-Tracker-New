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
    rows = await db.select('monitor_scores', 'sport,market,tier,score,t1_count,signals,status,unit_dollars,pnl', {
      in: { status: ['win', 'loss', 'push'] },
      order: { column: 'graded_at', ascending: false },
      limit: 5000,
    });
  } catch (e) { logger.warn('backtest', e.message); setBacktest(null); return { summary: `select failed: ${e.message}` }; }

  if (!rows.length) {
    setBacktest({ updated: new Date().toISOString(), overall: finalize(blank()), bySignal: [], bySport: [], byMarket: [], byTier: [], byConfidence: [], byT1: [] });
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
  setBacktest(report);

  const o = report.overall;
  return { summary: `${o.n} graded · ${o.w}-${o.l}-${o.p} · ${o.winPct}% · ${o.roi >= 0 ? '+' : ''}${o.roi}% ROI`, data: { graded: o.n, roi: o.roi } };
}

export default { name: 'backtest', run };
