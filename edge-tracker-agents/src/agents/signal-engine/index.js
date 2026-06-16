// ══════════════════════════════════════════════════════════════
// Signal Engine — the master scorer. For every game it assembles the
// tiered signals produced by the other agents, scores each candidate
// play, applies the betting-philosophy rules, sizes units, and emits
// qualifying plays (score 70+ with 1+ Tier-1 signal).
//
// BETTING PHILOSOPHY (critical):
//   • DEFAULT TO UNDERS on game totals.
//   • Over totals take a -10 confidence penalty (effective bar 80+),
//     and require 2+ independent Tier-1 signals to ever qualify.
//   • Spreads / moneylines / player props are exempt from the bias.
// ══════════════════════════════════════════════════════════════
import config, { unitFor } from '../../config/index.js';
import db from '../../db/index.js';
import { logger, sendSms } from '../../utils/index.js';
import { getGames, getPower, signalsForGame, setPlays } from '../../store/index.js';

const { rules } = config;
const TIER_POINTS = { 1: 18, 2: 9, 3: 5 };

// Plays we've already alerted on this process lifetime.
const alerted = new Set();

// Build the tiered signal list for a given market+side from intel.
function collectSignals(game, market, side, intel) {
  const sigs = [];
  const add = (tier, id, label) => sigs.push({ tier, id, label });
  const isTotal = market === 'total';
  const under = side === 'Under';

  // ── Tier 1: RLM vs heavy public, strong steam ──
  for (const s of intel.splits) {
    if (s.rlm && s.market === market) {
      // RLM benefits the side opposite heavy public.
      const publicSide = String(s.side || '').toLowerCase();
      const rlmFavorsUnder = publicSide.includes('over');
      if (isTotal ? (under === rlmFavorsUnder) : true) {
        add(1, 'rlm', `RLM vs ${s.bets_pct}% public (${s.side})`);
      }
    }
    // Handle > bets divergence = sharp money on the handle side.
    if (s.divergence != null && s.divergence >= 8 && s.market === market) {
      const sharpUnder = String(s.side || '').toLowerCase().includes('under');
      if (isTotal ? (under === sharpUnder) : true) {
        add(2, 'divergence', `Handle ${s.handle_pct}% > bets ${s.bets_pct}% (sharp side)`);
      }
    }
  }
  for (const s of intel.sharp) {
    if (s.market === (isTotal ? 'totals' : market) && (!isTotal || s.side === side)) {
      add(s.strength >= 60 ? 1 : 2, 'steam', s.detail);
    }
  }

  if (isTotal) {
    // ── Weather (T2) ──
    for (const w of intel.weather) {
      if (w.total_impact === 'under' && under) add(2, 'weather', `Wind/cold → Under (${w.wind_mph ?? '?'}mph)`);
      if (w.total_impact === 'over' && !under) add(3, 'weather_over', 'Weather favors Over');
    }
    // ── MLB context (T2/T3) ──
    for (const m of intel.mlbContext) {
      if (m.total_lean === 'under' && under) add(2, 'ump_bullpen', `Ump/bullpen lean Under (${m.ump_name || 'ump'})`);
      if (m.total_lean === 'over' && !under) add(3, 'ump_bullpen_over', 'Ump/bullpen lean Over');
    }
    // ── Schedule fatigue suppresses scoring → Under (T2/T3) ──
    if (under) {
      for (const sp of intel.schedule) add(sp.tier || 3, 'schedule', sp.detail);
    }
    // ── Structural divisional/wind Unders edge baked in (T3) ──
    if (under) add(3, 'under_bias', 'Structural Under edge (public over-bets Overs)');
  }
  return sigs;
}

function score(sigs, side, market) {
  let raw = 50;
  for (const s of sigs) raw += TIER_POINTS[s.tier] || 0;
  raw = Math.min(100, raw);
  const t1 = sigs.filter((s) => s.tier === 1).length;

  let finalScore = raw;
  let overPenalty = false;
  if (market === 'total' && side === 'Over') {
    finalScore -= rules.overTotalPenalty; // -10 to Over totals
    overPenalty = true;
  }
  finalScore = Math.max(0, Math.min(100, finalScore));
  return { raw, score: finalScore, t1, overPenalty };
}

function qualifies(side, market, sc) {
  if (sc.score < rules.confidenceFloor) return false;
  if (sc.t1 < 1) return false;
  // Over totals must clear a higher bar: 2+ T1 signals.
  if (market === 'total' && side === 'Over' && sc.t1 < 2) return false;
  return true;
}

async function run() {
  const games = getGames();
  if (!games.length) return { summary: 'no games to score' };

  const now = new Date().toISOString();
  const rows = [];
  const plays = [];
  const newAlerts = [];

  for (const g of games) {
    const intel = signalsForGame(g.game_id);
    const meta = config.SPORTS[g.sport] || {};
    const candidates = [];

    // ── Totals: evaluate Under (preferred) and Over ──
    if (meta.hasTotals && g.consensusTotal != null) {
      for (const side of ['Under', 'Over']) {
        const sigs = collectSignals(g, 'total', side, intel);
        candidates.push({ market: 'total', side, line: g.consensusTotal, sigs });
      }
    }

    // ── Spread / ML: side comes from sharp/handle; power as a soft tiebreak ──
    const power = getPower(g.sport);
    const sideSpread = pickTeamSide(intel, 'spread') || pickPowerSide(power, g);
    if (sideSpread) candidates.push({ market: 'spread', side: sideSpread, line: null, sigs: collectSignals(g, 'spread', sideSpread, intel) });
    const sideMl = pickTeamSide(intel, 'ml');
    if (sideMl) candidates.push({ market: 'ml', side: sideMl, line: null, sigs: collectSignals(g, 'ml', sideMl, intel) });

    for (const c of candidates) {
      const sc = score(c.sigs, c.side, c.market);
      const qualified = qualifies(c.side, c.market, sc);
      const unit = qualified ? unitFor(sc.score) : unitFor(0);
      const row = {
        sport: g.sport, game_id: g.game_id, matchup: `${g.away} @ ${g.home}`,
        market: c.market, side: c.side, line: c.line,
        raw_score: sc.raw, score: sc.score, confidence: sc.score,
        tier: unit.label, unit_mult: unit.mult, unit_dollars: unit.dollars,
        t1_count: sc.t1, signals: c.sigs, qualified, over_penalty_applied: sc.overPenalty,
        status: 'pending', scored_at: now,
      };
      rows.push(row);
      if (qualified) {
        plays.push(row);
        const key = `${g.game_id}|${c.market}|${c.side}`;
        if (!alerted.has(key)) { alerted.add(key); newAlerts.push(row); }
      }
    }
  }

  // Persist scores; only the qualifying ones really matter for the dashboard.
  const qualifyingRows = rows.filter((r) => r.qualified);
  if (qualifyingRows.length) {
    try { await db.insert('monitor_scores', qualifyingRows); } catch (e) { logger.warn('signal', e.message); }
  }
  setPlays(plays);

  // Alert on brand-new qualifiers.
  for (const p of newAlerts) {
    const body = `🟢 ${p.sport} ${p.matchup} — ${p.side} ${p.line ?? ''} (${Math.round(p.score)} conf, ${p.tier}/$${p.unit_dollars}, ${p.t1_count} T1)`;
    try {
      const n = await sendSms(body);
      await db.insert('alert_log', {
        type: 'sms', channel: 'signal', recipients: n, body,
        sport: p.sport, game_id: p.game_id, status: 'sent',
      });
    } catch (e) { logger.warn('signal', `alert: ${e.message}`); }
  }

  return {
    summary: `${plays.length} qualifying plays (${newAlerts.length} new) from ${games.length} games`,
    gamesMonitored: games.length,
    data: { qualifying: plays.length, newAlerts: newAlerts.length, scored: rows.length },
  };
}

// Pick the sharp/handle-favored team side for spread/ml from intel.
function pickTeamSide(intel, market) {
  for (const s of intel.sharp) {
    if (s.market === (market === 'spread' ? 'spreads' : 'h2h')) return s.side;
  }
  for (const s of intel.splits) {
    if (s.market === market && s.divergence != null && s.divergence >= 8) return s.side;
  }
  return null;
}

// Soft fallback: side the power ratings favor (T3-level confidence only).
function pickPowerSide(power, g) {
  const h = power[g.home]?.rating, a = power[g.away]?.rating;
  if (h == null || a == null) return null;
  if (Math.abs(h - a) < 6) return null; // not a meaningful edge
  return h > a ? `${g.home}` : `${g.away}`;
}

export default { name: 'signal', run };
