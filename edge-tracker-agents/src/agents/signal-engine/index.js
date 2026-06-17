// ══════════════════════════════════════════════════════════════
// Signal Engine — the master scorer, built on the edge philosophy:
// our edge is information asymmetry and market inefficiency, NOT
// trends the books already price in. CLV (beating the close) is the
// north-star metric the CLV Tracker measures; this engine decides what
// to play and how big.
//
// SIGNAL TIERS
//   Tier 1 (+20, primary edge): reverse line movement vs heavy public,
//     steam moves, sharp-book leads, a key starter ruled OUT before the
//     line adjusts, significant (15+ mph) unpriced wind.
//   Tier 2 (+10, supporting): handle≫bets divergence, power-vs-line gap,
//     park/bullpen spot, schedule spot.
//   Tier 3 (+3, CONFIRMATION ONLY): raw Under/Over trends, season stats,
//     H2H. Never a reason to play on its own.
//
// QUALIFYING: score ≥ 70 AND (≥1 Tier 1 OR a Tier 2 sharp/public
//   divergence). A play built only on Tier 3 never qualifies.
//
// UNDER BIAS: Over totals take a -10 penalty and need 2+ Tier 1 signals.
//   Spreads / moneylines / props are exempt.
// ══════════════════════════════════════════════════════════════
import config, { unitFor } from '../../config/index.js';
import db from '../../db/index.js';
import { logger, sendSms } from '../../utils/index.js';
import { getGames, getPower, signalsForGame, setPlays } from '../../store/index.js';

const { rules } = config;
const TIER_POINTS = { 1: 20, 2: 10, 3: 3 };

// Plays we've already alerted on this process lifetime.
const alerted = new Set();

const isPitcher = (pos) => /\b(P|SP|RP|LHP|RHP)\b/i.test(String(pos || ''));

// Assemble the tiered signals for one market+side from the intel store.
function collectSignals(game, market, side, intel, power) {
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
    if (s.market === mk && (!isTotal || s.side === side)) add(1, 'steam', s.detail || 'steam move');
  }
  if (isTotal && under) {
    for (const w of intel.weather) {
      if (!w.dome && (w.wind_mph || 0) >= 15 && w.total_impact === 'under') add(1, 'wind', `Wind ${Math.round(w.wind_mph)}mph → Under`);
    }
    // A key position player ruled OUT suppresses scoring (→ Under). Pitcher
    // scratches are ambiguous on direction, so we don't auto-signal them here.
    for (const inj of intel.injuries) {
      if (inj.status === 'OUT' && inj.impact === 'high' && !isPitcher(inj.pos)) add(1, 'injury_out', `${inj.player} OUT (${inj.team})`);
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
    if (under) for (const sp of intel.schedule) add(2, 'schedule', sp.detail);
    for (const m of intel.mlbContext) {
      if (m.total_lean === 'under' && under) add(2, 'bullpen', 'Bullpen/park lean Under');
      if (m.total_lean === 'over' && !under) add(2, 'bullpen_over', 'Bullpen lean Over');
    }
    for (const w of intel.weather) {
      const wind = w.wind_mph || 0;
      if (under && !w.dome && wind >= 10 && wind < 15 && w.total_impact === 'under') add(2, 'weather_mild', `Wind ${Math.round(wind)}mph`);
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

  return sigs;
}

function score(sigs, side, market) {
  let raw = 50;
  for (const s of sigs) raw += TIER_POINTS[s.tier] || 0;
  raw = Math.min(100, raw);
  const t1 = sigs.filter((s) => s.tier === 1).length;
  const hasDivergence = sigs.some((s) => s.id === 'divergence');

  let finalScore = raw;
  let overPenalty = false;
  if (market === 'total' && side === 'Over') { finalScore -= rules.overTotalPenalty; overPenalty = true; }
  finalScore = Math.max(0, Math.min(100, finalScore));
  return { raw, score: finalScore, t1, hasDivergence, overPenalty };
}

function qualifies(side, market, sc) {
  if (sc.score < rules.confidenceFloor) return false;
  // Primary edge required: a Tier 1, OR a Tier 2 sharp/public divergence.
  // Never qualifies on Tier 3 (confirmation) signals alone.
  if (!(sc.t1 >= 1 || sc.hasDivergence)) return false;
  // Over totals must clear a higher bar: 2+ independent Tier 1 signals.
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
    if (sideSpread) candidates.push({ market: 'spread', side: sideSpread, line: null, sigs: collectSignals(g, 'spread', sideSpread, intel, power) });
    const sideMl = pickTeamSide(intel, 'ml') || pickPowerSide(power, g);
    if (sideMl) candidates.push({ market: 'ml', side: sideMl, line: null, sigs: collectSignals(g, 'ml', sideMl, intel, power) });

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

  const qualifyingRows = rows.filter((r) => r.qualified);
  if (qualifyingRows.length) {
    try { await db.insert('monitor_scores', qualifyingRows); } catch (e) { logger.warn('signal', e.message); }
  }
  setPlays(plays);

  for (const p of newAlerts) {
    const body = `🟢 ${p.sport} ${p.matchup} — ${p.side} ${p.line ?? ''} (${Math.round(p.score)} conf, ${p.tier}/$${p.unit_dollars}, ${p.t1_count} T1)`;
    try {
      const n = await sendSms(body);
      await db.insert('alert_log', { type: 'sms', channel: 'signal', recipients: n, body, sport: p.sport, game_id: p.game_id, status: 'sent' });
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
