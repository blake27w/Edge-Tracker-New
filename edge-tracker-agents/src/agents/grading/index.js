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
import { reportDegraded, getGames } from '../../store/index.js';
import { getFinals, getSchedule, getBox, getUfcResults } from '../shared/espn.js';

// Two SEPARATE thresholds. Welding them together was a mistake: "stop
// attempting" and "write off permanently" are different decisions with very
// different costs.
//
// LOOKBACK_DAYS — how far back we attempt to grade. Cheap to be conservative.
const LOOKBACK_DAYS = Number(process.env.GRADE_LOOKBACK_DAYS) || 10;
// EXPIRE_DAYS — when we abandon a play. Deliberately much longer, because the
// original rationale for retiring at the lookback boundary was WRONG: ESPN's
// scoreboard serves historical dates perfectly well (nfl-history grades 2024
// games through the same getFinals), so an old pending play is not inherently
// ungradeable. What D4 found is that ESPN drops old ODDS, not old scores.
//
// Retiring them is still worth doing, but for a different reason: unbounded
// pending rows fill the dedupe windows other agents rely on — signal-engine
// reads 3000 pending rows, ncaaf-model 2000, prop-engine 200 — and once those
// fill with ancient rows the dedupe silently stops suppressing duplicates.
// 30 days is past any plausible grading opportunity while still bounding that.
const EXPIRE_DAYS = Number(process.env.GRADE_EXPIRE_DAYS) || 30;
const EXPIRE_BATCH = 200;
// A sweep this large is either first-run cleanup or a grader that was down
// long enough to write off real results. Both are worth saying out loud.
const EXPIRE_LOUD_AT = Number(process.env.GRADE_EXPIRE_LOUD_AT) || 25;
// Minimum should-have-been-gradeable plays before "0 graded" is treated as a
// defect rather than an ordinary quiet run. Guards against alarming on a single
// play (one prop with an unfindable stat is not an outage).
const ZERO_ALARM_MIN = Number(process.env.GRADE_ZERO_ALARM_MIN) || 5;
// How long after scored_at a play's game is CERTAINLY over. Plays are logged up
// to 36h before kickoff and a game runs ~4h, so past this a missing final is a
// real failure (ours or ESPN's) rather than a game that hasn't started.
const SETTLED_HOURS = Number(process.env.GRADE_SETTLED_HOURS) || 48;
// Past this, a play with no final on ANY fetched date has stopped being
// evidence of a grading defect. Postponed, cancelled and relocated games are
// the common cause, and they never acquire a final — so counting them in the
// alarm population re-raised the same alert every single run for the 25 days
// between SETTLED_HOURS and EXPIRE_DAYS. That is the daily false alarm D105
// set out to remove, arriving by a slower route. They stay pending (they are
// honestly ungradeable, not written off) and are reported as `unresolvable`.
// 5 days is well past any ESPN publish lag while still bounding the noise.
const UNRESOLVABLE_DAYS = Number(process.env.GRADE_UNRESOLVABLE_DAYS) || 5;
// Scoreboard dates to fetch per play, as day offsets from scored_at. A play is
// logged up to 36h BEFORE kickoff and a late US game lands on the NEXT UTC
// date, so its final can sit two days after scored_at; a late-evening game
// logged after its own kickoff sits one day before. [+2,+1,0,-1] is the tight
// cover. The old [0,-1] looked only backwards, so an NCAAF play logged the day
// before kickoff (prod: Toledo @ Sacramento State, scored 11-03, final on
// ESPN's 11-04 board) never had its game's date fetched at all (D105).
//
// Cost: the pairs below are deduped to one fetch per distinct (sport, date),
// and shared/espn.js caches by that same key, so it is 4 fetches per sport for
// a single evening's slate regardless of how many plays are queued (worst case
// LOOKBACK_DAYS+3 distinct dates when the queue spans the whole window).
// Targeting ONE date instead would need the game's kickoff time, which is not
// available cheaply: monitor_scores has no commence_time column (signal-engine
// strips it before insert) and the odds slate in store holds only the CURRENT
// upcoming games, so a play days old is no longer in it. ESPN is free.
const DATE_OFFSETS = [2, 1, 0, -1];

// monitor_scores sport → ESPN scoreboard path.
const ESPN_PATH = {
  MLB: 'baseball/mlb', NBA: 'basketball/nba', NHL: 'hockey/nhl', NFL: 'football/nfl',
  NCAAF: 'football/college-football', NCAAB: 'basketball/mens-college-basketball', WNBA: 'basketball/wnba',
};

function profitPerUnit(odds = -110) {
  return odds < 0 ? 100 / Math.abs(odds) : odds / 100;
}
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
// Characters NFD cannot reach. Stroked and ligature letters are single
// precomposed code points with no combining mark to strip — NFD('ø') is 'ø' —
// so the diacritic fold alone still left "Bjørkstrand" unable to meet ESPN's
// "Bjorkstrand". The typographic apostrophe is the same class of problem from
// the other direction: the Odds API ships U+2019 in "O’Reilly" where ESPN
// ships the ASCII quote. Both sides fold, so this only ever widens matching.
const FOLD = { ø: 'o', ł: 'l', ß: 'ss', đ: 'd', æ: 'ae', œ: 'oe', '’': "'" };
const FOLD_RE = /[øłßđæœ’]/gi;
// Fold diacritics BEFORE casing. The Odds API carries the accented spelling
// ("Tim Stützle") while ESPN's boxscore displayName is unaccented
// ("Tim Stutzle"), and every comparison downstream is ===/includes, so an
// unfolded norm() left those plays pending forever (D105). Both sides of every
// comparison pass through here, and shared/espn.js folds its team nicknames the
// same way, so nothing that matched before stops matching.
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(FOLD_RE, (c) => FOLD[c.toLowerCase()] || c)
    .toLowerCase();
}

// Completed finals for a sport+date — via the shared TTL-cached ESPN fetcher.
async function fetchFinals(sport, dateStr) {
  return getFinals(ESPN_PATH[sport], dateStr);
}

// ALL scheduled events (completed or not) for a sport+date. Same fetch/cache
// as fetchFinals (shared/espn.js dedupes on the raw request) — this is free.
async function fetchSchedule(sport, dateStr) {
  return getSchedule(ESPN_PATH[sport], dateStr);
}

// ── Picking the RIGHT final when a matchup repeats ───────────────
// The finals for a sport are flattened across all four fetched dates, and
// matchups REPEAT inside a 4-day window as a matter of routine, not as an edge
// case: an MLB series is the same two nicknames on three consecutive days (15
// of 28 matchups in a typical window), and NBA/NHL home-and-homes do it too.
// A nickname-only `.find()` over that flattened list returns whichever board
// was fetched first — and DATE_OFFSETS starts at +2, the LATEST board — so a
// play on game 1 of a series was graded against game 3's score. Verified in
// reproduction: an MLB game-1 loss (2-3) pending two days was written
// `win 4-2 +83.33` off game 3. gradeProp inherited it through `f.id`, which
// means the box score came from the wrong game too.
//
// So every final carries the board date it came from, and we choose the one
// closest to the play's OWN game date.
const FALLBACK_RANK = [0, 1, 2, -1];

// Signed day distance between two YYYYMMDD strings. Parsed as UTC midnights
// rather than differenced as timestamps, so DST cannot shift a boundary.
function dayDiff(a, b) {
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((t(a) - t(b)) / 86400_000);
}

// The play's own game kickoff (ms), if it can be had for free. monitor_scores
// has no commence_time column (signal-engine strips it before insert), but the
// in-memory odds slate still holds the game while it is upcoming, and that is
// already in process — no query, no new dependency. Once the game has rolled
// off the slate this returns null and the caller falls back to scored_at.
function gameCommenceMs(p) {
  if (!p.game_id) return null;
  const g = (getGames() || []).find((x) => x.game_id === p.game_id && x.commence_time);
  const t = g ? Date.parse(g.commence_time) : NaN;
  return Number.isFinite(t) ? t : null;
}
function gameDate(p) {
  const t = gameCommenceMs(p);
  return t != null ? ymd(new Date(t)) : null;
}

// A final whose own kickoff lands this far from the play's real kickoff is not
// the play's game, full stop — "closest board date" is not a strong enough
// test once two games share a date (D111 #1, the doubleheader defect).
const START_TOLERANCE_MS = 3 * 3600_000;

// Choose the final for a play. Returns { f } with the chosen final (or null if
// none matched), { ambiguous: true } when two candidates are equally good, or
// { wrongSlot: true } when a candidate matched the matchup but is demonstrably
// the wrong GAME — either its kickoff is too far from the play's own, or (when
// the play's own kickoff is unknown) the board holds a second scheduled game
// for this matchup that simply hasn't gone final yet.
function pickFinal(finals, p, awayName, homeName, schedule) {
  const hits = [], seen = new Set();
  for (const x of finals) {
    if (!(homeName.includes(x.homeNick) && awayName.includes(x.awayNick))) continue;
    // The same ESPN event can surface on two adjacent boards. One game is not
    // an ambiguity, so collapse by event id before counting candidates.
    if (x.id != null) { if (seen.has(x.id)) continue; seen.add(x.id); }
    hits.push(x);
  }

  const commence = gameCommenceMs(p);
  // Only a real signal when both sides have a start time. A final with no
  // startTime (old fixtures, or an ESPN response missing comp.date) is never
  // rejected on this basis alone — this guard can only narrow, never widen,
  // what used to match.
  const withinStart = (x) => commence == null || !x.startTime
    || Math.abs(Date.parse(x.startTime) - commence) <= START_TOLERANCE_MS;
  const viable = hits.filter(withinStart);
  // Candidates existed for this matchup but none started near the play's own
  // kickoff — not a tie, the wrong game entirely.
  if (hits.length > 0 && viable.length === 0) return { wrongSlot: true };

  if (viable.length <= 1) {
    const f = viable[0] || null;
    // getFinals only returns COMPLETED events, so "exactly one hit" can really
    // mean "the matchup's OTHER game today hasn't finished yet" — a
    // doubleheader where game 2 is still live silently reads as "one game".
    // Only checkable once the play's own kickoff is unknown: when commence is
    // known, the start-time filter above already settled it.
    if (f && commence == null) {
      const sameMatchup = (schedule || []).filter((s) =>
        s.boardDate === f.boardDate && homeName.includes(s.homeNick) && awayName.includes(s.awayNick));
      if (sameMatchup.length >= 2) return { wrongSlot: true };
    }
    return { f };
  }

  const own = gameDate(p);
  const base = ymd(new Date(p.scored_at || p.created_at));
  // Lower is better. With the game's real date, "closest" is literal. Without
  // it, scored_at is a lower bound rather than a centre — a play is logged
  // BEFORE its game — so same-day beats the next day beats two days later, and
  // the day before is the last resort rather than a tie with the day after.
  const rank = (x) => {
    if (!x.boardDate) return Infinity;
    if (own) return Math.abs(dayDiff(x.boardDate, own));
    const i = FALLBACK_RANK.indexOf(dayDiff(x.boardDate, base));
    return i < 0 ? Infinity : i;
  };
  const ranked = viable.map((x) => ({ x, r: rank(x) })).sort((a, b) => a.r - b.r);
  if (!Number.isFinite(ranked[0].r)) return { f: null };
  // Two finals equally close to the play's game date: nothing left distinguishes
  // them, and picking either writes a coin-flip result into the track record.
  // Honest pending beats a 50% chance of a wrong W or L.
  if (ranked[1] && ranked[1].r === ranked[0].r) return { ambiguous: true };
  return { f: ranked[0].x };
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
// stat_type → { keys: ESPN stat API names, labels: display abbreviations,
//               category?: stat group, altGA?, att? }
//
// `keys` is authoritative and tried first. Display abbreviations collide — both
// across sports and across columns of the SAME table — so resolving a prop by
// label is a coin flip that happens to have landed right everywhere except NHL
// shots. Audited against live ESPN boxscores (NHL 401892628, NFL 401873036,
// NBA 401909936, MLB 401908046):
//   NHL skaters labels [...,'G','YTDG','A','S','SM','SOG',...] →
//     keys [...,'goals','ytdGoals','assists','shotsTotal','shotsMissed',
//     'shootoutGoals',...]. 'S' is shots on goal; 'SOG' is SHOOTOUT goals.
//     The old ['SOG','S','SH'] took the first label present, so every NHL
//     shots-on-goal prop graded against shootout goals — effectively always 0,
//     writing every OVER a loss and every UNDER a win (D105).
//   NFL 'REC' is receptions in the receiving group and fumblesRecovered in the
//     fumbles group; 'YDS' is passing/rushing/receiving yards in three groups;
//     'PTS' is totalKickingPoints in the kicking group but points in NBA. Each
//     of those is correct today only because of its `category` filter — exactly
//     the same bug waiting. `keys` makes it structural instead of incidental.
//   MLB batting labels ['H-AB','AB','R','H',...]: indexOf('H') lands on hits,
//     not on the 'H-AB' string — right by luck; key 'hits' is right by name.
//   'SH' matches no label in any of the four boxscores; kept only as a harmless
//     last resort.
// Short stat ids used by research prop picks (nfl-props baselines) → grading stat_type.
const RESEARCH_STAT = { rush_yds: 'player_rush_yds', rec_yds: 'player_reception_yds', receptions: 'player_receptions', pass_yds: 'player_pass_yds', rush_att: 'player_rush_att', targets: 'player_targets', pass_att: 'player_pass_att' };
const STAT = {
  player_points: { keys: ['points'], labels: ['PTS'], altGA: true }, // NBA points; NHL falls back to G+A
  player_rebounds: { keys: ['rebounds'], labels: ['REB'] },
  player_assists: { keys: ['assists'], labels: ['AST'] },
  player_shots_on_goal: { keys: ['shotsTotal'], labels: ['S', 'SH'] },
  player_pass_yds: { keys: ['passingYards'], labels: ['YDS'], category: 'passing' },
  player_rush_yds: { keys: ['rushingYards'], labels: ['YDS'], category: 'rushing' },
  player_reception_yds: { keys: ['receivingYards'], labels: ['YDS'], category: 'receiving' },
  player_receptions: { keys: ['receptions'], labels: ['REC'], category: 'receiving' },
  player_rush_att: { keys: ['rushingAttempts'], labels: ['CAR'], category: 'rushing' },
  player_targets: { keys: ['receivingTargets'], labels: ['TGTS'], category: 'receiving' },
  player_pass_att: { keys: ['completions/passingAttempts'], labels: ['C/ATT'], category: 'passing', att: true },
  batter_hits: { keys: ['hits'], labels: ['H'], category: 'batting' },
  pitcher_strikeouts: { keys: ['strikeouts'], labels: ['K', 'SO'], category: 'pitching' },
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
  // Surname + first initial. Both sides are already diacritic-folded by norm(),
  // which is what lets "Tim Stützle" reach ESPN's "Tim Stutzle".
  return !!an[0] && !!nn[0] && an[an.length - 1] === nn[nn.length - 1] && an[0][0] === nn[0][0];
}
// Find a player's stat in an ESPN boxscore.
function statValue(box, player, spec) {
  for (const team of box?.players || []) {
    for (const grp of team.statistics || []) {
      if (spec.category) {
        const gn = String(grp.name || grp.text || grp.type || '').toLowerCase();
        if (!gn.includes(spec.category)) continue;
      }
      // ESPN ships two parallel arrays describing the same columns: `keys`
      // (stable API names) and `labels` (display abbreviations). Resolve by key
      // name first and fall back to the label, so an ambiguous abbreviation can
      // never pick the wrong column when the unambiguous name is right there.
      const keys = (grp.keys || []).map((s) => String(s));
      const labels = (grp.labels || grp.keys || []).map((s) => String(s).toUpperCase());
      const ath = (grp.athletes || []).find((a) => nameMatch(a.athlete, player));
      if (!ath) continue;
      const cols = [];
      for (const k of spec.keys || []) { const i = keys.indexOf(k); if (i >= 0 && !cols.includes(i)) cols.push(i); }
      for (const w of spec.labels) { const i = labels.indexOf(w); if (i >= 0 && !cols.includes(i)) cols.push(i); }
      for (const i of cols) {
        if (spec.att) { const m = /(\d+)\s*\/\s*(\d+)/.exec(String(ath.stats?.[i] || '')); if (m) return Number(m[2]); continue; }
        const v = statNum(ath.stats?.[i]); if (v != null) return v;
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
  // Writing results off is the one destructive thing this agent does, so it
  // reports when it does it in bulk rather than only logging a warn.
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
  if (n) logger.warn('grading', `expired ${n} plays older than ${EXPIRE_DAYS}d — removed from the pending queue`);
  if (n >= EXPIRE_LOUD_AT) {
    logger.error('grading', `wrote off ${n} plays older than ${EXPIRE_DAYS}d — expected once as cleanup; repeatedly means results are being abandoned`);
    reportDegraded('grading|expired-bulk',
      `wrote off ${n} plays older than ${EXPIRE_DAYS}d. Expected once as initial cleanup; if this recurs, the grader has been failing long enough to abandon real results`);
  }
  return n;
}

async function run() {
  if (!db.isConnected()) return { summary: 'skipped — no DB' };

  await dedupe();

  const cutoff = new Date(Date.now() - 3.5 * 3600_000).toISOString();
  // Lower bound on the queue. Without it, `limit: 80` ordered oldest-first was
  // permanently occupied by ungradeable rows and nothing new was ever reached.
  const floor = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  // Note the different threshold: we stop ATTEMPTING at LOOKBACK_DAYS but do
  // not ABANDON until EXPIRE_DAYS, so a grader outage shorter than the gap
  // between them loses nothing.
  const expired = await expireStale(new Date(Date.now() - EXPIRE_DAYS * 86400_000).toISOString());
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

  // Collect the (sport, date) pairs we need — see DATE_OFFSETS for why the
  // window reaches forwards as well as back, and for the fetch cost.
  const pairs = new Map();
  for (const p of [...pending, ...rpending]) {
    const d = new Date(p.scored_at || p.created_at);
    for (const off of DATE_OFFSETS) {
      const dd = new Date(d.getTime() + off * 86400_000);
      pairs.set(`${p.sport}|${ymd(dd)}`, { sport: p.sport, date: ymd(dd) });
    }
  }

  // Fetch finals, key by sport → list. Each final keeps the board date it came
  // from: flattening without it is what let a repeated matchup grade against
  // the wrong game in the series (see pickFinal).
  const finalsBySport = {};
  // Scheduled events (completed or not) on the same dates, for pickFinal's
  // doubleheader guard — getFinals drops the unfinished game, so it alone
  // can't tell "one game" from "one game done, one still live" (D111 #1).
  // Same cached fetch as fetchFinals, so this costs nothing extra.
  const scheduleBySport = {};
  for (const { sport, date } of pairs.values()) {
    try {
      const finals = await fetchFinals(sport, date);
      (finalsBySport[sport] ||= []).push(...finals.map((f) => ({ ...f, boardDate: date })));
    } catch (e) { logger.warn('grading', e.message); }
    try {
      const sched = await fetchSchedule(sport, date);
      (scheduleBySport[sport] ||= []).push(...sched.map((s) => ({ ...s, boardDate: date })));
    } catch (e) { logger.warn('grading', e.message); }
  }

  let graded = 0, wins = 0, losses = 0, pushes = 0;
  // Every `continue` below used to be silent, so a total matching failure and a
  // genuinely empty slate both printed "graded 0". These counters are the
  // difference between the two, and they go into the summary.
  let noFinal = 0, noResult = 0, writeFail = 0;
  // Of the no-final plays, how many are past SETTLED_HOURS — i.e. their game is
  // certainly over, so the missing final is a defect and not a pending kickoff.
  let noFinalSettled = 0;
  // …and how many are so old that the absence is permanent (postponed or
  // cancelled), so they belong in neither the alarm nor the "not finished" bin.
  let unresolvable = 0;
  // Plays whose matchup matched two finals equally well — left pending on
  // purpose rather than graded against a guess.
  let ambiguousFinal = 0;
  // Plays whose matchup matched a final that is demonstrably the WRONG game —
  // a doubleheader with only game 1 final, or a kickoff too far from the
  // play's own. Same "decline to guess" treatment as ambiguousFinal: pending,
  // counted, kept out of the zero-graded alarm (D111 #1).
  let wrongSlot = 0;
  const settledFloor = Date.now() - SETTLED_HOURS * 3600_000;
  const unresolvableFloor = Date.now() - UNRESOLVABLE_DAYS * 86400_000;
  const now = new Date().toISOString();
  for (const p of pending) {
    const parts = String(p.matchup || '').split(' @ ');
    const awayName = norm(parts[0]), homeName = norm(parts[1]);
    const pick = pickFinal(finalsBySport[p.sport] || [], p, awayName, homeName, scheduleBySport[p.sport] || []);
    if (pick.ambiguous) {
      ambiguousFinal++;
      logger.warn('grading', `${p.matchup} matched two finals equally closely — left pending (${p.id})`);
      continue;
    }
    if (pick.wrongSlot) {
      wrongSlot++;
      logger.warn('grading', `${p.matchup} matched a final that is not this play's own game — left pending (${p.id})`);
      continue;
    }
    const f = pick.f;
    if (!f) {
      noFinal++;
      const logged = Date.parse(p.scored_at || p.created_at);
      if (logged < unresolvableFloor) unresolvable++;
      else if (logged < settledFloor) noFinalSettled++;
      continue;
    }
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
    // Same date-aware pick as the monitor_scores loop above: research_notes
    // carried the identical wrong-game-in-the-series bug, writing it into a
    // second track record.
    const pick = pickFinal(finalsBySport[p.sport] || [], p, awayName, homeName, scheduleBySport[p.sport] || []);
    if (pick.ambiguous) { ambiguousFinal++; continue; }
    if (pick.wrongSlot) { wrongSlot++; continue; }
    const f = pick.f;
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
  // The old test was "did ESPN return ANY finals for this play's sport" — true
  // every single day, because the sport's earlier games are always over by the
  // time the evening slate is logged. So three NHL plays on 7:00/8:00 PM games
  // that had not kicked off counted as "finals available" and the alarm fired
  // daily as a false positive (D105). Two populations can actually have been
  // gradeable:
  //   matchedFinal  — a final for the play's OWN matchup was on the scoreboard
  //                   (same matcher the grading loop above uses), so the data
  //                   demonstrably existed;
  //   noFinalSettled — no final found, but the play is past SETTLED_HOURS, so
  //                   its game is certainly over and the miss is ours or ESPN's.
  // A pre-kickoff play is in neither, which is the whole point. Two more
  // populations are deliberately OUTSIDE the alarm: `unresolvable` (no final on
  // any date and past UNRESOLVABLE_DAYS — a postponed game, which would
  // otherwise re-alarm every run until the 30-day write-off) and
  // `ambiguousFinal` (the data was there but could not be told apart, so the
  // grader declined to guess — a decision, not a failure). Both are in the
  // summary and in `data`, so neither disappears.
  const matchedFinal = graded + noResult + writeFail;
  const suspect = matchedFinal + noFinalSettled;
  if (suspect >= ZERO_ALARM_MIN && !total) {
    // Stated as fact, so it has to be true: name all three populations rather
    // than asserting "none matched" while one of them did.
    const why = `${matchedFinal} had their final on ESPN but produced no result`
      + `${noResult ? ` (${noResult} matched, stat/market unsupported or line missing)` : ''}`
      + `${writeFail ? ` (${writeFail} write failed)` : ''}`
      + `, ${noFinalSettled} are >${SETTLED_HOURS}h past logging with no ESPN final for their matchup`
      + `${noFinal - noFinalSettled - unresolvable ? `; ${noFinal - noFinalSettled - unresolvable} more have no final yet and are not counted (games not finished)` : ''}`
      + `${unresolvable ? `; ${unresolvable} are >${UNRESOLVABLE_DAYS}d old with no final on any date and are not counted (postponed or cancelled)` : ''}`
      + `${ambiguousFinal ? `; ${ambiguousFinal} matched two finals equally closely and were left pending rather than guessed` : ''}`
      + `${wrongSlot ? `; ${wrongSlot} matched a final that was not their own game (wrong kickoff, or an unfinished doubleheader game) and were left pending rather than guessed` : ''}`;
    logger.error('grading', `${suspect} plays should have been gradeable, 0 graded — ${why}`);
    reportDegraded('grading|zero', `${suspect} plays should have been gradeable but 0 graded — ${why}`);
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
  if (unresolvable) notes.push(`${unresolvable} unresolvable`);
  if (ambiguousFinal) notes.push(`${ambiguousFinal} ambiguous final`);
  if (wrongSlot) notes.push(`${wrongSlot} wrong slot`);
  if (noResult) notes.push(`${noResult} no result`);
  if (writeFail) notes.push(`${writeFail} write fail`);
  if (expired) notes.push(`${expired} expired`);

  return {
    summary: `graded ${graded} (${wins}W-${losses}L-${pushes}P)${extra.length ? ` ${extra.join(' ')}` : ''} · ${notes.join(', ')} · free ESPN`,
    data: {
      graded, wins, losses, pushes, research: rGraded, tennis: tGraded, ufc: uGraded,
      queued, noFinal, noResult, writeFail, expired,
      // The alarm's own populations, so a quiet run can be read without the
      // logs — including the three that are deliberately kept out of it.
      matchedFinal, noFinalSettled, unresolvable, ambiguousFinal, wrongSlot,
    },
  };
}

// Reused by the opportunity grader.
// pickFinal is exported for opp-grading, which flattens finals across its own
// date window and had the identical wrong-game defect (D110). Both are pure.
export { ESPN_PATH, profitPerUnit, ymd, norm, fetchFinals, gradePlay, pickFinal };

export default { name: 'grading', run };
