// ══════════════════════════════════════════════════════════════
// Prediction-Market Reference (Polymarket + Kalshi) — DATA ONLY.
// Prediction markets price events with near-zero vig, so their implied
// probability is a sharper "fair value" than a median of retail books.
// This pulls game-winner prices, maps them to our slate, devigs the book
// moneyline, and flags an OBSERVATIONAL "exchange edge" when a book
// underprices a side vs the exchange (book implied < exchange implied by
// a threshold). Reference/signal only — not actionable, not in the record.
//
// OFF by default (config.predictionMarkets) since the public API shapes
// can drift and aren't verified here. Polymarket data is free + keyless;
// Kalshi market data is attempted keyless and skipped if unavailable.
// $0 — no Odds API credits.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setPredMarket } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';
import { impliedProb } from '../shared/odds-math.js';

const EDGE = Number(process.env.PRED_EDGE_PCT) || 0.04;       // book underprices a side by this vs exchange → flag
const MIN_VOL = Number(process.env.PRED_MIN_VOL) || 5000;     // skip illiquid exchange markets
const POLY_URL = process.env.POLYMARKET_URL || 'https://gamma-api.polymarket.com/markets?closed=false&limit=500';
const KALSHI_URL = process.env.KALSHI_MARKETS_URL || 'https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=1000';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
function teamMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  return x.split(' ').pop() === y.split(' ').pop();
}
function parseJSON(s, d) { try { return typeof s === 'string' ? JSON.parse(s) : (s || d); } catch (_) { return d; } }

// Polymarket Gamma: 2-outcome markets → { a, b, pa, pb, vol }.
async function fetchPolymarket() {
  const out = [];
  let data;
  try { const r = await fetch(POLY_URL); if (!r.ok) return out; data = await r.json(); } catch (e) { logger.warn('pred-market', `polymarket: ${e.message}`); return out; }
  const list = Array.isArray(data) ? data : (data.markets || data.data || []);
  for (const m of list) {
    const outs = parseJSON(m.outcomes, null);
    const prices = parseJSON(m.outcomePrices, null);
    if (!Array.isArray(outs) || !Array.isArray(prices) || outs.length !== 2) continue;
    const pa = Number(prices[0]), pb = Number(prices[1]);
    if (!Number.isFinite(pa) || !Number.isFinite(pb)) continue;
    const vol = Number(m.volumeNum ?? m.volume ?? 0) || 0;
    out.push({ a: outs[0], b: outs[1], pa, pb, vol, source: 'polymarket' });
  }
  return out;
}

// Kalshi: best-effort — markets whose title names two sides with a yes price.
async function fetchKalshi() {
  const out = [];
  let data;
  try { const r = await fetch(KALSHI_URL); if (!r.ok) return out; data = await r.json(); } catch (e) { logger.warn('pred-market', `kalshi: ${e.message}`); return out; }
  for (const m of (data.markets || [])) {
    const title = `${m.title || ''} ${m.subtitle || m.yes_sub_title || ''}`;
    const yes = Number(m.last_price ?? m.yes_bid); // cents 1..99
    if (!Number.isFinite(yes) || yes <= 0 || yes >= 100) continue;
    const vol = Number(m.volume ?? 0) || 0;
    out.push({ title, prob: yes / 100, vol, source: 'kalshi', ticker: m.ticker });
  }
  return out;
}

async function run() {
  if (!config.predictionMarkets) { setPredMarket(null); return { summary: 'disabled (set PREDICTION_MARKETS=true)' }; }
  const games = getGames();
  if (!games.length) { setPredMarket(null); return { summary: 'no games on the slate' }; }

  const [poly, kalshi] = await Promise.all([fetchPolymarket(), fetchKalshi()]);
  const now = new Date().toISOString();
  const edges = [];

  for (const g of games) {
    // Exchange implied prob for the home side (and away = 1-home), best liquid source.
    let exHome = null, src = null, vol = 0;
    for (const m of poly) {
      if (m.vol < MIN_VOL) continue;
      if (teamMatch(m.a, g.home) && teamMatch(m.b, g.away)) { if (m.vol > vol) { exHome = m.pa / (m.pa + m.pb); src = 'polymarket'; vol = m.vol; } }
      else if (teamMatch(m.a, g.away) && teamMatch(m.b, g.home)) { if (m.vol > vol) { exHome = m.pb / (m.pa + m.pb); src = 'polymarket'; vol = m.vol; } }
    }
    for (const m of kalshi) {
      if (m.vol < MIN_VOL) continue;
      if (teamMatch(m.title, g.home) && !teamMatch(m.title, g.away)) { if (m.vol > vol) { exHome = m.prob; src = 'kalshi'; vol = m.vol; } }
    }
    if (exHome == null) continue;

    // Book no-vig moneyline (devigged consensus).
    const ml = computeMarkets(g).ml;
    if (ml.consensusHome == null || ml.consensusAway == null) continue;
    const ih = impliedProb(ml.consensusHome), ia = impliedProb(ml.consensusAway);
    const bookHome = ih / (ih + ia);
    const exAway = 1 - exHome, bookAway = 1 - bookHome;

    // A side is value when the book prices it CHEAPER than the exchange's prob.
    const cand = [
      { side: g.home, gap: exHome - bookHome, exProb: exHome, bookProb: bookHome, price: ml.consensusHome },
      { side: g.away, gap: exAway - bookAway, exProb: exAway, bookProb: bookHome != null ? bookAway : null, price: ml.consensusAway },
    ];
    for (const c of cand) {
      if (c.gap >= EDGE) edges.push({
        sport: g.sport, game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, market: 'ml', side: c.side,
        price: c.price, exch_prob: Math.round(c.exProb * 1000) / 10, book_prob: Math.round(c.bookProb * 1000) / 10,
        edge_pct: Math.round(c.gap * 1000) / 10, source: src, vol: Math.round(vol), detected_at: now,
      });
    }
  }
  edges.sort((a, b) => b.edge_pct - a.edge_pct);
  setPredMarket({ updated: now, edges, sources: { polymarket: poly.length, kalshi: kalshi.length } });

  if (edges.length) { try { await db.insert('pred_market_edges', edges); } catch (e) { logger.warn('pred-market', e.message); } }
  return { summary: `${edges.length} exchange edges (poly ${poly.length}, kalshi ${kalshi.length})`, data: { edges: edges.length } };
}

export default { name: 'pred-market', run };
