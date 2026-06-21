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
// Distinct signal ids on a play (for the totals-by-sub-signal breakdown).
function signalIds(r) {
  const s = r.signals;
  if (!Array.isArray(s)) return [];
  return [...new Set(s.map((x) => x && x.id).filter(Boolean))];
}

// Human labels for stable signal ids (the per-signal CLV scorecard groups by id).
const SIG_LABELS = {
  rlm: 'RLM vs public', steam: 'Steam / sharp move', wind: 'Wind (directional)',
  divergence: 'Handle>bets divergence', injury_out: 'Key player OUT', schedule: 'Schedule spot',
  bullpen: 'Bullpen/park Under', bullpen_over: 'Bullpen Over', power: 'Power-rating gap',
  under_bias: 'Structural Under bias', weather_mild: 'Mild wind', ev: '+EV vs fair', weighin: 'Weigh-in news',
};

// PER-SIGNAL CLV SCORECARD — the key analytic: which signal TYPES actually beat
// the close. Joins each qualifying play's signals to its (clean) CLV record and
// attributes that play's CLV to every signal id on it. CLV is the leading
// indicator, so this counts every play that has a CLV record, graded or not;
// win/ROI are reported for the graded subset. Signals that consistently lose to
// the close get flagged for removal.
async function signalCard() {
  let clvRows = [];
  try { clvRows = await db.select('clv_records', 'game_id,bet_market,side,clv,beat_close', { match: { suspect: false }, limit: 8000 }); }
  catch (_) { return []; }
  if (!clvRows.length) return [];
  const clvMap = new Map();
  for (const c of clvRows) clvMap.set(`${c.game_id}|${c.bet_market}|${c.side}`, c);

  let plays = [];
  try { plays = await db.select('monitor_scores', 'sport,game_id,market,side,signals,status,pnl,unit_dollars,observational', { match: { qualified: true }, order: { column: 'scored_at', ascending: false }, limit: 8000 }); }
  catch (_) { return []; }

  const FIGHT = new Set(['UFC', 'BOXING']);
  const agg = {};
  for (const p of plays) {
    if (p.observational && FIGHT.has(p.sport)) continue; // combat stays out; totals on probation are INCLUDED (that's how we judge them)
    const c = clvMap.get(`${p.game_id}|${p.market}|${p.side}`);
    if (!c) continue;
    const ids = [...new Set((Array.isArray(p.signals) ? p.signals : []).map((s) => s && s.id).filter(Boolean))];
    for (const id of ids) {
      const a = (agg[id] ||= { n: 0, beat: 0, clvSum: 0, graded: 0, w: 0, l: 0, staked: 0, pnl: 0 });
      a.n++; if (c.beat_close) a.beat++; a.clvSum += Number(c.clv) || 0;
      if (p.status === 'win' || p.status === 'loss' || p.status === 'push') {
        a.graded++; if (p.status === 'win') a.w++; else if (p.status === 'loss') a.l++;
        a.staked += Number(p.unit_dollars) || 0; a.pnl += Number(p.pnl) || 0;
      }
    }
  }
  return Object.entries(agg)
    .filter(([, a]) => a.n >= 3)
    .map(([id, a]) => {
      const decided = a.w + a.l;
      return {
        id, label: SIG_LABELS[id] || id, n: a.n,
        beatPct: Math.round((a.beat / a.n) * 1000) / 10,
        avgClv: Math.round((a.clvSum / a.n) * 100) / 100,
        graded: a.graded,
        winPct: decided ? Math.round((a.w / decided) * 1000) / 10 : null,
        roi: a.staked ? Math.round((a.pnl / a.staked) * 1000) / 10 : null,
        flag: a.n >= 20 && (a.beat / a.n) < 0.5,    // consistently loses to the close → review for removal
      };
    })
    .sort((x, y) => y.n - x.n);
}

async function run() {
  if (!db.isConnected()) { setBacktest(null); return { summary: 'skipped — no DB' }; }

  let rows = [];
  try {
    rows = await db.select('monitor_scores', '*', {
      in: { status: ['win', 'loss', 'push'] },
      order: { column: 'graded_at', ascending: false },
      limit: 5000,
    });
  } catch (e) { logger.warn('backtest', e.message); setBacktest(null); return { summary: `select failed: ${e.message}` }; }

  if (!rows.length) {
    const clv0 = await clvSummary();
    const o0 = finalize(blank());
    setBacktest({ updated: new Date().toISOString(), overall: o0, bySignal: [], bySport: [], byMarket: [], byTier: [], byConfidence: [], byT1: [], signalClv: await signalCard(), clv: clv0, verdict: verdict(o0, clv0) });
    return { summary: 'no graded plays yet' };
  }

  // Observational plays are kept OUT of the headline record. Two kinds:
  // combat (validation-gated) and totals on probation. Separate them so each
  // gets its own scorecard.
  const FIGHT = new Set(['UFC', 'BOXING']);
  const observational = rows.filter((r) => r.observational);
  const combatRows = observational.filter((r) => FIGHT.has(r.sport));
  const probTotals = observational.filter((r) => !FIGHT.has(r.sport) && r.market === 'total'); // totals on probation (keyed on market, so tennis/other can't leak in)
  const tennisObs = observational.filter((r) => r.sport === 'TENNIS'); // tennis (observational until validated)
  rows = rows.filter((r) => !r.observational);

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
    // Prop sub-type breakdown — learn WHICH prop trigger works as the sample grows.
    propBySub: group(rows.filter((r) => r.market === 'prop'), (r) => r.prop_signal_type || 'other', { min: 1 }),
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
  report.signalClv = await signalCard();          // per-signal CLV scorecard (what actually beats the close)
  report.verdict = verdict(report.overall, report.clv);

  // Opportunity scanners — did the flags actually win? (graded by opp-grading)
  // Aggregate by type AND surface each graded flag with its trigger detail.
  try {
    const orows = await db.select('opp_results', '*', { order: { column: 'graded_at', ascending: false }, limit: 8000 });
    const m = {};
    for (const r of orows) { (m[r.type] ||= blank()); m[r.type].staked += config.rules.unitDollars; tally(m[r.type], { status: r.status, pnl: r.pnl, unit_dollars: 0 }); }
    report.opps = Object.entries(m).map(([k, a]) => ({ key: k, ...finalize(a) })).sort((x, y) => y.n - x.n);
    report.oppsRecent = orows.slice(0, 80).map((r) => ({
      type: r.type, sport: r.sport, matchup: r.matchup, market: r.market, side: r.side, line: r.line,
      detail: r.detail, price: r.price, status: r.status, pnl: r.pnl, graded_at: r.graded_at,
    }));
  } catch (_) { report.opps = []; report.oppsRecent = []; }

  // Combat (observational, validation-gated — not in the main record yet).
  {
    const a = blank();
    for (const r of combatRows) { a.staked += config.rules.unitDollars; tally(a, { status: r.status, pnl: r.pnl, unit_dollars: 0 }); }
    report.combat = { ...finalize(a), gate: 50, gated: combatRows.length < 50 };
  }
  // Totals on probation (observational) — kept out of the headline; broken down
  // by sub-signal so we can see if ANY totals trigger beats the close.
  {
    const a = blank();
    for (const r of probTotals) tally(a, r);
    report.totals = { ...finalize(a), probation: config.rules.totalsProbation, bySignal: group(probTotals, signalIds, { min: 1 }) };
  }
  // Tennis (observational until it proves positive CLV) — by sub-signal.
  {
    const a = blank();
    for (const r of tennisObs) tally(a, r);
    report.tennis = { ...finalize(a), observational: config.rules.tennisObservational, bySignal: group(tennisObs, signalIds, { min: 1 }) };
  }
  report.recent = rows.slice(0, 50).map((r) => ({
    sport: r.sport, market: r.market, matchup: r.matchup, side: r.side, line: r.line, player: r.player,
    status: r.status, pnl: r.pnl, result_score: r.result_score, anomaly: r.anomaly, graded_at: r.graded_at,
  }));
  // Variance losses — how many losses were bad beats (OT / hook / close) vs bad reads.
  const losses = rows.filter((r) => r.status === 'loss');
  report.variance = {
    losses: losses.length,
    overtime: losses.filter((r) => r.anomaly === 'overtime').length,
    hook: losses.filter((r) => r.anomaly === 'hook').length,
    close: losses.filter((r) => r.anomaly === 'close').length,
  };
  setBacktest(report);

  const o = report.overall;
  return { summary: `${o.n} graded · ${o.w}-${o.l}-${o.p} · ${o.winPct}% · ${o.roi >= 0 ? '+' : ''}${o.roi}% ROI`, data: { graded: o.n, roi: o.roi } };
}

export default { name: 'backtest', run };
