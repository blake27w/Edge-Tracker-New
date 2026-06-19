// ══════════════════════════════════════════════════════════════
// Grading Agent — checks final scores for completed games via ESPN's
// free public scoreboard API (no key), matches them to pending
// monitor_scores plays, sets win/loss/push, computes P&L, and writes
// results back for a verified track record. Replaces the old Claude
// web-search version: $0 per call and exact box scores.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';

// monitor_scores sport → ESPN scoreboard path.
const ESPN_PATH = {
  MLB: 'baseball/mlb', NBA: 'basketball/nba', NHL: 'hockey/nhl', NFL: 'football/nfl',
  NCAAF: 'football/college-football', NCAAB: 'basketball/mens-college-basketball', WNBA: 'basketball/wnba',
};

function profitPerUnit(odds = -110) {
  return odds < 0 ? 100 / Math.abs(odds) : odds / 100;
}
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
function norm(s) { return String(s || '').toLowerCase(); }

// Fetch completed finals for a sport+date from ESPN. Returns array of
// { homeNick, awayNick, home_score, away_score, total }.
async function fetchFinals(sport, dateStr) {
  const path = ESPN_PATH[sport];
  if (!path) return [];
  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${dateStr}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status} ${sport}`);
  const data = await res.json();
  const out = [];
  for (const ev of data.events || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const completed = comp.status?.type?.completed || ev.status?.type?.completed;
    if (!completed) continue;
    const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
    const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    const hs = Number(home.score), as = Number(away.score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    out.push({
      homeNick: norm(home.team?.name || home.team?.shortDisplayName),
      awayNick: norm(away.team?.name || away.team?.shortDisplayName),
      home_score: hs, away_score: as, total: hs + as,
    });
  }
  return out;
}

function gradePlay(p, f) {
  if (p.market === 'total' && p.line != null) {
    if (f.total === p.line) return 'push';
    if (p.side === 'Under') return f.total < p.line ? 'win' : 'loss';
    if (p.side === 'Over') return f.total > p.line ? 'win' : 'loss';
  }
  if (p.market === 'ml') {
    const homeWon = f.home_score > f.away_score;
    const parts = String(p.matchup || '').split(' @ ');
    const homeName = norm(parts[1]);
    const betHome = homeName.includes(f.homeNick) && norm(p.side).includes(f.homeNick);
    return (homeWon === betHome) ? 'win' : 'loss';
  }
  return null; // spreads need the stored number; left pending
}

// Collapse duplicate qualifying plays (same game/market/side) left over from
// restarts — keep a graded row if one exists, else the earliest. Returns count removed.
async function dedupe() {
  let rows = [];
  try {
    rows = await db.select('monitor_scores', 'id,game_id,market,side,scored_at,status', {
      match: { qualified: true }, order: { column: 'scored_at', ascending: true }, limit: 5000,
    });
  } catch (_) { return 0; }
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.game_id}|${r.market}|${r.side}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const drop = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keeper = list.find((r) => r.status && r.status !== 'pending') || list[0];
    for (const r of list) if (r.id !== keeper.id) drop.push(r.id);
  }
  let removed = 0;
  for (let i = 0; i < drop.length; i += 100) {
    try { await db.del('monitor_scores', { in: { id: drop.slice(i, i + 100) } }); removed += Math.min(100, drop.length - i); }
    catch (e) { logger.warn('grading', `dedupe: ${e.message}`); break; }
  }
  if (removed) logger.info('grading', `deduped ${removed} duplicate plays`);
  return removed;
}

async function run() {
  if (!db.isConnected()) return { summary: 'skipped — no DB' };

  await dedupe();

  const cutoff = new Date(Date.now() - 3.5 * 3600_000).toISOString();
  let pending = [];
  try {
    pending = await db.select('monitor_scores', '*', {
      match: { status: 'pending', qualified: true },
      lte: { scored_at: cutoff }, order: { column: 'scored_at', ascending: true }, limit: 80,
    });
  } catch (e) { return { summary: `select failed: ${e.message}` }; }
  pending = pending.filter((p) => ESPN_PATH[p.sport]);

  // Research picks awaiting grading (same finals, separate track record).
  let rpending = [];
  try {
    rpending = await db.select('research_notes', '*', { match: { type: 'pick', status: 'pending' }, lte: { created_at: cutoff }, limit: 80 });
  } catch (_) { /* table optional */ }
  rpending = rpending.filter((p) => ESPN_PATH[p.sport]);

  if (!pending.length && !rpending.length) return { summary: 'no completed plays to grade' };

  // Collect the (sport, date) pairs we need — game day plus the day before,
  // since a late-evening US game lands on the prior UTC date.
  const pairs = new Map();
  for (const p of [...pending, ...rpending]) {
    const d = new Date(p.scored_at || p.created_at);
    for (const off of [0, -1]) {
      const dd = new Date(d.getTime() + off * 86400_000);
      pairs.set(`${p.sport}|${ymd(dd)}`, { sport: p.sport, date: ymd(dd) });
    }
  }

  // Fetch finals, key by sport → list.
  const finalsBySport = {};
  for (const { sport, date } of pairs.values()) {
    try {
      const finals = await fetchFinals(sport, date);
      (finalsBySport[sport] ||= []).push(...finals);
    } catch (e) { logger.warn('grading', e.message); }
  }

  let graded = 0, wins = 0, losses = 0, pushes = 0;
  const now = new Date().toISOString();
  for (const p of pending) {
    const parts = String(p.matchup || '').split(' @ ');
    const awayName = norm(parts[0]), homeName = norm(parts[1]);
    const f = (finalsBySport[p.sport] || []).find(
      (x) => homeName.includes(x.homeNick) && awayName.includes(x.awayNick),
    );
    if (!f) continue;
    const result = gradePlay(p, f);
    if (!result) continue;
    const stake = p.unit_dollars ?? config.rules.unitDollars;
    const pnl = result === 'win' ? Math.round(stake * profitPerUnit(-110) * 100) / 100
      : result === 'loss' ? -stake : 0;
    try {
      await db.update('monitor_scores', {
        status: result, result_score: `${f.away_score}-${f.home_score}`, pnl, graded_at: now,
      }, { id: p.id });
    } catch (e) { logger.warn('grading', e.message); continue; }
    graded++;
    if (result === 'win') wins++; else if (result === 'loss') losses++; else pushes++;
  }

  // Grade research picks against the same finals.
  let rGraded = 0;
  for (const p of rpending) {
    const parts = String(p.matchup || '').split(' @ ');
    const awayName = norm(parts[0]), homeName = norm(parts[1]);
    const f = (finalsBySport[p.sport] || []).find((x) => homeName.includes(x.homeNick) && awayName.includes(x.awayNick));
    if (!f) continue;
    const result = gradePlay(p, f);
    if (!result) continue;
    const stake = config.rules.unitDollars;
    const pnl = result === 'win' ? Math.round(stake * profitPerUnit(p.odds || -110) * 100) / 100
      : result === 'loss' ? -stake : 0;
    try {
      await db.update('research_notes', { status: result, result_score: `${f.away_score}-${f.home_score}`, pnl, graded_at: now }, { id: p.id });
      rGraded++;
    } catch (e) { logger.warn('grading', `research: ${e.message}`); }
  }

  return {
    summary: `graded ${graded} (${wins}W-${losses}L-${pushes}P)${rGraded ? ` + ${rGraded} research` : ''} · free ESPN`,
    data: { graded, wins, losses, pushes, research: rGraded },
  };
}

export default { name: 'grading', run };
