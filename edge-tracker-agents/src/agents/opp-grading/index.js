// ══════════════════════════════════════════════════════════════
// Opportunity Grading — grades the OPPORTUNITY flags (not the
// recommended plays) after games end, so we learn which scanners
// actually find winners. Takes recent +EV and line-intelligence
// (stale / divergence / key) flags, dedups to one per
// game·market·side, settles each against ESPN finals, and stores the
// result. Aggregated into the Record tab's "what works" rubric.
// Arbs (guaranteed) and middles are not win/loss-graded. $0.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { ESPN_PATH, profitPerUnit, ymd, norm, fetchFinals, gradePlay, pickFinal } from '../grading/index.js';

const LOOKBACK_H = Number(process.env.OPP_GRADE_LOOKBACK_H) || 30;
// Run/puck-line sports: the spread is fixed ±1.5, so line-based stale "spread"
// flags are artifacts — don't grade them (they inflated the Book Edges record).
const FIXED_RUNLINE = new Set(['MLB', 'NHL']);

// +EV row → gradeable play. Skip spreads (line/side sign ambiguity) and tennis.
function fromEv(r) {
  let market = r.market, line = null;
  if (market === 'ml') { /* no line */ }
  else if (/^total/.test(market)) { line = parseFloat(String(market).split(' ')[1]); market = 'total'; }
  else return null;
  if (market === 'total' && !Number.isFinite(line)) return null;
  const detail = `+${r.ev_pct}% vs fair${r.book ? ` @ ${r.book}` : ''}${r.fair_price != null ? ` (fair ${r.fair_price > 0 ? '+' + r.fair_price : r.fair_price})` : ''}`;
  return { type: 'ev', sport: r.sport, game_id: r.game_id, matchup: r.matchup, market, side: r.side, line, price: r.price, detail };
}

// line_signals row (stale | divergence | key) → gradeable play.
function fromSignal(r) {
  let market = r.market, line = r.line != null ? Number(r.line) : null;
  if (market === 'h2h') market = 'ml';
  else if (market === 'totals') market = 'total';
  else if (market === 'spreads') market = 'spread';
  if (!['ml', 'total', 'spread'].includes(market)) return null;
  if (market === 'spread' && FIXED_RUNLINE.has(r.sport)) return null; // fixed run/puck line — artifact, don't grade
  if ((market === 'total' || market === 'spread') && line == null) return null; // divergence totals/spreads lack a line
  return { type: r.type, sport: r.sport, game_id: r.game_id, matchup: r.matchup, market, side: r.side, line, price: r.price, detail: r.detail || null };
}

async function run() {
  if (!db.isConnected()) return { summary: 'skipped — no DB' };
  const since = new Date(Date.now() - LOOKBACK_H * 3600_000).toISOString();

  let ev = [], ls = [];
  try { ev = await db.select('ev_opportunities', '*', { gte: { fetched_at: since }, limit: 2000 }); } catch (_) { /* table optional */ }
  try { ls = await db.select('line_signals', '*', { gte: { fetched_at: since }, limit: 3000 }); } catch (_) { /* table optional */ }

  const done = new Set();
  try { const g = await db.select('opp_results', 'type,game_id,market,side', { limit: 8000 }); for (const r of g) done.add(`${r.type}|${r.game_id}|${r.market}|${r.side}`); } catch (_) { /* none yet */ }

  const flags = new Map();
  const add = (n, when) => {
    if (!n || !ESPN_PATH[n.sport]) return;
    const k = `${n.type}|${n.game_id}|${n.market}|${n.side}`;
    if (done.has(k) || flags.has(k)) return;
    flags.set(k, { ...n, when });
  };
  for (const r of ev) add(fromEv(r), r.commence_time || r.fetched_at);
  for (const r of ls) add(fromSignal(r), r.fetched_at);
  if (!flags.size) return { summary: 'no new opportunities to grade' };

  const pairs = new Map();
  for (const f of flags.values()) {
    const d = f.when ? new Date(f.when) : new Date();
    for (const off of [0, -1, 1]) { const dd = new Date(d.getTime() + off * 86400_000); pairs.set(`${f.sport}|${ymd(dd)}`, { sport: f.sport, date: ymd(dd) }); }
  }
  // Each final carries the board date it came from. The finals for a sport are
  // flattened across the whole window, and a matchup repeats inside it as a
  // matter of routine — an MLB series is the same two nicknames on consecutive
  // days, NBA/NHL home-and-homes do it too — so a nickname-only `.find()` here
  // settled a flag against whichever game happened to be fetched first. Same
  // defect as grading's (D109.1), same fix: pickFinal chooses the final closest
  // to the flag's own game date (D110).
  const finalsBySport = {};
  for (const { sport, date } of pairs.values()) {
    try { const fin = await fetchFinals(sport, date); (finalsBySport[sport] ||= []).push(...fin.map((x) => ({ ...x, boardDate: date }))); }
    catch (e) { logger.warn('opp-grading', e.message); }
  }

  const now = new Date().toISOString();
  const out = [];
  let ambiguousFinal = 0;
  for (const f of flags.values()) {
    const parts = String(f.matchup || '').split(' @ ');
    // norm(), not toLowerCase(): shared/espn.js folds its nicknames, so an
    // accented nickname could never meet one here (D105.4, D109.3).
    const awayName = norm(parts[0] || ''), homeName = norm(parts[1] || '');
    // `when` is commence_time where we have it, which is the flag's real game
    // date — better than grading's scored_at. pickFinal still prefers the odds
    // slate's own commence_time via game_id when the game is still on it.
    const pick = pickFinal(finalsBySport[f.sport] || [], { game_id: f.game_id, scored_at: f.when || now }, awayName, homeName);
    // Two finals equally close, or a final whose own kickoff doesn't match the
    // flag's game (wrongSlot, D111.1 — reachable here too via the slate's own
    // commence_time, with no `schedule` arg needed): a guess is right half the
    // time, which is worse than useless in a published record. Stay ungraded,
    // and be counted, same treatment as ambiguous.
    if (pick.ambiguous || pick.wrongSlot) { ambiguousFinal++; continue; }
    const fin = pick.f;
    if (!fin) continue;
    const result = gradePlay(f, fin);
    if (!result) continue;
    const stake = config.rules.unitDollars;
    const pnl = result === 'win' ? Math.round(stake * profitPerUnit(f.price || -110) * 100) / 100 : result === 'loss' ? -stake : 0;
    out.push({ type: f.type, sport: f.sport, game_id: f.game_id, matchup: f.matchup, market: f.market, side: f.side, line: f.line, price: f.price ?? null, detail: f.detail || null, status: result, pnl, graded_at: now });
  }
  if (out.length) { try { await db.insert('opp_results', out); } catch (e) { logger.warn('opp-grading', e.message); } }

  return {
    summary: `graded ${out.length} opportunity flag${out.length === 1 ? '' : 's'}`
      + (ambiguousFinal ? `; ${ambiguousFinal} matched two finals equally closely or picked the wrong slot and were left ungraded rather than guessed` : ''),
    data: { graded: out.length, ambiguousFinal },
  };
}

export default { name: 'opp-grading', run };
