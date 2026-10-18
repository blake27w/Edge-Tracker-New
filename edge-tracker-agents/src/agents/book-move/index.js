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
// whenever the splits agent found nothing; the score simply loses that
// component, capping it near 80.
// Bias to know: `early` rewards distance from kickoff, so it leans
// toward origination. Late steam is also sharp, but late moves are the
// hardest to separate from public volume. Revisit with graded data.
// Observational reference only — these episodes do not feed plays.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, getIntel, setBookMoves } from '../../store/index.js';
import { median } from '../shared/odds-math.js';
import { LAND_PCT, crossedKey } from '../shared/key-numbers.js';

const WINDOW_H = Number(process.env.BOOK_MOVE_WINDOW_H) || 48;   // snapshot history per game
const MAX_GAMES = Number(process.env.BOOK_MOVE_MAX_GAMES) || 24; // hard cap on queries per run
const MIN_SCORE = Number(process.env.BOOK_MOVE_MIN_SCORE) || 35; // below this an episode is noise
const AGG_DAYS = 14;        // trailing window for the lead/follow scorecard
const MIN_EPISODES = 20;    // below this a book's role is bootstrap noise (disclosed as `small`)
const PUBLIC_HEAVY = 60;    // bets_pct at or above this counts as a public side
const LEAD_PCT_MAKER = 45;  // led_pct at or above this (with sample) reads as price-maker
const LEAD_PCT_FOLLOW = 20; // led_pct at or below this reads as follower

// Scoring weights — judgement, not measurement. Kept in one object so they can
// be retuned in a single place once there is a graded sample.
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
// Snapshots for one game+market, oldest first. Walk the batches (one per
// fetched_at), track each book's level, and emit one episode per change.
function episodesFor(g, market, snaps, pub, leadPrior) {
  const bySide = new Map();
  for (const s of snaps) {
    if (!s.side || s.line == null) continue;
    (bySide.get(s.side) || bySide.set(s.side, []).get(s.side)).push(s);
  }

  const out = [];
  for (const [side, rows] of bySide) {
    const byTs = new Map();
    for (const r of rows) (byTs.get(r.fetched_at) || byTs.set(r.fetched_at, []).get(r.fetched_at)).push(r);
    const stamps = [...byTs.keys()].sort();
    const last = new Map(); // book -> line we last saw it at

    for (const ts of stamps) {
      const batch = byTs.get(ts);
      const lines = batch.map((r) => Number(r.line)).filter(Number.isFinite);
      const consensus = lines.length ? median(lines) : null;

      for (const row of batch) {
        const book = row.book;
        const to = Number(row.line);
        if (!book || !Number.isFinite(to)) continue;
        const from = last.get(book);
        last.set(book, to);
        if (from == null || from === to) continue;

        // The book's own change stamp when the API gave us one — that is what
        // makes lead/follow measurable BELOW our fetch cadence. Never null:
        // the dedup key depends on it.
        const movedAt = row.last_update || ts;
        const moved = r1(to - from);

        // Rank among the books sitting at the NEW level in this batch, by their
        // own change stamps. 1 = first there.
        const atLevel = batch.filter((b) => Number(b.line) === to)
          .map((b) => ({ book: b.book, at: b.last_update || ts }))
          .sort((x, y) => String(x.at).localeCompare(String(y.at)));
        const lead_rank = atLevel.findIndex((b) => b.book === book) + 1 || null;
        const behind = batch.length - atLevel.length;
        const led = consensus != null && consensus !== to; // ahead of the field

        const commence = row.commence_time || g.commence_time || null;
        const hours = commence ? r1((new Date(commence).getTime() - new Date(movedAt).getTime()) / 3600_000) : null;

        // Key numbers are football-only, and spreads are judged on absolute points.
        const crossed = FOOTBALL.has(g.sport)
          ? (market === 'spreads' ? crossedKey(Math.abs(from), Math.abs(to)) : crossedKey(from, to))
          : null;

        const publicPct = pub ? pub.bets_pct : null;
        const vsPublic = againstPublic(g, market, side, moved, pub);

        const mag = Math.min(1, Math.abs(moved) / FULL_MOVE);
        const keyC = crossed ? (LAND_PCT[crossed] || 0) / TOP_KEY : 0;
        const early = hours == null ? 0.3 : Math.max(0, Math.min(1, hours / 24));
        const vsP = vsPublic === true ? 1 : 0;
        const prior = leadPrior.get(book);
        const lead = prior != null ? prior / 100 : 0.5;
        const score = Math.round(100 * (W.mag * mag + W.key * keyC + W.early * early + W.vsPublic * vsP + W.lead * lead) * 10) / 10;

        const reasons = [];
        if (crossed) reasons.push(`crossed ${crossed}`);
        if (led) reasons.push(behind > 0 ? `led field by ${behind} book${behind === 1 ? '' : 's'}` : 'led the field');
        if (vsPublic === true) reasons.push(`vs ${Math.round(publicPct)}% public`);
        if (Math.abs(moved) >= 1) reasons.push(`${moved > 0 ? '+' : ''}${moved} move`);
        if (hours != null && hours >= 12) reasons.push(`early (${Math.round(hours)}h out)`);

        out.push({
          sport: g.sport, game_id: g.game_id, commence_time: commence,
          matchup: `${g.away} @ ${g.home}`, market, side, book,
          line_from: from, line_to: to, moved,
          price_from: null, price_to: Number.isFinite(Number(row.price)) ? Math.round(Number(row.price)) : null,
          direction: to > from ? 'up' : 'down',
          moved_at: new Date(movedAt).toISOString(),
          lead_rank, led, hours_to_start: hours, crossed_key: crossed,
          public_pct: publicPct, vs_public: vsPublic, score, reasons,
        });
      }
    }
  }
  return out;
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
  if (!db.isConnected()) { setBookMoves(null); return { summary: 'skipped — no DB' }; }

  const now = Date.now();
  const slate = getGames()
    .filter((g) => {
      const t = g.commence_time ? new Date(g.commence_time).getTime() : NaN;
      return Number.isFinite(t) && t >= now - 3 * 3600_000 && t <= now + 24 * 3600_000;
    })
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, MAX_GAMES);
  if (!slate.length) { setBookMoves(null); return { summary: 'dormant — empty slate' }; }

  // Trailing history FIRST: its led_pct is the prior the `lead` component needs,
  // and the published scorecard is this history plus tonight's new episodes.
  let history = [];
  const aggSince = new Date(now - AGG_DAYS * 86400_000).toISOString();
  try {
    history = await db.select('book_move_log', 'book,led,moved,crossed_key,vs_public',
      { gte: { detected_at: aggSince }, order: { column: 'detected_at', ascending: false }, limit: 20000 });
  } catch (e) { logger.warn('book-move', `book_move_log read failed: ${e.message}`); }

  const priorAcc = {};
  for (const ep of history) { if (ep.book) tally((priorAcc[ep.book] ||= acc()), ep); }
  const leadPrior = new Map();
  for (const [book, a] of Object.entries(priorAcc)) {
    if (a.n >= MIN_EPISODES) { const p = pct(a.led, a.n); if (p != null) leadPrior.set(book, p); }
  }

  const pubIdx = await publicIndex();
  const since = new Date(now - WINDOW_H * 3600_000).toISOString();
  const episodes = [];
  for (const g of slate) {
    for (const market of marketsFor(g.sport)) {
      let snaps = [];
      try {
        // DESC + limit, reversed in JS: ASC + limit would truncate the NEWEST rows.
        snaps = await db.select('line_snapshots', 'book,market,side,line,price,fetched_at,last_update,commence_time', {
          match: { game_id: g.game_id, market },
          gte: { fetched_at: since },
          order: { column: 'fetched_at', ascending: false },
          limit: 1500,
        });
      } catch (e) { logger.warn('book-move', `snapshot read failed for ${g.game_id}/${market}: ${e.message}`); continue; }
      if (snaps.length < 2) continue;
      snaps.reverse();
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
    const k = `${ep.game_id}|${ep.market}|${ep.side}|${ep.book}|${ep.line_to}|${ep.moved_at}`;
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

  const agg = {};
  for (const ep of history) { if (ep.book) tally((agg[ep.book] ||= acc()), ep); }
  for (const ep of scored) tally((agg[ep.book] ||= acc()), ep);
  const byBook = Object.entries(agg).map(([book, a]) => fin(book, a))
    .sort((x, y) => (Number(!y.small) - Number(!x.small)) || ((y.led_pct ?? -1) - (x.led_pct ?? -1)) || (y.n - x.n));

  const live = scored.slice(0, 40).map((ep) => ({ ...ep, label: config.BOOK_LABELS[ep.book] || ep.book }));
  const makers = byBook.filter((b) => b.role === 'market-maker').length;
  const vsPublicN = scored.filter((ep) => ep.vs_public === true).length;

  setBookMoves({
    updated: new Date().toISOString(), window_h: WINDOW_H, max_games: MAX_GAMES,
    min_score: MIN_SCORE, games: slate.length, live, byBook,
    note: 'public % is MARKET-WIDE (no per-book splits exist); US retail books only — this measures who moves first, not who sharps bet.',
  });

  return {
    summary: `${live.length} scored moves · ${byBook.length} books · ${makers} market-makers · ${vsPublicN} vs-public`,
    data: { episodes: scored.length, books: byBook.length, makers, vsPublic: vsPublicN, games: slate.length },
  };
}

export default { name: 'book-move', run };
