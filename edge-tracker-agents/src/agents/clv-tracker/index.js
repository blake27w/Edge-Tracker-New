// ══════════════════════════════════════════════════════════════
// CLV Tracker — measures closing-line value, the north-star metric.
// For each qualifying play it compares the ENTRY line (the number the
// play was logged at, when it qualified) to the CLOSING line (the latest
// market snapshot, captured near game start). The two MUST come from
// different snapshot batches at different times — capturing "closing" too
// early (right after entry) was the bug that made every play read X→X /
// +0 CLV.
//
// Guarantees:
//   • Closing is only recorded once the game is at/near start (≥ commence −
//     CLOSE_LEAD), so the latest snapshot is genuinely the close.
//   • entry_at and close_at are stored, and must be distinct batches — a play
//     with only one snapshot batch is unmeasurable and is NOT persisted.
//   • `suspect` means the latest batch we hold predates the close window, so
//     what we're calling the close probably isn't it.
//   • Exactly one clv_record per play (upsert on game_id+market+side).
//   • Line CLV (totals/spreads) AND odds CLV (moneylines) from the
//     consensus of each snapshot batch.
//   • The coverage alarm counts only plays that COULD have had a close: a
//     pre-game play, in a CLV-tracked market, on a sport whose close is
//     captured, with a known kickoff. In-play bets (`monitor_scores.live`),
//     props, TENNIS while TENNIS_CLOSE_CAPTURE is off, and null-commence
//     games are each reported under their own count and never read as a
//     snapshot-coverage defect (D98).
//
// Three bugs made this report "0 beat close, N suspect" indefinitely:
//
//   1. The snapshot query was `order fetched_at ASC, limit 1000`. A game that
//      sits on the board for a week has far more than 1000 rows for one
//      market/side (≈8 books × a batch every 3 min ≈ 6 hours of coverage), so
//      the window returned the EARLIEST batches and the actual close was
//      truncated away. The play was then scored later than every row returned,
//      the "nearest" entry batch WAS the last one, entry === close, and the
//      record was flagged suspect with clv 0. The close is now fetched with a
//      descending query so it can never be truncated.
//
//   2. The entry batch was the batch NEAREST scored_at in either direction,
//      which can legitimately be the closing batch itself. Entry is now the
//      last batch at or BEFORE scored_at — the number we could actually have
//      bet.
//
//   3. beat_close looked only at the LINE. On a spread or total that didn't
//      move, that scores every bet as "did not beat the close" even when the
//      price on that number improved — which is most of a spread/total record.
//      Both are now measured: `clv` (line points) and `clv_odds` (points of
//      implied probability), with price breaking a flat-line tie. When neither
//      is knowable, beat_close is NULL (unknown) rather than false, and the
//      report excludes unknowns from beat_pct instead of counting them as
//      losses.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { setClvReport, reportDegraded } from '../../store/index.js';
import { impliedProb, median } from '../shared/odds-math.js';

const LOOKBACK_MS = (Number(process.env.CLV_LOOKBACK_DAYS) || 4) * 86400_000;
const CLOSE_LEAD_MS = 20 * 60_000;   // start capturing the close ~20 min before first pitch/kick
const REPORT_DAYS = Number(process.env.CLV_REPORT_DAYS) || 90;
const SNAP_MARKET = { total: 'totals', spread: 'spreads', ml: 'h2h' };
const BATCH_LIMIT = Number(process.env.CLV_BATCH_LIMIT) || 400;   // entry-probe rows
// The close needs only the newest pre-kickoff batch. Bounded server-side, a
// small window is enough and keeps the payload far below the old 400 rows.
const CLOSE_ROWS = Number(process.env.CLV_CLOSE_ROWS) || 120;
// Minimum sample before "none of these beat the close" is read as a defect
// rather than as an ordinary losing stretch. Losing CLV on three bets is a
// Tuesday; losing it on thirty straight is a bug.
const ALARM_MIN = Number(process.env.CLV_ALARM_MIN) || 12;

// Median line + price across the books in one snapshot batch (same fetched_at).
// NOTE the explicit null guard: `Number(null)` is 0 and 0 IS finite, so mapping
// before filtering turned every missing price into odds of 0 — an impossible
// American price that then dragged the median and produced a confident-looking
// but fabricated clv_odds. A missing price has to stay missing.
const nums = (rows, key) => rows
  .filter((r) => r[key] !== null && r[key] !== undefined && r[key] !== '')
  .map((r) => Number(r[key]))
  .filter(Number.isFinite);

function batchConsensus(rows) {
  const lines = nums(rows, 'line');
  const prices = nums(rows, 'price');
  return { line: lines.length ? median(lines) : null, price: prices.length ? Math.round(median(prices)) : null };
}

// Group snapshot rows into batches keyed by capture time (one INSERT per odds
// poll → Postgres now() is the statement timestamp, so fetched_at is identical
// across a batch).
function batches(rows) {
  const byTs = new Map();
  for (const s of rows) { const k = s.fetched_at; (byTs.get(k) || byTs.set(k, []).get(k)).push(s); }
  return byTs;
}
// Newest batch timestamp in a group, compared as instants (the column's text
// form is uniform, but don't rely on lexicographic order for time).
function newestTs(byTs) {
  let best = null, bestMs = -Infinity;
  for (const k of byTs.keys()) { const ms = new Date(k).getTime(); if (ms > bestMs) { bestMs = ms; best = k; } }
  return best;
}

// Build a CLV record for one play. Returns null ONLY when it is too early (the
// close window has not opened); every permanent outcome carries a marker so
// the caller can count it for what it is: `{ untracked }` for a market with
// no snapshot feed (props), `{ unmeasurable, noCommence }` when the game has
// no kickoff to bound the close by, `{ unmeasurable }` otherwise.
async function capture(p) {
  const snapMarket = SNAP_MARKET[p.market];
  // Not "too early" — there is no line_snapshots market for this play and
  // never will be. Reported as null for months, these read as a perpetually
  // pending close.
  if (!snapMarket || !p.side) return { untracked: true };

  const where = { game_id: p.game_id, market: snapMarket, side: p.side };
  const cols = 'commence_time,fetched_at,line,price';

  // THE ENTRY, first: the last batch at or BEFORE the play was logged — the
  // number we could actually have bet. It is queried first because it also
  // yields commence_time, which the close query needs as a server-side bound
  // (see below). Still two queries per play, not three.
  const entryAt = new Date(p.scored_at).getTime();
  let early = [];
  try {
    early = await db.select('line_snapshots', cols, {
      match: where, lte: { fetched_at: new Date(entryAt).toISOString() },
      order: { column: 'fetched_at', ascending: false }, limit: BATCH_LIMIT,
    });
  } catch (e) { return { error: `entry query: ${e.message}` }; }

  // No batch at or before the play. No batch ever will be — snapshots only
  // move forward — so this is permanently unmeasurable, not merely early.
  if (!early.length) return { unmeasurable: true };

  const commence = early.find((s) => s.commence_time)?.commence_time;
  // No kickoff on any entry row → the close query below has no upper bound,
  // so the newest batch we hold — which can be in-play — would be taken as
  // "the close", and `done` would then lock that fabricated CLV in. With no
  // kickoff there is no close to find; say so instead of guessing one.
  if (!commence) return { unmeasurable: true, noCommence: true };
  const commenceMs = new Date(commence).getTime();

  // Don't record until the game is at/near start — otherwise "closing" is just
  // an early snapshot ≈ entry (the original bug).
  if (Date.now() < commenceMs - CLOSE_LEAD_MS) return null;

  // THE CLOSE: newest batch AT OR BEFORE KICKOFF, bounded IN THE QUERY.
  //
  // The bound has to be server-side. Filtering a `limit`-ed window down to
  // pre-kickoff rows afterwards reintroduces bug 1 in a new place: the odds
  // feed keeps quoting a game once it is underway and we hold it until
  // commence + 6h, so at ~10 books and a 3-minute cadence a game can
  // accumulate well over a hundred in-play batches. Every row in the window
  // is then in-play, the filter empties it, and the play is dropped as
  // unmeasurable while the real closing batch sits just past the limit.
  // Same shape as the original fault — the window taken before the predicate
  // is applied.
  //
  // Bounding server-side also guarantees the newest returned batch is
  // COMPLETE rather than clipped at the window edge, so the consensus median
  // is over every book that quoted it and not an arbitrary subset.
  // The bound is unconditional: a play with no kickoff never reaches here.
  const closeOpts = {
    match: where, lte: { fetched_at: commence },
    order: { column: 'fetched_at', ascending: false }, limit: CLOSE_ROWS,
  };
  let late = [];
  try { late = await db.select('line_snapshots', cols, closeOpts); }
  catch (e) { return { error: `close query: ${e.message}` }; }
  // Only in-play snapshots exist for this game — no pre-kickoff close to
  // measure against, and we will not substitute a live number for one.
  if (!late.length) return { unmeasurable: true };

  const lateB = batches(late);
  const closeTs = newestTs(lateB);

  const earlyB = batches(early);
  const entryTs = newestTs(earlyB);

  // Entry at or after the close means there is nothing to measure: either only
  // one batch exists, or the play was logged after kickoff. A live bet has no
  // closing-line value against a close that happened before it was placed —
  // excluding it is correct, not a gap.
  if (!entryTs || new Date(entryTs).getTime() >= new Date(closeTs).getTime()) return { unmeasurable: true };

  const entry = batchConsensus(earlyB.get(entryTs));
  const close = batchConsensus(lateB.get(closeTs));

  // Prefer the actually-logged entry line (what we'd have bet); fall back to the
  // entry snapshot consensus if the play didn't store one.
  const lineEntry = p.line != null ? Number(p.line) : entry.line;
  const lineClose = close.line;

  // Odds CLV, in points of implied probability: positive = we locked a better
  // (cheaper) price than the market settled at. Defined for every market, not
  // just moneylines.
  const clvOdds = (entry.price != null && close.price != null)
    ? Math.round((impliedProb(close.price) - impliedProb(entry.price)) * 1000) / 10
    : null;

  let clv = null, beat = null;
  if (p.market === 'ml') {
    if (clvOdds == null) return { unmeasurable: true };
    clv = clvOdds;                 // a moneyline's only CLV *is* the price
    beat = clv > 0;
  } else {
    if (lineEntry == null || lineClose == null) return { unmeasurable: true };
    // Side-aware: Under wants the total to rise; Over wants it to fall; a spread
    // side always wants a higher (more favorable) number.
    if (p.market === 'total') clv = p.side === 'Under' ? lineClose - lineEntry : lineEntry - lineClose;
    else clv = lineClose - lineEntry; // spread, from the bet side's perspective
    clv = Math.round(clv * 10) / 10;
    // The number moved → that settles it. The number held → the PRICE on that
    // number decides, and if we don't have both prices we don't know (null),
    // which is not the same as "didn't beat it".
    if (clv !== 0) beat = clv > 0;
    else beat = clvOdds == null ? null : clvOdds > 0;
  }

  // Suspect now means something real and narrow: our latest batch predates the
  // close window, so what we're calling "the close" probably isn't.
  const closeMs = new Date(closeTs).getTime();
  const suspect = closeMs < commenceMs - CLOSE_LEAD_MS;

  return {
    sport: p.sport, game_id: p.game_id, bet_market: p.market, side: p.side,
    line_logged: lineEntry, line_close: lineClose, odds_logged: entry.price, odds_close: close.price,
    clv, clv_odds: clvOdds, beat_close: beat,
    entry_at: new Date(entryTs).toISOString(), close_at: new Date(closeTs).toISOString(),
    close_source: suspect ? 'pre-close snapshot' : 'last pre-kickoff snapshot',
    suspect, recorded_at: new Date().toISOString(),
  };
}

// Aggregate clean (non-suspect) clv_records into the dashboard summary.
async function publishReport() {
  const since = new Date(Date.now() - REPORT_DAYS * 86400_000).toISOString();
  let all = [];
  try { all = await db.select('clv_records', '*', { gte: { recorded_at: since }, order: { column: 'recorded_at', ascending: false }, limit: 2000 }); }
  catch (e) { reportDegraded('clv|report', `report query failing: ${e.message}`); return; }
  const clean = all.filter((r) => !r.suspect);
  const fin = (rows) => {
    const n = rows.length;
    // beat_close is nullable now: a flat line with no prices on either end is
    // genuinely unknown. Counting unknowns as losses is what produced a
    // permanent 0%-beat reading, so they're excluded from the denominator.
    const known = rows.filter((r) => r.beat_close != null);
    const beat = known.filter((r) => r.beat_close).length;
    const avgOf = (f) => { const v = rows.map(f).filter(Number.isFinite); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : 0; };
    return {
      n, beat, graded: known.length, unknown: n - known.length,
      beat_pct: known.length ? Math.round((beat / known.length) * 1000) / 10 : null,
      avg_clv: avgOf((r) => Number(r.clv)),
      avg_clv_odds: avgOf((r) => Number(r.clv_odds)),
    };
  };
  const bySport = {};
  for (const r of clean) (bySport[r.sport || '—'] ||= []).push(r);
  setClvReport({
    days: REPORT_DAYS,
    overall: fin(clean),
    bySport: Object.entries(bySport).map(([sport, rows]) => ({ sport, ...fin(rows) })).sort((a, b) => b.n - a.n),
    recent: clean.slice(0, 30).map((r) => ({ sport: r.sport, game_id: r.game_id, market: r.bet_market, side: r.side, line_logged: r.line_logged, line_close: r.line_close, odds_logged: r.odds_logged, odds_close: r.odds_close, clv: r.clv, clv_odds: r.clv_odds, beat_close: r.beat_close, recorded_at: r.recorded_at })),
    suspect_excluded: all.length - clean.length,
    updated_at: new Date().toISOString(),
  });
}

async function run() {
  if (!db.isConnected()) return { summary: 'skipped — no DB' };

  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  let plays = [];
  try {
    // `live` is part of the projection on purpose: an in-game play has no
    // close to beat (D37) and must be told apart from one whose close we
    // failed to capture.
    plays = await db.select('monitor_scores', 'sport,game_id,market,side,line,scored_at,live', {
      match: { qualified: true }, gte: { scored_at: since }, order: { column: 'scored_at', ascending: false }, limit: 800,
    });
  } catch (e) {
    reportDegraded('clv|plays', `monitor_scores query failing: ${e.message}`);
    await publishReport();
    return { summary: `select failed: ${e.message}` };
  }

  // Already-finalized (non-suspect) plays — don't re-capture or overwrite a good close.
  let done = new Set();
  try {
    const ex = await db.select('clv_records', 'game_id,bet_market,side,suspect', { gte: { recorded_at: since } });
    done = new Set(ex.filter((r) => !r.suspect).map((r) => `${r.game_id}|${r.bet_market}|${r.side}`));
  } catch (e) { /* none */ }

  const records = [];
  let tooEarly = 0, suspectN = 0, unmeasurable = 0, queryErrors = 0, lastErr = null;
  // Legitimate categories, each its own count. None of these is a coverage
  // failure, so none of them feeds the coverage alarm:
  //   inPlay         — bet placed after kickoff; no close to beat (D37).
  //   untracked      — market has no line_snapshots feed (props).
  //   noCloseCapture — TENNIS with TENNIS_CLOSE_CAPTURE off: ingest writes one
  //                    batch a day, so entry and close are the same batch BY
  //                    DESIGN. (Counted inside `unmeasurable` too — it is.)
  //   noCommence     — no kickoff on file, so no close can be bounded.
  //                    (Also inside `unmeasurable`.)
  let inPlay = 0, untracked = 0, noCloseCapture = 0, noCommence = 0;
  for (const p of plays) {
    if (done.has(`${p.game_id}|${p.market}|${p.side}`)) continue;
    if (p.live) { inPlay++; continue; }
    const rec = await capture(p);
    if (!rec) { tooEarly++; continue; }
    if (rec.error) { queryErrors++; lastErr = rec.error; continue; }
    if (rec.untracked) { untracked++; continue; }
    if (rec.unmeasurable) {
      unmeasurable++;
      if (rec.noCommence) noCommence++;
      else if (p.sport === 'TENNIS' && !config.tennisCloseCapture) noCloseCapture++;
      continue;
    }
    if (rec.suspect) suspectN++;
    records.push(rec);
  }
  // The alarm population: plays that COULD have had a distinct close and
  // didn't — pre-game, tracked market, close captured for the sport, kickoff
  // known. Everything else above is explained by construction.
  const noClose = unmeasurable - noCloseCapture - noCommence;

  // `_`-prefixed fields are run diagnostics, not columns.
  const rows = records.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))));

  let writeErr = null, degradedWrite = false;
  if (rows.length) {
    try { await db.upsert('clv_records', rows, 'game_id,bet_market,side'); }
    catch (e) {
      // clv_odds / close_source arrived with this change. If schema.sql hasn't
      // been re-run, PostgREST rejects the whole batch on the unknown column —
      // which would take CLV from "wrong" to "gone". Fall back to the columns
      // that have always existed so the metric keeps working, and say plainly
      // that the migration is owed.
      if (db.isMissingRelation(e)) {
        degradedWrite = true;
        const legacy = rows.map(({ clv_odds, close_source, ...keep }) => keep);
        try { await db.upsert('clv_records', legacy, 'game_id,bet_market,side'); }
        catch (e2) { writeErr = e2.message; logger.warn('clv', e2.message); }
      } else { writeErr = e.message; logger.warn('clv', e.message); }
    }
  }
  if (degradedWrite) {
    logger.error('clv', 'clv_records is missing clv_odds/close_source — run scripts/schema.sql; wrote line-only CLV for now');
    reportDegraded('clv|schema', 'clv_records missing clv_odds/close_source — run scripts/schema.sql (price-aware CLV disabled until then)');
  }
  await publishReport();

  const measured = records.filter((r) => r.beat_close != null);
  const beat = records.filter((r) => r.beat_close && !r.suspect).length;

  // ── Make the failure modes loud ────────────────────────────────
  // The old agent reported "20 CLV records (0 beat close, 20 suspect)" with
  // status idle and 0 consecutive failures, forever. Each of these conditions
  // is a defect in us, not a fact about the market, so each one now surfaces.
  if (queryErrors) {
    logger.error('clv', `${queryErrors} snapshot queries failed — last: ${lastErr}`);
    reportDegraded('clv|snapshots', `${queryErrors} snapshot queries failed (last: ${lastErr})`);
  }
  if (writeErr) reportDegraded('clv|write', `clv_records write failing: ${writeErr}`);
  if (records.length >= ALARM_MIN && suspectN === records.length) {
    logger.error('clv', `every one of ${records.length} records is suspect — closing capture is not landing in the close window`);
    reportDegraded('clv|all-suspect', `all ${records.length} CLV records suspect — close captured before the close window`);
  }
  if (measured.length >= ALARM_MIN && !measured.some((r) => r.beat_close)) {
    logger.error('clv', `0 of ${measured.length} measurable records beat the close — check the closing-price comparison`);
    reportDegraded('clv|none-beat', `0 of ${measured.length} measurable CLV records beat the close`);
  }
  // Pre-game plays in a tracked market, past kickoff, with a close on file for
  // the sport — and still no pre-kickoff batch distinct from the entry. That
  // is the one branch left where the snapshot cadence, not the maths and not
  // the play, is the problem, and the message claims exactly that. The
  // explained categories (in-play, props, tennis without close-capture, no
  // kickoff) are not in `noClose`; before D98 they were, and seven live NFL
  // plays plus eight daily-ingest tennis plays read as a coverage outage.
  if (noClose >= ALARM_MIN && !records.length) {
    reportDegraded('clv|unmeasurable', `${noClose} pre-game plays past kickoff with no pre-kickoff batch distinct from entry — no CLV measurable`);
  }

  const parts = [`${records.length} CLV records`];
  const detail = [`${beat} beat close`];
  if (measured.length !== records.length) detail.push(`${records.length - measured.length} unknown`);
  if (suspectN) detail.push(`${suspectN} suspect`);
  if (unmeasurable) {
    const why = [];
    if (noCloseCapture) why.push(`${noCloseCapture} no close-capture`);
    if (noCommence) why.push(`${noCommence} no kickoff`);
    detail.push(`${unmeasurable} unmeasurable${why.length ? ` (${why.join(', ')})` : ''}`);
  }
  if (inPlay) detail.push(`${inPlay} in-play`);
  if (untracked) detail.push(`${untracked} untracked market`);
  if (tooEarly) detail.push(`${tooEarly} too early`);
  if (queryErrors) detail.push(`${queryErrors} query errors`);
  return {
    summary: `${parts.join('')} (${detail.join(', ')})`,
    data: {
      recorded: records.length, beat, measured: measured.length, suspect: suspectN,
      unmeasurable, noCloseCapture, noCommence, inPlay, untracked, tooEarly, queryErrors,
    },
  };
}

// `capture` is exported for the test suite: the close/entry selection is the
// part of this agent that was silently wrong, and it is only testable in
// isolation. Nothing else imports it.
export { capture };

export default { name: 'clv', run };
