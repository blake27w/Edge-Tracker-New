// ══════════════════════════════════════════════════════════════
// +EV / Boost Scanner — free, uses our own multi-book odds. For each
// market it computes the no-vig "fair" price from the book consensus,
// then flags any book whose price beats fair by a meaningful margin.
// Catches odds boosts, promo prices, and soft/stale lines — all the
// places a book is paying more than the true probability warrants.
//
// Scans moneyline (all sports) and totals (team sports, at the
// consensus line). $0 — no extra API calls.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { getGames, getTennisGames, setEvPlays } from '../../store/index.js';
import { corroboration } from '../shared/corroborate.js';

const MIN_BOOKS = 4;                 // need a real consensus to trust "fair"
const MAX_JUICE = config.rules.maxOppJuice;                 // skip flags priced worse than this (heavy chalk)
const SHOW_EV = Number(process.env.EV_SHOW_PCT) || 0.03;   // flag at +3%
const ALERT_EV = Number(process.env.EV_ALERT_PCT) || 0.10; // text/email at +10%

const alerted = new Set();

const toDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const impliedProb = (a) => 1 / toDecimal(a);
function toAmerican(prob) {
  if (!prob || prob <= 0 || prob >= 1) return null;
  const dec = 1 / prob;
  return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
}

// Two-way devig: given arrays of book prices for side A and side B, return
// the no-vig fair probability for each side (from the average implied probs).
function fairProbs(aPrices, bPrices) {
  if (aPrices.length < MIN_BOOKS || bPrices.length < MIN_BOOKS) return null;
  const a = aPrices.reduce((s, p) => s + impliedProb(p), 0) / aPrices.length;
  const b = bPrices.reduce((s, p) => s + impliedProb(p), 0) / bPrices.length;
  const t = a + b;
  return { a: a / t, b: b / t };
}

// Best +EV book for one side given its fair prob.
function bestEv(sideOutcomes, fair) {
  let best = null;
  for (const o of sideOutcomes) {
    const ev = fair * toDecimal(o.price) - 1;
    if (ev >= SHOW_EV && (!best || ev > best.ev)) best = { book: o.book, price: o.price, ev };
  }
  return best;
}

// Push a +EV play, but on heavily-juiced prices require a corroborating signal
// (sharp/RLM/public) on that side — otherwise skip it.
function consider(rows, game, displayMarket, corrMarket, side, best, fair) {
  if (!best) return;
  let note = null;
  if (best.price < MAX_JUICE) {
    note = corroboration(game.game_id, corrMarket, side);
    if (!note) return;                 // heavy chalk with no backing signal → not an edge
  }
  pushEv(rows, game, displayMarket, side, best, fair, note);
}

// Collect per-book prices for a market:side from a game's books.
function gather(game, makeKey) {
  const out = {}; // side -> [{book, price}]
  for (const [bk, b] of Object.entries(game.books || {})) {
    const label = b.label || bk;
    const mk = b.markets || {};
    for (const [side, key] of Object.entries(makeKey)) {
      const o = mk[key];
      if (o && o.price != null) (out[side] ||= []).push({ book: label, price: o.price });
    }
  }
  return out;
}

function pushEv(rows, game, market, side, best, fair, note) {
  rows.push({
    sport: game.sport, game_id: game.game_id,
    matchup: game.p1 ? `${game.p1} vs ${game.p2}` : `${game.away} @ ${game.home}`,
    commence_time: game.commence_time, market, side,
    book: best.book, price: best.price, fair_price: toAmerican(fair),
    ev_pct: Math.round(best.ev * 1000) / 10, note: note || null,
  });
}

async function run() {
  const team = getGames();
  const tennis = getTennisGames();
  if (!team.length && !tennis.length) { setEvPlays([]); return { summary: 'no games to scan' }; }

  const rows = [];

  // Moneyline (all sports)
  for (const g of [...team, ...tennis]) {
    const sideA = g.p1 || g.home, sideB = g.p2 || g.away;
    const o = gather(g, { A: `h2h:${sideA}`, B: `h2h:${sideB}` });
    const fp = fairProbs((o.A || []).map((x) => x.price), (o.B || []).map((x) => x.price));
    if (!fp) continue;
    consider(rows, g, 'ml', 'ml', sideA, bestEv(o.A, fp.a), fp.a);
    consider(rows, g, 'ml', 'ml', sideB, bestEv(o.B, fp.b), fp.b);
  }

  // Totals (team sports, at the consensus line)
  for (const g of team) {
    if (g.consensusTotal == null) continue;
    const o = { Over: [], Under: [] };
    for (const [bk, b] of Object.entries(g.books || {})) {
      const label = b.label || bk; const mk = b.markets || {};
      const ov = mk['totals:Over'], un = mk['totals:Under'];
      if (ov && ov.price != null && ov.line === g.consensusTotal) o.Over.push({ book: label, price: ov.price });
      if (un && un.price != null && un.line === g.consensusTotal) o.Under.push({ book: label, price: un.price });
    }
    const fp = fairProbs(o.Over.map((x) => x.price), o.Under.map((x) => x.price));
    if (!fp) continue;
    consider(rows, g, `total ${g.consensusTotal}`, 'total', 'Over', bestEv(o.Over, fp.a), fp.a);
    consider(rows, g, `total ${g.consensusTotal}`, 'total', 'Under', bestEv(o.Under, fp.b), fp.b);
  }

  rows.sort((a, b) => b.ev_pct - a.ev_pct);
  setEvPlays(rows);

  if (rows.length) {
    const now = new Date().toISOString();
    try { await db.insert('ev_opportunities', rows.map((r) => ({ ...r, fetched_at: now }))); } catch (e) { logger.warn('ev-scanner', e.message); }
  }

  // Alert the strong ones (likely real boosts), deduped.
  for (const r of rows) {
    if (r.ev_pct / 100 < ALERT_EV) continue;
    const key = `${r.game_id}|${r.market}|${r.side}|${r.book}`;
    if (alerted.has(key)) continue;
    alerted.add(key);
    const body = `💸 +EV ${r.ev_pct}% — ${r.matchup}: ${r.side} ${r.price > 0 ? '+' + r.price : r.price} @ ${r.book} (fair ${r.fair_price > 0 ? '+' + r.fair_price : r.fair_price})`;
    try {
      const res = await notifyAll('Edge Tracker +EV boost', body);
      await db.insert('alert_log', { type: res.email && !res.sms ? 'email' : 'sms', channel: 'ev', recipients: res.total, body, sport: r.sport, game_id: r.game_id, status: 'sent' });
    } catch (e) { logger.warn('ev-scanner', `alert: ${e.message}`); }
  }

  return { summary: `${rows.length} +EV opportunities${rows.length ? ` (top ${rows[0].ev_pct}%)` : ''}`, data: { count: rows.length } };
}

export default { name: 'ev-scanner', run };
