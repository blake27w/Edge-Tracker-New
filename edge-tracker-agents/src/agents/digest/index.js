// ══════════════════════════════════════════════════════════════
// Daily Digest — one scheduled summary tying the whole system
// together: today's slate (plays/EV/arbs/line flags), recent graded
// results, track record, CLV, and current cost. Template-based (no
// Claude), delivered via the existing SMS/email channel. $0.
// Delivery time is configurable via DIGEST_TIMES (default 09:00).
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger, notifyAll, getClaudeUsage } from '../../utils/index.js';
import { getPlays, getPropPlays, getEvPlays, getArbPlays, getStaleLines, getDivergence, getBacktest } from '../../store/index.js';
import { getOddsBudget } from '../odds/index.js';

const sign = (n) => (n >= 0 ? '+' + n : '' + n);

async function recentResults() {
  if (!db.isConnected()) return null;
  const since = new Date(Date.now() - 30 * 3600_000).toISOString();
  let rows = [];
  try {
    rows = await db.select('monitor_scores', 'status,pnl,unit_dollars', {
      in: { status: ['win', 'loss', 'push'] }, gte: { graded_at: since }, limit: 500,
    });
  } catch (_) { return null; }
  if (!rows.length) return { n: 0 };
  let w = 0, l = 0, p = 0, pnl = 0, staked = 0;
  for (const r of rows) {
    if (r.status === 'win') w++; else if (r.status === 'loss') l++; else p++;
    pnl += Number(r.pnl) || 0; staked += Number(r.unit_dollars) || 0;
  }
  return { n: rows.length, w, l, p, pnl: Math.round(pnl * 100) / 100, roi: staked ? Math.round((pnl / staked) * 1000) / 10 : 0 };
}

async function clvSummary() {
  if (!db.isConnected()) return null;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  let rows = [];
  try { rows = await db.select('clv_records', 'clv,beat_close', { gte: { recorded_at: since }, limit: 1000 }); }
  catch (_) { return null; }
  if (!rows.length) return null;
  const avg = rows.reduce((s, r) => s + (Number(r.clv) || 0), 0) / rows.length;
  const beat = rows.filter((r) => r.beat_close).length;
  return { n: rows.length, avg: Math.round(avg * 10) / 10, beatPct: Math.round((beat / rows.length) * 100) };
}

async function run() {
  const plays = getPlays() || [];
  const ev = getEvPlays() || [];
  const arb = getArbPlays() || [];
  const arbs = arb.filter((a) => a.type === 'arb').length;
  const middles = arb.length - arbs;
  const lineFlags = (getStaleLines() || []).length + (getDivergence() || []).length;
  const props = (getPropPlays() || []).length;

  const L = [];
  L.push(`📰 Edge Tracker — ${new Date().toISOString().slice(0, 10)}`);
  L.push('');
  L.push(`TODAY: ${plays.length} plays · ${props} props · ${ev.length} +EV · ${arbs} arbs · ${middles} middles · ${lineFlags} line flags`);

  const topPlay = [...plays].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  if (topPlay) L.push(`Top play: ${topPlay.matchup} ${topPlay.side}${topPlay.line != null ? ' ' + topPlay.line : ''} (${Math.round(topPlay.score)} conf, ${topPlay.tier})`);
  if (ev[0]) L.push(`Top +EV: ${ev[0].matchup} ${ev[0].side} +${ev[0].ev_pct}% @ ${ev[0].book}`);

  const res = await recentResults();
  if (res && res.n) L.push(`Results (24h): ${res.w}-${res.l}-${res.p} · ${sign(res.pnl)}$ · ${sign(res.roi)}% ROI`);

  const bt = getBacktest();
  if (bt && bt.verdict) L.push(`Status: ${bt.verdict.headline}`);
  else if (bt && bt.overall && bt.overall.n) L.push(`Track record: ${bt.overall.w}-${bt.overall.l} · ${bt.overall.winPct}% · ${sign(bt.overall.roi)}% ROI (${bt.overall.n})`);

  const clv = await clvSummary();
  if (clv) L.push(`CLV (30d): ${sign(clv.avg)} avg · ${clv.beatPct}% beat close (${clv.n})`);

  try {
    const ob = getOddsBudget();
    const cu = await getClaudeUsage();
    L.push(`Cost: odds ${ob.used}/${ob.budget} credits · Claude $${cu.cost} MTD (~$${cu.projectedMonthly}/mo)`);
  } catch (_) { /* ignore */ }

  const body = L.join('\n');
  let total = 0;
  try {
    const r = await notifyAll('Edge Tracker daily digest', body);
    total = r.total;
    await db.insert('alert_log', { type: r.email && !r.sms ? 'email' : 'sms', channel: 'digest', recipients: total, body, status: 'sent' });
  } catch (e) { logger.warn('digest', `send: ${e.message}`); }

  return { summary: `digest sent to ${total} recipient(s)`, data: { plays: plays.length, ev: ev.length, recipients: total } };
}

export default { name: 'digest', run };
