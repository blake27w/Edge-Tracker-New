// ══════════════════════════════════════════════════════════════
// Signal Engine — the master scorer, built on the edge philosophy:
// our edge is information asymmetry and market inefficiency, NOT
// trends the books already price in. CLV (beating the close) is the
// north-star metric the CLV Tracker measures; this engine decides what
// to play and how big.
//
// SIGNAL TIERS (base 50; each tier adds points, capped at 95 — never 100)
//   Tier 1 (+20, primary edge): RLM vs heavy public, steam (spreads/ml only),
//     significant (15+ mph) DIRECTIONAL wind on totals.
//   Tier 2 (+10, supporting): handle≫bets divergence, power-vs-line gap,
//     key starter OUT, park/bullpen spot, schedule spot, steam on TOTALS.
//   Tier 3 (+3, CONFIRMATION ONLY): structural Under trend.
//
// SCORING: diminishing returns on correlated (same-id) signals — first counts
//   full, repeats decay ×0.6. Tier-1 count is DISTINCT ids (independent edges).
//
// QUALIFYING: score ≥ 70 AND ≥1 Tier-1 edge AND ≥ minPrimary (default 2)
//   independent primary signals, where a primary = a distinct Tier-1 OR a
//   Tier-2 handle>bets divergence. No single-signal plays; "sharp" = two
//   independent edges agreeing.
//
// UNDER BIAS: Over totals take a -10 penalty and need 2+ independent Tier 1.
//   Spreads / moneylines / props are exempt.
//
// TOTALS PROBATION (rules.totalsProbation): while on, totals are observational
//   + reduced-stake (out of the headline record, still graded, no alerts) until
//   a totals sub-signal proves positive CLV. Spreads/ml/props unaffected.
// ══════════════════════════════════════════════════════════════
import config, { unitFor } from '../../config/index.js';
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { getGames, getPower, signalsForGame, setPlays, getPredMarket, getBacktest } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';

// Fight sports are excluded from the team engine until they get a dedicated model.
const FIGHT_SPORTS = new Set(['UFC', 'BOXING']);

const { rules } = config;
const TIER_POINTS = { 1: 20, 2: 10, 3: 3 };
const CONF_CEILING = 95;   // nothing is ever a certainty — never let a play hit 100
const STACK_DECAY = 0.6;   // correlated (same-id) signals decay: 1st full, then ×0.6, ×0.36 …

// Plays we've already alerted on this process lifetime.
const alerted = new Set();

const isPitcher = (pos) => /\b(P|SP|RP|LHP|RHP)\b/i.test(String(pos || ''));
const sideEq = (a, b) => { const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase(); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

// Has the exchange (Polymarket/Kalshi) edge proven positive CLV? Read from the
// backtest's per-signal CLV scorecard. Until it has, the signal is recorded on
// plays but adds 0 points; once it beats the close over a real sample, it
// auto-promotes to a Tier-2 supporting signal.
function exchangeValidated() {
  const card = (getBacktest()?.signalClv || []).find((s) => s.id === 'exchange');
  return !!card && card.n >= rules.exchangeMinSample && card.beatPct > 50 && card.avgClv > 0;
}

// Assemble the tiered signals for one market+side from the intel store.
function collectSignals(game, market, side, intel, power, exchange) {
  const sigs = [];
  const add = (tier, id, label) => sigs.push({ tier, id, label });
  const isTotal = market === 'total';
  const under = side === 'Under';

  // ── Tier 1: information-asymmetry edges ──
  for (const s of intel.splits) {
    if (s.rlm && s.market === market) {
      const publicOver = String(s.side || '').toLowerCase().includes('over');
      if (!isTotal || under === publicOver) add(1, 'rlm', `RLM vs ${s.bets_pct ?? '?'}% public (${s.side})`);
    }
  }
  for (const s of intel.sharp) {
    const mk = isTotal ? 'totals' : (market === 'spread' ? 'spreads' : 'h2h');
    // Require the steam to be on THIS side (not just this market) — otherwise a
    // steam on the opposite side would wrongly credit a Tier-1 to this play.
    if (s.market !== mk || s.side !== side) continue;
    // Steam on TOTALS is a supporting (Tier-2) signal, not a primary edge: it
    // can help a totals play but can't qualify one on its own (totals need an
    // independent primary). On spreads/ml steam stays a Tier-1 edge.
    if (isTotal) add(2, 'steam', `${s.detail || 'steam move'} (totals — supporting)`);
    else add(1, 'steam', s.detail || 'steam move');
  }
  if (isTotal && under) {
    for (const w of intel.weather) {
      // total_impact === 'under' already requires a valid IN-blowing wind for MLB
      // (direction-aware) or strong wind for NFL — so this never fires on a wind
      // blowing OUT (which would be an Over indicator, i.e. a no-play).
      if (!w.dome && (w.wind_mph || 0) >= 15 && w.total_impact === 'under') {
        const dir = w.wind_effect === 'in' ? ' blowing in' : '';
        add(1, 'wind', `Wind ${Math.round(w.wind_mph)}mph${dir} → Under`);
      }
    }
  }

  // ── Tier 2: supporting ──
  for (const s of intel.splits) {
    if (s.divergence != null && s.divergence >= 8 && s.market === market) {
      const sharpUnder = String(s.side || '').toLowerCase().includes('under');
      if (!isTotal || under === sharpUnder) add(2, 'divergence', `Handle ${s.handle_pct}% > bets ${s.bets_pct}% (sharp side)`);
    }
  }
  if (isTotal) {
    // Key OUT players support an Under, but don't qualify a play alone (info, not
    // a confirmed market edge) — one supporting signal per game regardless of count.
    if (under) {
      const outs = intel.injuries.filter((i) => i.status === 'OUT' && i.impact === 'high' && !isPitcher(i.pos));
      if (outs.length) add(2, 'injury_out', `${outs.length} key OUT (${outs[0].player}${outs.length > 1 ? ' +' + (outs.length - 1) : ''})`);
    }
    if (under) for (const sp of intel.schedule) add(2, 'schedule', sp.detail);
    for (const m of intel.mlbContext) {
      if (m.total_lean === 'under' && under) add(2, 'bullpen', 'Bullpen/park lean Under');
      if (m.total_lean === 'over' && !under) add(2, 'bullpen_over', 'Bullpen lean Over');
    }
    for (const w of intel.weather) {
      const wind = w.wind_mph || 0;
      if (under && !w.dome && wind >= 10 && wind < 15 && w.total_impact === 'under') add(2, 'weather_mild', `Wind ${Math.round(wind)}mph`);
    }
    // Home-plate umpire run tendency (self-learned) — supporting only.
    for (const u of intel.umpire || []) {
      if (u.lean === 'under' && under) add(2, 'umpire', u.note || 'Under-leaning plate ump');
      if (u.lean === 'over' && !under) add(2, 'umpire_over', u.note || 'Over-leaning plate ump');
    }
    // Late starting-pitcher change (speed edge) — supporting only.
    for (const lp of intel.lineup || []) {
      if (lp.lean === 'under' && under) add(2, 'pitcher_change', lp.note || 'SP upgrade → Under');
      if (lp.lean === 'over' && !under) add(2, 'pitcher_change_over', lp.note || 'SP downgrade → Over');
    }
    // Gassed bullpen (real relief workload) → Over — supporting only.
    for (const bf of intel.bullpenFatigue || []) {
      if (bf.lean === 'over' && !under) add(2, 'bullpen_fatigue', bf.note || 'Gassed bullpen → Over');
    }
  } else if (power) {
    // Power-rating vs market-line gap (spread/ml). Supporting only — never a
    // standalone qualifier (consistent with "power is priced in already").
    const h = power[game.home]?.rating, a = power[game.away]?.rating;
    if (h != null && a != null && Math.abs(h - a) >= 6) {
      const fav = h > a ? game.home : game.away;
      if (String(side).includes(fav)) add(2, 'power', `Power edge ${fav} (+${Math.round(Math.abs(h - a))})`);
    }
  }

  // ── Tier 3: confirmation only ──
  if (isTotal && under) add(3, 'under_bias', 'Structural Under edge (public over-bets Overs)');

  // Exchange (Polymarket/Kalshi) edge — ML only, supporting. Recorded always so
  // its CLV accrues; adds points (Tier 2) ONLY once it's proven to beat the
  // close (tier 0 = recorded, 0 points, until validated).
  if (market === 'ml' && exchange && exchange.edge) {
    add(exchange.validated ? 2 : 0, 'exchange', `Exchange underprices ${exchange.edge.edge_pct}% (${exchange.edge.source})`);
  }

  return sigs;
}

function score(sigs, side, market) {
  // Base 50. Diminishing returns: the FIRST signal of each id counts at full
  // tier weight; additional CORRELATED observations of the same id decay
  // (×0.6, ×0.36 …) — e.g. several books moving the same line are one edge,
  // not many. DIFFERENT ids are independent mechanisms (weather vs sharp) and
  // each start fresh at full weight. Confidence is capped below 100 so the
  // distribution keeps the spread the CLV analysis needs to learn from.
  let raw = 50;
  const seen = {};
  for (const s of sigs) {
    const pts = TIER_POINTS[s.tier] || 0;
    const n = seen[s.id] || 0;
    raw += pts * Math.pow(STACK_DECAY, n);
    seen[s.id] = n + 1;
  }
  raw = Math.min(CONF_CEILING, Math.round(raw));
  // Count DISTINCT Tier-1 ids (independent edges), not raw occurrences — so two
  // correlated steam reads can't masquerade as two independent Tier-1 signals.
  const t1 = new Set(sigs.filter((s) => s.tier === 1).map((s) => s.id)).size;
  const hasDivergence = sigs.some((s) => s.id === 'divergence');

  let finalScore = raw;
  let overPenalty = false;
  if (market === 'total' && side === 'Over') { finalScore -= rules.overTotalPenalty; overPenalty = true; }
  finalScore = Math.max(0, Math.min(CONF_CEILING, finalScore));
  return { raw, score: finalScore, t1, hasDivergence, overPenalty };
}

function qualifies(side, market, sc, price) {
  if (sc.score < rules.confidenceFloor) return false;
  // No single-signal plays. Require at least one true Tier-1 edge AND a total of
  // `minPrimary` independent primary signals, where a primary = a distinct Tier-1
  // OR a Tier-2 handle>bets divergence. Default 2 → "sharp" means two independent
  // edges agreeing (e.g. RLM + steam, or steam + sharp-money divergence), not one.
  const primary = sc.t1 + (sc.hasDivergence ? 1 : 0);
  if (sc.t1 < 1 || primary < rules.minPrimary) return false;
  // Over totals must clear an even higher bar: 2+ independent Tier 1 signals.
  if (market === 'total' && side === 'Over' && sc.t1 < 2) return false;
  // Heavy juice (worse than maxOppJuice, e.g. -140): only surface with EXTREME
  // confidence — laying a brutal price is rarely worth it otherwise.
  if (price != null && price < rules.maxOppJuice && sc.score < rules.extremeConfidence) return false;
  return true;
}

async function run() {
  const games = getGames();
  if (!games.length) return { summary: 'no games to score' };

  const now = new Date().toISOString();
  const rows = [];
  const plays = [];
  const newAlerts = [];

  // Exchange (Polymarket/Kalshi) edges + whether they've earned scoring weight.
  const exEdges = getPredMarket()?.edges || [];
  const exValidated = exchangeValidated();

  for (const g of games) {
    // Fight sports (UFC, Boxing) have no play model yet — they're handled
    // separately and must never run through the team engine / Under bias.
    if (FIGHT_SPORTS.has(g.sport)) continue;
    const intel = signalsForGame(g.game_id);
    const meta = config.SPORTS[g.sport] || {};
    const power = getPower(g.sport);
    const candidates = [];

    // Totals: Under (preferred) and Over.
    if (meta.hasTotals && g.consensusTotal != null) {
      for (const side of ['Under', 'Over']) {
        candidates.push({ market: 'total', side, line: g.consensusTotal, sigs: collectSignals(g, 'total', side, intel, power) });
      }
    }
    // Spread / ML: side from sharp/divergence, else power as a soft tiebreak.
    const sideSpread = pickTeamSide(intel, 'spread') || pickPowerSide(power, g);
    if (sideSpread) {
      // Capture the consensus spread number for the chosen side so it can be graded.
      const consH = computeMarkets(g).spread.consensusHome;
      const spreadLine = consH == null ? null : (sideSpread === g.home ? consH : -consH);
      candidates.push({ market: 'spread', side: sideSpread, line: spreadLine, sigs: collectSignals(g, 'spread', sideSpread, intel, power) });
    }
    const sideMl = pickTeamSide(intel, 'ml') || pickPowerSide(power, g);
    if (sideMl) {
      // Carry the consensus ML price so the juice gate can reject heavy chalk
      // (worse than maxOppJuice) unless the play has extreme confidence.
      const ml = computeMarkets(g).ml;
      const mlPrice = sideMl === g.home ? ml.consensusHome : ml.consensusAway;
      const exEdge = exEdges.find((e) => e.game_id === g.game_id && sideEq(e.side, sideMl)) || null;
      candidates.push({ market: 'ml', side: sideMl, line: null, price: mlPrice, sigs: collectSignals(g, 'ml', sideMl, intel, power, { edge: exEdge, validated: exValidated }) });
    }

    for (const c of candidates) {
      const sc = score(c.sigs, c.side, c.market);
      const qualified = qualifies(c.side, c.market, sc, c.price);
      const unit = qualified ? unitFor(sc.score) : unitFor(0);
      // Totals probation: keep grading them, but mark observational (out of the
      // headline record) and cut the stake until a totals sub-signal proves CLV.
      const probation = c.market === 'total' && rules.totalsProbation;
      const stakeMult = probation ? (rules.totalsProbationStake || 0.5) : 1;
      // Live = the play was issued AFTER the game started (in-game), vs pre-game.
      const live = !!(g.commence_time && Date.parse(g.commence_time) <= Date.parse(now));
      const row = {
        sport: g.sport, game_id: g.game_id, matchup: `${g.away} @ ${g.home}`,
        commence_time: g.commence_time,
        market: c.market, side: c.side, line: c.line, price: c.price ?? null,
        raw_score: sc.raw, score: sc.score, confidence: sc.score,
        tier: probation ? `${unit.label} (prob)` : unit.label,
        unit_mult: Math.round(unit.mult * stakeMult * 100) / 100,
        unit_dollars: Math.round(unit.dollars * stakeMult * 100) / 100,
        t1_count: sc.t1, signals: c.sigs, qualified, over_penalty_applied: sc.overPenalty,
        observational: probation, live, status: 'pending', scored_at: now,
      };
      rows.push(row);
      if (qualified) {
        plays.push(row);
        const key = `${g.game_id}|${c.market}|${c.side}`;
        if (!alerted.has(key)) { alerted.add(key); newAlerts.push(row); }
      }
    }
  }

  // Persist ONLY newly-qualified plays (newAlerts), not every cycle's full set —
  // otherwise monitor_scores accumulates the same play every 2 minutes. The
  // in-memory `alerted` set resets on restart, so ALSO dedupe against pending
  // rows already in the DB (prevents the duplicate-play inflation that broke the
  // CLV-record-vs-graded-play count).
  if (newAlerts.length) {
    let pendingKeys = new Set();
    try {
      const ex = await db.select('monitor_scores', 'game_id,market,side', { match: { status: 'pending' }, limit: 3000 });
      pendingKeys = new Set(ex.map((r) => `${r.game_id}|${r.market}|${r.side}`));
    } catch (e) { /* if the read fails, fall back to the in-memory dedup only */ }
    // commence_time is for the dashboard (via /plays); not a monitor_scores column.
    const dbRows = newAlerts
      .filter((p) => !pendingKeys.has(`${p.game_id}|${p.market}|${p.side}`))
      .map(({ commence_time, ...r }) => r);
    if (dbRows.length) { try { await db.insert('monitor_scores', dbRows); } catch (e) { logger.warn('signal', e.message); } }
  }
  setPlays(plays);

  for (const p of newAlerts) {
    if (p.observational) continue; // probation totals are graded but not real-stake — don't push alerts
    // Actionable one-liner: LIVE flag first (most time-sensitive), the side +
    // line + price to bet, then the matchup and conviction.
    const lv = p.live ? '🔴 LIVE — ' : '';
    const pr = p.price != null ? ` ${p.price > 0 ? '+' + p.price : p.price}` : '';
    const body = `${lv}🟢 BET ${p.sport}: ${p.side} ${p.line ?? ''}${pr} — ${p.matchup} · ${Math.round(p.score)} conf, ${p.t1_count} T1, ${p.tier}/$${p.unit_dollars}`;
    try {
      const r = await notifyAll(`Edge Tracker play: ${p.sport} ${p.side}`, body);
      await db.insert('alert_log', { type: r.email && !r.sms ? 'email' : 'sms', channel: 'signal', recipients: r.total, body, sport: p.sport, game_id: p.game_id, status: 'sent' });
    } catch (e) { logger.warn('signal', `alert: ${e.message}`); }
  }

  return {
    summary: `${plays.length} qualifying plays (${newAlerts.length} new) from ${games.length} games`,
    gamesMonitored: games.length,
    data: { qualifying: plays.length, newAlerts: newAlerts.length, scored: rows.length },
  };
}

// Side for spread/ml from a Tier-1 (steam) or Tier-2 (divergence) signal.
function pickTeamSide(intel, market) {
  for (const s of intel.sharp) {
    if (s.market === (market === 'spread' ? 'spreads' : 'h2h')) return s.side;
  }
  for (const s of intel.splits) {
    if (s.market === market && s.divergence != null && s.divergence >= 8) return s.side;
  }
  return null;
}

// Soft fallback only: the side power ratings favor (won't qualify on its own).
function pickPowerSide(power, g) {
  const h = power[g.home]?.rating, a = power[g.away]?.rating;
  if (h == null || a == null || Math.abs(h - a) < 6) return null;
  return h > a ? `${g.home}` : `${g.away}`;
}

export default { name: 'signal', run };
