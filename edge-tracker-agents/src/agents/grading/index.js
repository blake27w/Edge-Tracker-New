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
import { reportDegraded } from '../../store/index.js';
import { getFinals, getBox, getUfcResults } from '../shared/espn.js';

// How far back the grader will look for pending plays. Anything older is
// ungradeable in practice (ESPN's scoreboard won't serve it) and is retired
// rather than left to clog the queue.
const LOOKBACK_DAYS = Number(process.env.GRADE_LOOKBACK_DAYS) || 10;
const EXPIRE_BATCH = 200;
// Minimum plays-with-finals-available before "0 graded" is treated as a defect
// rather than an ordinary quiet run. Guards against alarming on a single play.
const ZERO_ALARM_MIN = Number(process.env.GRADE_ZERO_ALARM_MIN) || 5;

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

// Completed finals for a sport+date — via the shared TTL-cached ESPN fetcher.
async function fetchFinals(sport, dateStr) {
  return getFinals(ESPN_PATH[sport], dateStr);
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
  if (p.market === 'spread' && p.line != null) {
    // p.side is the team; p.line is that side's spread number (home -3 / away +3).
    const betHome = norm(p.side).includes(f.homeNick) && !norm(p.side).includes(f.awayNick);
    const margin = betHome ? (f.home_score - f.away_score) : (f.away_score - f.home_score);
    const ats = Math.round((margin + Number(p.line)) * 10) / 10;
    if (ats === 0) return 'push';
    return ats > 0 ? 'win' : 'loss';
  }
  return null; // props (and spreads without a stored number) left pending
}

// Why did a play lose? Flags variance (a bad beat, not a bad read).
function lossAnomaly(p, f) {
  if (f.overtime) return 'overtime';
  if (p.market === 'spread' && p.line != null) {
    const betHome = norm(p.side).includes(f.homeNick) && !norm(p.side).includes(f.awayNick);
    const margin = betHome ? (f.home_score - f.away_score) : (f.away_score - f.home_score);
    if (Math.abs(margin + Number(p.line)) <= 1) return 'hook'; // lost by ≤1 (the hook)
  }
  if (p.market === 'total' && p.line != null && Math.abs(f.total - Number(p.line)) <= 1) return 'close';
  return null;
}

// ── Player-prop grading from ESPN box scores ─────────────────────
// stat_type → { labels: ESPN stat abbreviations, category?: stat group, altGA? }
// Short stat ids used by research prop picks (nfl-props baselines) → grading stat_type.
const RESEARCH_STAT = { rush_yds: 'player_rush_yds', rec_yds: 'player_reception_yds', receptions: 'player_receptions', pass_yds: 'player_pass_yds', rush_att: 'player_rush_att', targets: 'player_targets', pass_att: 'player_pass_att' };
const STAT = {
  player_points: { labels: ['PTS'], altGA: true },          // NBA PTS; NHL falls back to G+A
  player_rebounds: { labels: ['REB'] },
  player_assists: { labels: ['AST'] },
  player_shots_on_goal: { labels: ['SOG', 'S', 'SH'] },
  player_pass_yds: { labels: ['YDS'], category: 'passing' },
  player_rush_yds: { labels: ['YDS'], category: 'rushing' },
  player_reception_yds: { labels: ['YDS'], category: 'receiving' },
  player_receptions: { labels: ['REC'], category: 'receiving' },
  player_rush_att: { labels: ['CAR'], category: 'rushing' },
  player_targets: { labels: ['TGTS'], category: 'receiving' },
  player_pass_att: { labels: ['C/ATT'], category: 'passing', att: true },
  batter_hits: { labels: ['H'], category: 'batting' },
  pitcher_strikeouts: { labels: ['K', 'SO'], category: 'pitching' },
};

function statNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function nameMatch(ath, name) {
  const a = norm(ath?.displayName || ath?.shortName || ''), n = norm(name);
  if (!a || !n) return false;
  if (a === n || a.includes(n) || n.includes(a)) return true;
  const an = a.split(' '), nn = n.split(' ');
  return an.length && nn.length && an[an.length - 1] === nn[nn.length - 1] && an[0][0] === nn[0][0]; // last name + first initial
}
// Find a player's stat in an ESPN boxscore.
function statValue(box, player, spec) {
  for (const team of box?.players || []) {
    for (const grp of team.statistics || []) {
      if (spec.category) {
        const gn = String(grp.name || grp.text || grp.type || '').toLowerCase();
        if (!gn.includes(spec.category)) continue;
      }
      const labels = (grp.labels || grp.keys || []).map((s) => String(s).toUpperCase());
      const ath = (grp.athletes || []).find((a) => nameMatch(a.athlete, player));
      if (!ath) continue;
      for (const w of spec.labels) {
        const i = labels.indexOf(w);
        if (i >= 0) { if (spec.att) { const m = /(\d+)\s*\/\s*(\d+)/.exec(String(ath.stats?.[i] || '')); if (m) return Number(m[2]); continue; } const v = statNum(ath.stats?.[i]); if (v != null) return v; }
      }
      if (spec.altGA) { // NHL points = goals + assists
        const gi = labels.indexOf('G'), ai = labels.indexOf('A');
        if (gi >= 0 && ai >= 0) { const g = statNum(ath.stats[gi]), a = statNum(ath.stats[ai]); if (g != null && a != null) return g + a; }
      }
    }
  }
  return null;
}


// Loose name match for tennis (full name vs ESPN displayName; fall back to surname).
function tName(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xn = x.split(' '), yn = y.split(' ');
  return xn[xn.length - 1] === yn[yn.length - 1];
}
// Completed tennis matches for a date across ATP + WTA. Returns [{ names, winner }].
async function fetchTennis(dateStr) {
  const out = [];
  for (const lg of ['atp', 'wta']) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/tennis/${lg}/scoreboard?dates=${dateStr}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of data.events || []) {
        const comp = (ev.competitions || [])[0];
        if (!comp) continue;
        if (!(comp.status?.type?.completed || ev.status?.type?.completed)) continue;
        const cs = comp.competitors || [];
        const names = cs.map((c) => c.athlete?.displayName || c.athlete?.shortName || '').filter(Boolean);
        const winner = cs.find((c) => c.winner)?.athlete?.displayName;
        if (names.length >= 2 && winner) out.push({ names, winner });
      }
    } catch (_) { /* leave pending */ }
  }
  return out;
}

async function gradeProp(p, f, path) {
  const spec = STAT[p.stat_type];
  if (!spec || !f?.id || p.line == null) return null;
  const box = await getBox(path, f.id);
  if (!box) return null;
  const val = statValue(box, p.player, spec);
  if (val == null) return null; // couldn't find the stat → leave pending, never mis-grade
  if (val === Number(p.line)) return 'push';
  const over = String(p.side).toUpperCase().includes('OVER');
  return (over ? val > p.line : val < p.line) ? 'win' : 'loss';
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
    // Keeper preference: a real result first, then a live pending row, then
    // whatever's left. 'expired' must NOT outrank 'pending' — a rescheduled
    // game can have an expired old row plus a fresh pending one, and keeping
    // the expired one would delete the gradeable play.
    const GRADED = new Set(['win', 'loss', 'push']);
    const keeper = list.find((r) => GRADED.has(r.status))
      || list.find((r) => r.status === 'pending')
      || list[0];
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

// Retire plays older than the grading window. ESPN's scoreboard won't serve
// them, so they can never be graded — and while they sit at `pending` they
// occupy the oldest-first queue and starve everything behind them. 'expired' is
// outside the win/loss/push record, so it changes no reported numbers.
async function expireStale(floorIso) {
  let stale = [];
  try {
    stale = await db.select('monitor_scores', 'id', {
      match: { status: 'pending', qualified: true },
      lte: { scored_at: floorIso }, limit: EXPIRE_BATCH,
    });
  } catch (e) { logger.warn('grading', `expire select: ${e.message}`); return 0; }
  let n = 0;
  for (const r of stale) {
    try { await db.update('monitor_scores', { status: 'expired', graded_at: new Date().toISOString() }, { id: r.id }); n++; }
    catch (e) { logger.warn('grading', `expire: ${e.message}`); break; }
  }
  if (n) logger.warn('grading', `expired ${n} plays older than ${LOOKBACK_DAYS}d — ungradeable, removed from the pending queue`);
  return n;
}

async function run() {
  if (!db.isConnected()) return { summary: 'skipped — no DB' };

  await dedupe();

  const cutoff = new Date(Date.now() - 3.5 * 3600_000).toISOString();
  // Lower bound on the queue. Without it, `limit: 80` ordered oldest-first was
  // permanently occupied by ungradeable rows and nothing new was ever reached.
  const floor = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const expired = await expireStale(floor);
  let pending = [];
  try {
    pending = await db.select('monitor_scores', '*', {
      match: { status: 'pending', qualified: true },
      // Restrict to gradeable sports IN THE QUERY. Filtering after the 80-row
      // window meant pending rows for sports with no grading track at all
      // (BOXING, say) could fill the window and starve the plays we can grade —
      // the same head-of-line problem by another route.
      in: { sport: Object.keys(ESPN_PATH) },
      gte: { scored_at: floor }, lte: { scored_at: cutoff },
      // NEWEST first. Oldest-first meant ungradeable rows sat permanently at
      // the head of the queue and starved every play behind them; newest-first
      // guarantees fresh plays are always reached, and expireStale() clears the
      // tail, so nothing can block the queue no matter how much junk collects.
      order: { column: 'scored_at', ascending: false }, limit: 80,
    });
  } catch (e) {
    reportDegraded('grading|select', `monitor_scores query failing: ${e.message}`);
    return { summary: `select failed: ${e.message}` };
  }
  pending = pending.filter((p) => ESPN_PATH[p.sport]);

  // Research picks awaiting grading (same finals, separate track record).
  let rpending = [];
  try {
    rpending = await db.select('research_notes', '*', { match: { type: 'pick', status: 'pending' }, gte: { created_at: floor }, lte: { created_at: cutoff }, limit: 80 });
  } catch (_) { /* table optional */ }
  rpending = rpending.filter((p) => ESPN_PATH[p.sport]);

  // Tennis picks grade via ESPN's tennis scoreboards (separate from team finals).
  let tpending = [];
  try {
    tpending = await db.select('monitor_scores', '*', { match: { sport: 'TENNIS', status: 'pending', qualified: true }, gte: { scored_at: floor }, lte: { scored_at: cutoff }, limit: 80 });
  } catch (_) { /* table optional */ }

  // UFC picks grade via ESPN MMA (winner). They're observational but still grade.
  let upending = [];
  try {
    upending = await db.select('monitor_scores', '*', { match: { sport: 'UFC', status: 'pending', qualified: true }, gte: { scored_at: floor }, lte: { scored_at: cutoff }, limit: 80 });
  } catch (_) { /* table optional */ }

  if (!pending.length && !rpending.length && !tpending.length && !upending.length) {
    return { summary: `no completed plays to grade${expired ? ` · ${expired} expired` : ''}`, data: { graded: 0, expired } };
  }

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
  // Every `continue` below used to be silent, so a total matching failure and a
  // genuinely empty slate both printed "graded 0". These counters are the
  // difference between the two, and they go into the summary.
  let noFinal = 0, noResult = 0, writeFail = 0;
  const now = new Date().toISOString();
  for (const p of pending) {
    const parts = String(p.matchup || '').split(' @ ');
    const awayName = norm(parts[0]), homeName = norm(parts[1]);
    const f = (finalsBySport[p.sport] || []).find(
      (x) => homeName.includes(x.homeNick) && awayName.includes(x.awayNick),
    );
    if (!f) { noFinal++; continue; }
    const result = p.market === 'prop' ? await gradeProp(p, f, ESPN_PATH[p.sport]) : gradePlay(p, f);
    if (!result) { noResult++; continue; }
    const stake = p.unit_dollars ?? config.rules.unitDollars;
    // Win P&L at the side's real price (mainly ML). Spreads/totals/props have no
    // stored price → default -110 (standard juice). Favorites were over-credited.
    const winOdds = p.market === 'ml' && p.price != null ? p.price : -110;
    const pnl = result === 'win' ? Math.round(stake * profitPerUnit(winOdds) * 100) / 100
      : result === 'loss' ? -stake : 0;
    const anomaly = result === 'loss' ? (p.market === 'prop' ? (f.overtime ? 'overtime' : null) : lossAnomaly(p, f)) : null;
    try {
      await db.update('monitor_scores', {
        status: result, result_score: `${f.away_score}-${f.home_score}`, pnl, anomaly, graded_at: now,
      }, { id: p.id });
    } catch (e) { writeFail++; logger.warn('grading', e.message); continue; }
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
    let result;
    if (p.market === 'prop' && p.player && p.stat) {
      const stat_type = RESEARCH_STAT[p.stat] || p.stat;
      result = await gradeProp({ ...p, stat_type }, f, ESPN_PATH[p.sport] || 'football/nfl');
    } else result = gradePlay(p, f);
    if (!result) continue;
    const stake = config.rules.unitDollars;
    const pnl = result === 'win' ? Math.round(stake * profitPerUnit(p.odds || -110) * 100) / 100
      : result === 'loss' ? -stake : 0;
    try {
      await db.update('research_notes', { status: result, result_score: `${f.away_score}-${f.home_score}`, pnl, graded_at: now }, { id: p.id });
      rGraded++;
    } catch (e) { logger.warn('grading', `research: ${e.message}`); }
  }

  // Grade tennis picks by player name against ESPN tennis results.
  let tGraded = 0;
  if (tpending.length) {
    const dates = new Set();
    for (const p of tpending) { const d = new Date(p.scored_at); for (const off of [0, -1, 1]) dates.add(ymd(new Date(d.getTime() + off * 86400_000))); }
    const results = [];
    for (const d of dates) { try { results.push(...await fetchTennis(d)); } catch (e) { logger.warn('grading', `tennis: ${e.message}`); } }
    for (const p of tpending) {
      const m = results.find((r) => r.names.some((n) => tName(n, p.side)));
      if (!m) continue;
      const result = tName(m.winner, p.side) ? 'win' : 'loss';
      const stake = p.unit_dollars ?? config.rules.unitDollars;
      const pnl = result === 'win' ? Math.round(stake * profitPerUnit(-110) * 100) / 100 : -stake;
      try { await db.update('monitor_scores', { status: result, pnl, graded_at: now }, { id: p.id }); tGraded++; }
      catch (e) { logger.warn('grading', `tennis: ${e.message}`); }
    }
  }

  // Grade UFC picks by fighter name against ESPN MMA results.
  let uGraded = 0;
  if (upending.length) {
    const dates = new Set();
    for (const p of upending) { const d = new Date(p.scored_at); for (const off of [0, 1, 2]) dates.add(ymd(new Date(d.getTime() + off * 86400_000))); }
    const results = [];
    for (const d of dates) { try { results.push(...await getUfcResults(d)); } catch (e) { logger.warn('grading', `ufc: ${e.message}`); } }
    for (const p of upending) {
      const m = results.find((r) => r.names.some((n) => tName(n, p.side)));
      if (!m) continue;
      const result = tName(m.winner, p.side) ? 'win' : 'loss';
      const stake = p.unit_dollars ?? config.rules.unitDollars;
      const pnl = result === 'win' ? Math.round(stake * profitPerUnit(-110) * 100) / 100 : -stake;
      try { await db.update('monitor_scores', { status: result, pnl, graded_at: now }, { id: p.id }); uGraded++; }
      catch (e) { logger.warn('grading', `ufc: ${e.message}`); }
    }
  }

  const queued = pending.length + rpending.length + tpending.length + upending.length;
  const total = graded + rGraded + tGraded + uGraded;

  // ── Make "graded 0" explain itself ─────────────────────────────
  // Careful: "queued but 0 graded" is NOT by itself a defect. Plays are logged
  // up to 36h before kickoff while the queue cutoff is only scored_at-3.5h, so
  // on any given run most queued plays simply belong to games that haven't
  // finished. Alarming on that would mean a daily false alert, which is how
  // monitoring gets ignored.
  //
  // The signal that IS a defect: ESPN returned finals for a play's sport (so
  // games on that date are over and the data is there) and still nothing
  // matched. That's our matching, not the market's timing.
  const withFinals = pending.filter((p) => (finalsBySport[p.sport] || []).length);
  if (withFinals.length >= ZERO_ALARM_MIN && !total) {
    const why = noResult > noFinal
      ? `${noResult} plays matched a final but produced no result (missing line / unsupported market)`
      : `none of ${withFinals.length} plays matched a final, though ESPN returned finals for their sport+date (matchup ↔ ESPN nickname matching)`;
    logger.error('grading', `${withFinals.length} plays had finals available, 0 graded — ${why}`);
    reportDegraded('grading|zero', `${withFinals.length} plays had finals available but 0 graded — ${why}`);
  }
  if (writeFail) reportDegraded('grading|write', `${writeFail} monitor_scores writes failed`);

  const extra = [];
  if (rGraded) extra.push(`+ ${rGraded} research`);
  if (tGraded) extra.push(`+ ${tGraded} tennis`);
  if (uGraded) extra.push(`+ ${uGraded} UFC`);
  // These counters are the whole point: they turn an ambiguous "graded 0" into
  // a diagnosis without needing DB access.
  const notes = [`${queued} queued`];
  if (noFinal) notes.push(`${noFinal} no final`);
  if (noResult) notes.push(`${noResult} no result`);
  if (writeFail) notes.push(`${writeFail} write fail`);
  if (expired) notes.push(`${expired} expired`);

  return {
    summary: `graded ${graded} (${wins}W-${losses}L-${pushes}P)${extra.length ? ` ${extra.join(' ')}` : ''} · ${notes.join(', ')} · free ESPN`,
    data: { graded, wins, losses, pushes, research: rGraded, tennis: tGraded, ufc: uGraded, queued, noFinal, noResult, writeFail, expired },
  };
}

// Reused by the opportunity grader.
export { ESPN_PATH, profitPerUnit, ymd, norm, fetchFinals, gradePlay };

export default { name: 'grading', run };
