// ══════════════════════════════════════════════════════════════
// Arbitrage & Middle Scanner — free, uses our own multi-book odds.
//
//   ARB:    best price on side A (book 1) + best price on side B (book 2)
//           imply < 100% combined → guaranteed profit whatever happens.
//   MIDDLE: bet the lower number Over / higher number Under (or spread
//           equivalents) so a result landing in the gap wins BOTH legs;
//           worst case you only pay the (small) combined juice.
//
// Scans moneyline (all sports), totals & spreads (team sports, per line).
// $0 — no extra API calls.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { getGames, getTennisGames, setArbPlays } from '../../store/index.js';
import { ageMin, STALE_MIN } from '../shared/odds-math.js';

const ARB_MIN = Number(process.env.ARB_MIN_PCT) || 0.5;   // report arbs ≥ 0.5% ROI
const MID_MIN_WIDTH = Number(process.env.MID_MIN_WIDTH) || 2; // ≥2 pt of middle
const MID_MAX_HOLD = Number(process.env.MID_MAX_HOLD) || 0.06; // ≤6% worst-case cost
const ALERT_ARB = Number(process.env.ARB_ALERT_PCT) || 1.0;   // text/email arbs ≥ 1%

const alerted = new Set();
const toDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const fmt = (p) => (p > 0 ? '+' + p : '' + p);

// Best (highest) price per side from a list of {book, price}.
function best(outs) {
  let b = null;
  for (const o of outs) { const d = toDecimal(o.price); if (!b || d > b.dec) b = { ...o, dec: d }; }
  return b;
}

// Two-way arb from two side arrays. Returns null unless it clears ARB_MIN.
function arb(aOuts, bOuts, labelA, labelB, lineA, lineB) {
  const a = best(aOuts), b = best(bOuts);
  if (!a || !b) return null;
  const margin = 1 / a.dec + 1 / b.dec;
  const roi = (1 / margin - 1) * 100;
  if (roi < ARB_MIN) return null;
  return {
    type: 'arb', roi: Math.round(roi * 100) / 100,
    legs: [
      { side: labelA, line: lineA, book: a.book, price: a.price, age: a.age, stake: Math.round(((1 / a.dec) / margin) * 1000) / 10 },
      { side: labelB, line: lineB, book: b.book, price: b.price, age: b.age, stake: Math.round(((1 / b.dec) / margin) * 1000) / 10 },
    ],
  };
}

// Group outcomes by line: line -> best {book, price, dec}.
function byLine(outs) {
  const m = {};
  for (const o of outs) {
    if (o.line == null) continue;
    const d = toDecimal(o.price);
    if (!m[o.line] || d > m[o.line].dec) m[o.line] = { book: o.book, price: o.price, dec: d, line: o.line, age: o.age };
  }
  return m;
}

// Pull per-book quotes for a side, dropping dead-market (stale) quotes — an arb
// or middle leg on a quote the book hasn't changed in STALE_MIN+ min is likely
// already gone, so it would be a phantom. Quotes with no timestamp are kept.
function pull(game, side, now) {
  const out = [];
  for (const [bk, b] of Object.entries(game.books || {})) {
    const o = (b.markets || {})[side];
    if (o && o.price != null) {
      const a = ageMin(o.ts, now);
      if (a != null && a > STALE_MIN) continue;
      out.push({ book: b.label || bk, price: o.price, line: o.line, age: a });
    }
  }
  return out;
}

async function run() {
  const team = getGames();
  const tennis = getTennisGames();
  if (!team.length && !tennis.length) { setArbPlays([]); return { summary: 'no games to scan' }; }

  const rows = [];
  const now = Date.now();
  const add = (g, market, r) => rows.push({
    ...r, sport: g.sport, game_id: g.game_id, commence_time: g.commence_time, market,
    matchup: g.p1 ? `${g.p1} vs ${g.p2}` : `${g.away} @ ${g.home}`,
  });

  // ── Moneyline arbs (all sports) ──
  for (const g of [...team, ...tennis]) {
    const A = g.p1 || g.home, B = g.p2 || g.away;
    const r = arb(pull(g, `h2h:${A}`, now), pull(g, `h2h:${B}`, now), A, B, null, null);
    if (r && r.legs[0].book !== r.legs[1].book) add(g, 'ml', r);
  }

  // ── Totals & spreads arbs + middles (team sports, per line) ──
  for (const g of team) {
    // Totals
    const over = byLine(pull(g, 'totals:Over', now)), under = byLine(pull(g, 'totals:Under', now));
    let bestMid = null;
    for (const lo of Object.values(over)) for (const hi of Object.values(under)) {
      const margin = 1 / lo.dec + 1 / hi.dec;
      if (hi.line === lo.line) {                       // same line → potential arb
        const roi = (1 / margin - 1) * 100;
        if (roi >= ARB_MIN) add(g, `total ${lo.line}`, { type: 'arb', roi: Math.round(roi * 100) / 100,
          legs: [{ side: 'Over', line: lo.line, book: lo.book, price: lo.price, stake: Math.round(((1 / lo.dec) / margin) * 1000) / 10 },
                 { side: 'Under', line: hi.line, book: hi.book, price: hi.price, stake: Math.round(((1 / hi.dec) / margin) * 1000) / 10 }] });
      } else if (hi.line > lo.line) {                  // Over low + Under high → middle
        const width = Math.round((hi.line - lo.line) * 10) / 10, hold = margin - 1;
        if (width >= MID_MIN_WIDTH && hold <= MID_MAX_HOLD && (!bestMid || width > bestMid.width))
          bestMid = { type: 'middle', width, hold: Math.round(hold * 1000) / 10, market: `total`,
            legs: [{ side: 'Over', line: lo.line, book: lo.book, price: lo.price }, { side: 'Under', line: hi.line, book: hi.book, price: hi.price }] };
      }
    }
    if (bestMid) add(g, `total ${bestMid.legs[0].line}/${bestMid.legs[1].line}`, bestMid);

    // Spreads (home line h, away line a; middle when h + a > 0, arb when == 0)
    const homeS = byLine(pull(g, `spreads:${g.home}`, now)), awayS = byLine(pull(g, `spreads:${g.away}`, now));
    let bestSpMid = null;
    for (const h of Object.values(homeS)) for (const a of Object.values(awayS)) {
      const gap = Math.round((h.line + a.line) * 10) / 10;
      const margin = 1 / h.dec + 1 / a.dec;
      if (gap === 0) {
        const roi = (1 / margin - 1) * 100;
        if (roi >= ARB_MIN) add(g, `spread ${fmt(h.line)}`, { type: 'arb', roi: Math.round(roi * 100) / 100,
          legs: [{ side: g.home, line: h.line, book: h.book, price: h.price, stake: Math.round(((1 / h.dec) / margin) * 1000) / 10 },
                 { side: g.away, line: a.line, book: a.book, price: a.price, stake: Math.round(((1 / a.dec) / margin) * 1000) / 10 }] });
      } else if (gap > 0) {
        const hold = margin - 1;
        if (gap >= MID_MIN_WIDTH && hold <= MID_MAX_HOLD && (!bestSpMid || gap > bestSpMid.width))
          bestSpMid = { type: 'middle', width: gap, hold: Math.round(hold * 1000) / 10, market: 'spread',
            legs: [{ side: g.home, line: h.line, book: h.book, price: h.price }, { side: g.away, line: a.line, book: a.book, price: a.price }] };
      }
    }
    if (bestSpMid) add(g, `spread ${fmt(bestSpMid.legs[0].line)}/${fmt(bestSpMid.legs[1].line)}`, bestSpMid);
  }

  // arbs first (by ROI), then middles (by width)
  rows.sort((a, b) => (b.roi || 0) - (a.roi || 0) || (b.width || 0) - (a.width || 0));
  setArbPlays(rows);

  if (rows.length) {
    const now = new Date().toISOString();
    try {
      await db.insert('arb_opportunities', rows.map((r) => ({
        type: r.type, sport: r.sport, game_id: r.game_id, matchup: r.matchup, market: r.market,
        roi_pct: r.roi ?? null, width: r.width ?? null, hold_pct: r.hold ?? null,
        legs: JSON.stringify(r.legs), fetched_at: now,
      })));
    } catch (e) { logger.warn('arb-scanner', e.message); }
  }

  // Alert real arbs (rare + valuable), deduped.
  for (const r of rows) {
    if (r.type !== 'arb' || r.roi < ALERT_ARB) continue;
    const key = `${r.game_id}|${r.market}|${r.legs.map((l) => l.book).join('/')}`;
    if (alerted.has(key)) continue;
    alerted.add(key);
    const legs = r.legs.map((l) => `${l.side}${l.line != null ? ' ' + fmt(l.line) : ''} ${fmt(l.price)} @ ${l.book} (${l.stake}%)`).join('  +  ');
    const body = `🔒 ARB ${r.roi}% — ${r.matchup} [${r.market}]: ${legs}`;
    try {
      const res = await notifyAll('Edge Tracker arbitrage', body);
      await db.insert('alert_log', { type: res.email && !res.sms ? 'email' : 'sms', channel: 'arb', recipients: res.total, body, sport: r.sport, game_id: r.game_id, status: 'sent' });
    } catch (e) { logger.warn('arb-scanner', `alert: ${e.message}`); }
  }

  const arbs = rows.filter((r) => r.type === 'arb').length;
  return { summary: `${arbs} arbs, ${rows.length - arbs} middles`, data: { arbs, middles: rows.length - arbs } };
}

export default { name: 'arb-scanner', run };
