// ══════════════════════════════════════════════════════════════
// Book Movement Attribution — WHICH book moved, which way, how far,
// and whether it led or followed the field. We already store every
// book's number on every market every run; nothing read it back.
//
// $0 BY CONSTRUCTION. This agent makes no Odds API call of any kind:
// its only inputs are the in-memory slate (getGames()), the in-memory
// public splits (getIntel('splits')) and bounded reads of our own
// line_snapshots. There is deliberately no network call in this file.
//
// Cost control: one snapshot query per game × market, keyed on game_id
// so it rides line_snapshots_game_idx (game_id, market, fetched_at desc),
// over a slate capped at MAX_GAMES. Sides are filtered in JS so the
// index prefix stays a full equality match.
//
// WHAT THIS CAN CONCLUDE: that a book moved first or last, far or little,
// early or late, and with or against market-wide public tickets — and,
// aggregated over 14 days, which books behave like price-makers.
// WHAT IT CANNOT: that a book is "getting hit by sharps". Our book list
// is 11 licensed US RETAIL books — no offshore originator, no exchange.
// None of them originates price, so the lead metric measures who copies
// the true market fastest. That is a real speed signal; it is not proof
// of sharp action at that book.
// `public_pct` is MARKET-WIDE (public_splits has no book column — a
// per-book public split is not derivable from our data and this agent
// does not pretend to one). It is null outside NHL/NBA/MLB/NFL and
// whenever the splits agent found nothing.
//
// SCORING IS RENORMALIZED over the components that actually have data:
// a missing input (no public coverage; key numbers on a market they
// cannot apply to) must be NEUTRAL, not adverse. Dividing by the fixed
// weight total instead capped whole sports below MIN_SCORE and built
// every book's stats from a biased subsample.
// Key numbers are SPREADS-ONLY: KEYS are football margin numbers (3/7/4/
// 6/14/17/10) and an NFL total is 30-60, so no total can ever cross one.
// A totals key table is a modelling question, not a patch — deferred.
//
// ONE EPISODE PER LINE MOVE. odds/index.js writes a snapshot row per
// outcome, so a single spread move lands twice (Chiefs −3→−3.5 AND
// Broncos +3→+3.5). We score the canonical side only (home team for
// spreads, Over for totals); the mirror side's line is just the negation
// and is never persisted.
//
// Bias to know: `early` rewards distance from kickoff, so it leans
// toward origination. Late steam is also sharp, but late moves are the
// hardest to separate from public volume. Revisit with graded data.
// Observational reference only — these episodes do not feed plays.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, getIntel, setBookMoves } from '../../store/index.js';
import { LAND_PCT, crossedKey } from '../shared/key-numbers.js';

const WINDOW_H = Number(process.env.BOOK_MOVE_WINDOW_H) || 48;   // snapshot history requested per game
const MAX_GAMES = Number(process.env.BOOK_MOVE_MAX_GAMES) || 24; // hard cap on queries per run
const MIN_SCORE = Number(process.env.BOOK_MOVE_MIN_SCORE) || 35; // below this an episode is noise
const SNAP_LIMIT = 1500;    // rows per snapshot query — the real cost ceiling, see window_h below
const AGG_DAYS = 14;        // trailing window for the lead/follow scorecard
const MIN_EPISODES = 20;    // below this a book's role is bootstrap noise (disclosed as `small`)
const PUBLIC_HEAVY = 60;    // bets_pct at or above this counts as a public side
const LEAD_PCT_MAKER = 45;  // led_pct at or above this (with sample) reads as price-maker
const LEAD_PCT_FOLLOW = 20; // led_pct at or below this reads as follower
const CLUSTER_MS = 6 * 3600_000; // arrivals at one level further apart than this are separate moves

// Scoring weights — judgement, not measurement. Kept in one object so they can
// be retuned in a single place once there is a graded sample. The denominator
// is the sum of the weights that APPLIED, never the sum of all five.
const W = { mag: 0.30, key: 0.20, early: 0.15, vsPublic: 0.20, lead: 0.15 };
const FULL_MOVE = 1.5;      // a 1.5pt move earns full magnitude credit
const TOP_KEY = LAND_PCT[3]; // the most valuable key number, = full key credit

const FOOTBALL = new Set(['NFL', 'NCAAF']);
// Run/puck-line sports hang a fixed ±1.5 spread — their movement lives in the
// PRICE, not the line, so a "line move" there is a sign flip or an alt line.
// Same guard as book-edges. They contribute totals only.
const FIXED_RUNLINE = new Set(['MLB', 'NHL']);
const MARKETS = ['spreads', 'totals'];

const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
const sur = (t) => String(t || '').toLowerCase().split(' ').pop();

// The table's unique key, normalized so a row read back from Postgres
// ('…+00:00', numeric line) keys identically to one we just derived ('…Z').
const epKey = (ep) => `${ep.game_id}|${ep.market}|${ep.side}|${ep.book}|${Number(ep.line_to)}|${Date.parse(ep.moved_at)}`;

// Which markets we can read movement from for this sport.
function marketsFor(sport) {
  return FIXED_RUNLINE.has(sport) ? ['totals'] : MARKETS;
}

// ── Public context (market-wide, never per book) ─────────────────
// public_splits stores market as spread|total|ml; snapshots use spreads|totals.
const SPLIT_MARKET = { spreads: 'spread', totals: 'total' };

// Resolve the public side to over/under/home/away against the real team names.
// Mirrors the resolver the splits agent uses (surname included) so a
// team-named side doesn't fall through.
function resolveSide(g, mk, side) {
  const s = String(side || '').toLowerCase();
  if (mk === 'total') return s.includes('over') ? 'over' : s.includes('under') ? 'under' : null;
  if (s.includes('home')) return 'home';
  if (s.includes('away')) return 'away';
  if (g) {
    if (s.includes(String(g.home).toLowerCase()) || s.includes(sur(g.home))) return 'home';
    if (s.includes(String(g.away).toLowerCase()) || s.includes(sur(g.away))) return 'away';
  }
  return null;
}

// Newest heavy-public row per game|market, from the in-memory store when the
// splits agent has run this process, else ONE bounded DB read as a fallback.
async function publicIndex() {
  let rows = getIntel('splits');
  if (!rows.length && db.isConnected()) {
    const since = new Date(Date.now() - 12 * 3600_000).toISOString();
    try {
      rows = await db.select('public_splits', 'game_id,market,side,bets_pct,handle_pct,fetched_at', {
        gte: { fetched_at: since }, order: { column: 'fetched_at', ascending: false }, limit: 2000,
      });
    } catch (e) { logger.warn('book-move', `public_splits read failed: ${e.message}`); rows = []; }
  }
  const idx = new Map();
  for (const r of rows) {
    if (!r || !r.game_id || !r.market) continue;
    const bets = Number(r.bets_pct);
    if (!Number.isFinite(bets) || bets < PUBLIC_HEAVY) continue;
    const k = `${r.game_id}|${r.market}`;
    const prev = idx.get(k);
    // getIntel order is write order (newest run); the DB fallback is DESC. Keep
    // the first row seen unless an explicit stamp says another is newer.
    if (prev && !(r.fetched_at && prev.fetched_at && r.fetched_at > prev.fetched_at)) continue;
    idx.set(k, { side: r.side, bets_pct: bets, handle_pct: Number(r.handle_pct), fetched_at: r.fetched_at });
  }
  return idx;
}

// Did THIS move hand the public side a better number? Books never gift the
// crowd, so if the heavy side's own number improved, the money is on the other
// side. Same direction rules the splits agent judges RLM with.
//   totals : Over backers are gifted by the total DROPPING, Under by it rising.
//   spreads: a side's own line RISING = its backers get more points = gifted.
// null = no public data, or the public side could not be resolved.
function againstPublic(g, market, side, moved, pub) {
  if (!pub || moved == null || !moved) return null;
  const mk = SPLIT_MARKET[market];
  const resolved = resolveSide(g, mk, pub.side);
  if (!resolved) return null;
  if (mk === 'total') {
    if (resolved === 'over') return moved < 0;
    if (resolved === 'under') return moved > 0;
    return null;
  }
  // Spread: `side` is the team whose line moved. If it IS the public team its
  // line rising is the gift; if it's the opponent, the public team's own number
  // moved the other way.
  const s = String(side || '').toLowerCase();
  const isHome = s.includes(String(g.home).toLowerCase()) || s === sur(g.home);
  const isAway = s.includes(String(g.away).toLowerCase()) || s === sur(g.away);
  if (!isHome && !isAway) return null;
  const sideIsPublic = (resolved === 'home' && isHome) || (resolved === 'away' && isAway);
  return sideIsPublic ? moved > 0 : moved < 0;
}

// ── Episode detection ───────────────────────────────────────────

// The one side we score for this game+market. Every line move is written twice
// (one snapshot row per outcome) and both halves score identically, so scoring
// both doubles every card and every `n`. Home team for spreads, Over for
// totals; an unrecognizable feed label falls back to the lexicographically
// first side so we still emit exactly one episode per move.
function canonicalSide(g, market, sides) {
  if (!sides.length) return null;
  const sorted = [...sides].sort();
  if (market === 'totals') return sorted.find((s) => String(s).toLowerCase().includes('over')) || sorted[0];
  const home = String(g.home || '').toLowerCase();
  const hs = sur(g.home);
  return sorted.find((s) => {
    const x = String(s).toLowerCase();
    return !!home && (x === home || x.includes(home) || (!!hs && x === hs));
  }) || sorted[0];
}

// `last_update` is the Odds API's MARKET-level stamp: it is bumped by a
// price-only change and is SHARED by both outcomes of that book's market, so it
// can sit well outside the interval in which THIS line move could have
// happened. We cannot tell a price-only bump from a line move from this data
// and do not try — we only refuse to let an unplaceable stamp reorder the
// leaderboard or inflate hours_to_start. A stamp inside (prevTs, ts] is
// evidence and is used; anything else falls back to the batch stamp, so
// ordering then comes from batch order alone.
function clampStamp(lastUpdate, prevTs, ts) {
  const hi = Date.parse(ts);
  const lo = prevTs ? Date.parse(prevTs) : NaN;
  const lu = lastUpdate ? Date.parse(lastUpdate) : NaN;
  if (Number.isFinite(lu) && Number.isFinite(hi) && lu <= hi && (!Number.isFinite(lo) || lu > lo)) {
    return new Date(lu).toISOString();
  }
  return new Date(Number.isFinite(hi) ? hi : Date.now()).toISOString();
}

// Arrival order: the batch we saw the move in is authoritative; the book's own
// (clamped) stamp only separates books INSIDE one batch.
function cmpArrival(a, b) {
  return (a._bi - b._bi) || String(a._at).localeCompare(String(b._at)) || String(a.book).localeCompare(String(b.book));
}
const strictlyBefore = (a, b) => a._bi < b._bi || (a._bi === b._bi && a._at < b._at);

// Snapshots for one game+market, oldest first. Walk the batches (one per
// fetched_at), track each book's level, and emit one episode per change.
function episodesFor(g, market, snaps, pub, leadPrior) {
  const sides = new Set();
  for (const s of snaps) if (s.side && s.line != null) sides.add(s.side);
  const side = canonicalSide(g, market, [...sides]);
  if (!side) return [];

  const byTs = new Map();
  for (const r of snaps) {
    if (r.side !== side || r.line == null) continue;
    (byTs.get(r.fetched_at) || byTs.set(r.fetched_at, []).get(r.fetched_at)).push(r);
  }
  const stamps = [...byTs.keys()].sort();
  const last = new Map();     // book -> line we last saw it at
  const lastTs = new Map();   // book -> batch we last saw it in (the clamp floor)
  const out = [];

  for (let bi = 0; bi < stamps.length; bi++) {
    const ts = stamps[bi];
    for (const row of byTs.get(ts)) {
      const book = row.book;
      const to = Number(row.line);
      if (!book || !Number.isFinite(to)) continue;
      const from = last.get(book);
      const prevTs = lastTs.get(book);
      last.set(book, to);
      lastTs.set(book, ts);
      if (from == null || from === to) continue;

      const movedAt = clampStamp(row.last_update, prevTs, ts);
      const moved = r1(to - from);
      const commence = row.commence_time || g.commence_time || null;
      const hours = commence ? r1((new Date(commence).getTime() - Date.parse(movedAt)) / 3600_000) : null;

      // Key numbers are football SPREADS only — see header. A total can never
      // cross 3/7/4/6/14/17/10, so the component simply does not apply there.
      const keyApplies = FOOTBALL.has(g.sport) && market === 'spreads';
      const crossed = keyApplies ? crossedKey(Math.abs(from), Math.abs(to)) : null;

      const publicPct = pub ? pub.bets_pct : null;
      const vsPublic = againstPublic(g, market, side, moved, pub);

      // Renormalized score: only the components with data enter the weighted
      // sum AND the denominator, so a missing input is neutral.
      const prior = leadPrior.get(book);
      const parts = [
        [W.mag, Math.min(1, Math.abs(moved) / FULL_MOVE)],
        [W.early, hours == null ? 0.3 : Math.max(0, Math.min(1, hours / 24))],
        [W.lead, prior != null ? prior / 100 : 0.5],
      ];
      if (keyApplies) parts.push([W.key, crossed ? (LAND_PCT[crossed] || 0) / TOP_KEY : 0]);
      if (vsPublic != null) parts.push([W.vsPublic, vsPublic ? 1 : 0]);
      const wSum = parts.reduce((s, [w]) => s + w, 0);
      const score = Math.round(100 * (parts.reduce((s, [w, v]) => s + w * v, 0) / wSum) * 10) / 10;

      out.push({
        sport: g.sport, game_id: g.game_id, commence_time: commence,
        matchup: `${g.away} @ ${g.home}`, market, side, book,
        line_from: from, line_to: to, moved,
        price_from: null,
        price_to: row.price != null && Number.isFinite(Number(row.price)) ? Math.round(Number(row.price)) : null,
        direction: to > from ? 'up' : 'down',
        moved_at: movedAt,
        lead_rank: null, led: false, hours_to_start: hours, crossed_key: crossed,
        public_pct: publicPct, vs_public: vsPublic, score, reasons: [],
        _bi: bi, _at: movedAt,
      });
    }
  }

  rankLevels(out);
  for (const ep of out) {
    const reasons = [];
    if (ep.crossed_key) reasons.push(`crossed ${ep.crossed_key}`);
    if (ep.led) reasons.push(ep._behind > 0 ? `led field by ${ep._behind} book${ep._behind === 1 ? '' : 's'}` : 'led the field');
    if (ep.vs_public === true) reasons.push(`vs ${Math.round(ep.public_pct)}% public`);
    if (Math.abs(ep.moved) >= 1) reasons.push(`${ep.moved > 0 ? '+' : ''}${ep.moved} move`);
    if (ep.hours_to_start != null && ep.hours_to_start >= 12) reasons.push(`early (${Math.round(ep.hours_to_start)}h out)`);
    ep.reasons = reasons;
    delete ep._bi; delete ep._at; delete ep._behind;
  }
  return out;
}

// `led` = among the books that reached THIS line level MOVING THE SAME WAY in
// this move, this book got there first. It is false when no other book reached
// the level (there was no field to lead) and false when the first two arrivals
// cannot be separated — a tie is not a lead. This feeds led_pct → role → the
// next run's leadPrior, so a sign error here compounds; it is deliberately NOT
// "differs from the batch median", which credits a book for moving AWAY from
// the field.
//
// Direction is part of the grouping key, not just the level: two books
// converging on -3.5 from opposite sides (one drifting -3 → -3.5, one -4 →
// -3.5) are not participating in the same market move, and ranking them
// against each other credited whichever happened to arrive first with a lead
// it never earned — which inflated led_pct on choppy markets.
function rankLevels(eps) {
  const byLevel = new Map();
  for (const e of eps) {
    const k = `${e.line_to}|${e.direction}`;
    (byLevel.get(k) || byLevel.set(k, []).get(k)).push(e);
  }
  for (const arr of byLevel.values()) {
    arr.sort(cmpArrival);
    // A level can be revisited (3 → 3.5 → 3). Arrivals far apart in time are
    // separate moves and must not be ranked against each other.
    let cluster = [];
    const flush = () => {
      for (let i = 0; i < cluster.length; i++) {
        cluster[i].lead_rank = i + 1;
        cluster[i]._behind = cluster.length - (i + 1);
        cluster[i].led = i === 0 && cluster.length > 1 && strictlyBefore(cluster[0], cluster[1]);
      }
      cluster = [];
    };
    for (const e of arr) {
      if (cluster.length && Date.parse(e._at) - Date.parse(cluster[cluster.length - 1]._at) > CLUSTER_MS) flush();
      cluster.push(e);
    }
    flush();
  }
}

// ── 14-day lead/follow scorecard, derived from the episode log ───
// Book reputation is NEVER hardcoded: our book list changes, none of these
// books deserves a maker prior, and a derived table self-corrects and is
// auditable where a baked-in one would silently go stale.
function acc() { return { n: 0, led: 0, movedSum: 0, movedN: 0, key: 0, vsN: 0, vsTrue: 0 }; }

function tally(a, ep) {
  a.n++;
  if (ep.led) a.led++;
  const m = Number(ep.moved);
  if (Number.isFinite(m)) { a.movedSum += Math.abs(m); a.movedN++; }
  if (ep.crossed_key != null) a.key++;
  if (ep.vs_public != null) { a.vsN++; if (ep.vs_public) a.vsTrue++; }
}

function fin(book, a) {
  const led_pct = pct(a.led, a.n);
  const small = a.n < MIN_EPISODES;
  const role = led_pct != null && led_pct >= LEAD_PCT_MAKER && !small ? 'market-maker'
    : led_pct != null && led_pct <= LEAD_PCT_FOLLOW ? 'follower' : 'mixed';
  return {
    book, label: config.BOOK_LABELS[book] || book,
    n: a.n, led_pct, follow_pct: led_pct == null ? null : Math.round((100 - led_pct) * 10) / 10,
    avg_moved: a.movedN ? Math.round((a.movedSum / a.movedN) * 100) / 100 : null,
    key_cross_n: a.key, vs_public_n: a.vsN, vs_public_pct: pct(a.vsTrue, a.vsN),
    role, small,
  };
}

async function run() {
  // A missing DB or an empty slate is not evidence that the 14-day scorecard is
  // wrong — nulling the store here would erase it from the PWA and flap on the
  // 15-min cadence. Leave the last published payload standing.
  if (!db.isConnected()) return { summary: 'skipped — no DB' };

  const now = Date.now();
  const inWindow = [];
  for (const g of getGames()) {
    const t = g.commence_time ? new Date(g.commence_time).getTime() : NaN;
    if (Number.isFinite(t) && t >= now - 3 * 3600_000 && t <= now + 24 * 3600_000) inWindow.push({ g, t });
  }
  // Pre-game movement is the whole point, so upcoming kickoffs claim the cap
  // first; in-progress games (started up to 3h ago) only fill what is left,
  // freshest first.
  const upcoming = inWindow.filter((x) => x.t >= now).sort((a, b) => a.t - b.t);
  const started = inWindow.filter((x) => x.t < now).sort((a, b) => b.t - a.t);
  const slate = [...upcoming, ...started].slice(0, MAX_GAMES).map((x) => x.g);
  if (!slate.length) return { summary: 'dormant — empty slate' };

  // Trailing history FIRST: its led_pct is the prior the `lead` component needs,
  // and it is also the scorecard's base — one source of truth, the persisted log.
  let history = [];
  const aggSince = new Date(now - AGG_DAYS * 86400_000).toISOString();
  try {
    history = await db.select('book_move_log', 'book,led,moved,crossed_key,vs_public,game_id,market,side,line_to,moved_at',
      { gte: { detected_at: aggSince }, order: { column: 'detected_at', ascending: false }, limit: 20000 });
  } catch (e) { logger.warn('book-move', `book_move_log read failed: ${e.message}`); }

  const agg = {};
  for (const ep of history) { if (ep.book) tally((agg[ep.book] ||= acc()), ep); }
  const leadPrior = new Map();
  for (const [book, a] of Object.entries(agg)) {
    if (a.n >= MIN_EPISODES) { const p = pct(a.led, a.n); if (p != null) leadPrior.set(book, p); }
  }

  const pubIdx = await publicIndex();
  const since = new Date(now - WINDOW_H * 3600_000).toISOString();
  const episodes = [];
  let obsMin = null, obsMax = null, truncated = 0;
  for (const g of slate) {
    for (const market of marketsFor(g.sport)) {
      let snaps = [];
      try {
        // DESC + limit, reversed in JS: ASC + limit would truncate the NEWEST rows.
        snaps = await db.select('line_snapshots', 'book,market,side,line,price,fetched_at,last_update,commence_time', {
          match: { game_id: g.game_id, market },
          gte: { fetched_at: since },
          order: { column: 'fetched_at', ascending: false },
          limit: SNAP_LIMIT,
        });
      } catch (e) { logger.warn('book-move', `snapshot read failed for ${g.game_id}/${market}: ${e.message}`); continue; }
      if (snaps.length < 2) continue;
      if (snaps.length >= SNAP_LIMIT) truncated++;
      snaps.reverse();
      // SNAP_LIMIT, not WINDOW_H, is the real coverage: ~22 rows/batch for
      // spreads (11 books × 2 sides) means 1500 rows is only a few hours. We
      // re-scan every 15 min so no episode is missed, but the payload must
      // report the window we actually read, not the one we asked for.
      const oldest = Date.parse(snaps[0].fetched_at);
      if (Number.isFinite(oldest)) {
        const h = (now - oldest) / 3600_000;
        obsMin = obsMin == null ? h : Math.min(obsMin, h);
        obsMax = obsMax == null ? h : Math.max(obsMax, h);
      }
      const pub = pubIdx.get(`${g.game_id}|${SPLIT_MARKET[market]}`) || null;
      episodes.push(...episodesFor(g, market, snaps, pub, leadPrior));
    }
  }

  // One row per (game, market, side, book, line_to, moved_at) — the same key the
  // table is unique on, so a re-scan of the window never duplicates an episode.
  const seen = new Set();
  const scored = [];
  for (const ep of episodes) {
    if (ep.score < MIN_SCORE) continue;
    const k = epKey(ep);
    if (seen.has(k)) continue;
    seen.add(k);
    scored.push(ep);
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length) {
    try {
      await db.upsert('book_move_log', scored, 'game_id,market,side,book,line_to,moved_at', { ignoreDuplicates: true });
    } catch (e) { logger.warn('book-move', e.message); }
  }

  // The scorecard is the persisted log, counted once. `history` already holds
  // the episodes the runs 15/30/45 min ago wrote and this run re-derives the
  // same window, so only genuinely new keys are added on top. Tallying all of
  // `scored` as well cleared MIN_EPISODES on half the real evidence.
  const logged = new Set(history.map(epKey));
  for (const ep of scored) { if (ep.book && !logged.has(epKey(ep))) tally((agg[ep.book] ||= acc()), ep); }
  const byBook = Object.entries(agg).map(([book, a]) => fin(book, a))
    .sort((x, y) => (Number(!y.small) - Number(!x.small)) || ((y.led_pct ?? -1) - (x.led_pct ?? -1)) || (y.n - x.n));

  const live = scored.slice(0, 40).map((ep) => ({ ...ep, label: config.BOOK_LABELS[ep.book] || ep.book }));
  const makers = byBook.filter((b) => b.role === 'market-maker').length;
  const vsPublicN = scored.filter((ep) => ep.vs_public === true).length;

  setBookMoves({
    updated: new Date().toISOString(),
    window_h: r1(obsMin), window_h_max: r1(obsMax), window_h_requested: WINDOW_H,
    truncated_queries: truncated, max_games: MAX_GAMES,
    min_score: MIN_SCORE, games: slate.length, live, byBook,
    note: 'public % is MARKET-WIDE (no per-book splits exist); US retail books only — this measures who moves first, not who sharps bet.',
  });

  return {
    summary: `${live.length} scored moves · ${byBook.length} books · ${makers} market-makers · ${vsPublicN} vs-public`,
    data: { episodes: scored.length, books: byBook.length, makers, vsPublic: vsPublicN, games: slate.length },
  };
}

export default { name: 'book-move', run };
