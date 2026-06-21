// ══════════════════════════════════════════════════════════════
// Book Edges — turns the proven stale-line / divergence edge into an
// actionable watchlist. Aggregates book_edge_log episodes (one per
// open→correct window) joined to graded opp_results, sliced by
// BOOK × MARKET × SPORT × TYPE:
//   • how often a book is the off-market laggard, with hit rate + ROI
//   • the staleness WINDOW (how long you had to act)
//   • average line discrepancy
//   • rolling 7d vs prior trend → surfaces decaying edges before they die
//   • cumulative exposure per book (limit-risk awareness)
// Pure aggregation of data we already capture. $0.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setBookEdges } from '../../store/index.js';

const UNIT = config.rules.unitDollars;
const MIN_SAMPLE = Number(process.env.BOOK_EDGE_MIN_SAMPLE) || 15; // below this = too small to trust

function acc() { return { n: 0, graded: 0, w: 0, l: 0, p: 0, staked: 0, pnl: 0, winSum: 0, winN: 0, ptsSum: 0, ptsN: 0, r7n: 0, r7staked: 0, r7pnl: 0, pPnl: 0, pStaked: 0 }; }

function fin(a) {
  const dec = a.w + a.l;
  return {
    n: a.n, graded: a.graded, w: a.w, l: a.l, p: a.p,
    hitPct: dec ? Math.round((a.w / dec) * 1000) / 10 : null,
    roi: a.staked ? Math.round((a.pnl / a.staked) * 1000) / 10 : null,
    staked: Math.round(a.staked * 100) / 100,
    avgWindowSec: a.winN ? Math.round(a.winSum / a.winN) : null,
    avgPts: a.ptsN ? Math.round((a.ptsSum / a.ptsN) * 10) / 10 : null,
    recentN: a.r7n,
    recentRoi: a.r7staked ? Math.round((a.r7pnl / a.r7staked) * 1000) / 10 : null,
    priorRoi: a.pStaked ? Math.round((a.pPnl / a.pStaked) * 1000) / 10 : null,
    small: a.graded < MIN_SAMPLE,
  };
}

async function run() {
  if (!db.isConnected()) { setBookEdges(null); return { summary: 'skipped — no DB' }; }

  let episodes = [], results = [];
  try { episodes = await db.select('book_edge_log', '*', { order: { column: 'detected_at', ascending: false }, limit: 20000 }); }
  catch (e) { setBookEdges(null); return { summary: `book_edge_log read failed: ${e.message}` }; }
  if (!episodes.length) { setBookEdges({ updated: new Date().toISOString(), minSample: MIN_SAMPLE, byBook: [], grid: [], decay: [], exposure: [] }); return { summary: 'no book-edge episodes yet' }; }
  try { results = await db.select('opp_results', 'type,game_id,market,side,status,pnl', { limit: 20000 }); } catch (_) { /* none */ }

  const resMap = new Map();
  for (const r of results) resMap.set(`${r.type}|${r.game_id}|${r.market}|${r.side}`, r);

  const now = Date.now();
  const tally = (a, ep, res) => {
    a.n++;
    if (ep.window_sec != null) { a.winSum += Number(ep.window_sec); a.winN++; }
    if (ep.pts != null) { a.ptsSum += Number(ep.pts); a.ptsN++; }
    if (res && (res.status === 'win' || res.status === 'loss' || res.status === 'push')) {
      a.graded++; a.staked += UNIT; a.pnl += Number(res.pnl) || 0;
      if (res.status === 'win') a.w++; else if (res.status === 'loss') a.l++; else a.p++;
      const ageD = (now - new Date(ep.detected_at).getTime()) / 86400_000;
      if (ageD <= 7) { a.r7n++; a.r7staked += UNIT; a.r7pnl += Number(res.pnl) || 0; }
      else if (ageD <= 30) { a.pStaked += UNIT; a.pPnl += Number(res.pnl) || 0; }
    }
  };

  const byBook = {}, grid = {};
  for (const ep of episodes) {
    if (!ep.book) continue;
    const res = resMap.get(`${ep.type}|${ep.game_id}|${ep.market}|${ep.side}`);
    tally((byBook[ep.book] ||= acc()), ep, res);
    tally((grid[`${ep.book}|${ep.sport}|${ep.market}|${ep.type}`] ||= acc()), ep, res);
  }

  // Ranked watchlist: trustworthy samples (graded ≥ MIN) by ROI first, then the rest by volume.
  const byBookArr = Object.entries(byBook).map(([book, a]) => ({ book, ...fin(a) }))
    .sort((x, y) => (Number(!y.small) - Number(!x.small)) || ((y.roi ?? -999) - (x.roi ?? -999)) || (y.n - x.n));

  const gridArr = Object.entries(grid).map(([k, a]) => { const [book, sport, market, type] = k.split('|'); return { book, sport, market, type, ...fin(a) }; })
    .sort((x, y) => y.graded - x.graded || y.n - x.n);

  // Decay: a cell that WAS profitable but has gone cold in the last 7 days.
  const decay = gridArr.filter((c) => !c.small && c.recentN >= 3 && c.recentRoi != null && c.recentRoi < 0 && (c.priorRoi != null ? c.priorRoi > 0 : c.roi > 0))
    .map((c) => ({ book: c.book, sport: c.sport, market: c.market, type: c.type, recentN: c.recentN, recentRoi: c.recentRoi, priorRoi: c.priorRoi, roi: c.roi }))
    .slice(0, 20);

  const exposure = byBookArr.filter((b) => b.graded > 0).map((b) => ({ book: b.book, graded: b.graded, staked: b.staked })).sort((a, b) => b.staked - a.staked);

  setBookEdges({ updated: new Date().toISOString(), minSample: MIN_SAMPLE, byBook: byBookArr, grid: gridArr.slice(0, 120), decay, exposure });

  const open = episodes.filter((e) => !e.corrected_at).length;
  return { summary: `${byBookArr.length} books · ${gridArr.length} book×market cells · ${decay.length} decaying · ${open} open`, data: { books: byBookArr.length, cells: gridArr.length, decay: decay.length } };
}

export default { name: 'book-edges', run };
