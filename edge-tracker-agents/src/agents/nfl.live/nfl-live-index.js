// ══════════════════════════════════════════════════════════════
// NFL Live In-Game Agent. Self-gates to NFL games currently in progress
// (kickoff ≤ now ≤ kickoff+4h) — a cheap no-op otherwise. Uses the odds
// agent's own live snapshots (STRIKE cadence, protected) so it spends $0
// extra Odds API credits, plus free ESPN scoreboard/summary for game
// state. Five in-game edges:
//   l_2h_total  halftime total lean (non-offensive 1H points / empty RZ trips)
//   l_stale     live stale line across books (reuses stale-line output)
//   l_exch_ml   book ML lagging Kalshi/Polymarket (reuses pred-market)
//   l_key       live key-number capture on 3/7 (reuses key-number)
//   l_injury    mid-game QB change, books that haven't moved yet
// Writes monitor_scores rows with live=true (graded by the grading agent,
// split out on the track record), pushes SMS/email on A-tier or better.
// Enable with NFL_LIVE=true.
// ══════════════════════════════════════════════════════════════
import config, { unitFor } from '../../config/index.js';
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { getGames, getStaleLines, getKeyNumbers, getPredMarket, setIntel } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';
import { fmtOdds } from '../shared/odds-math.js';
import { norm } from '../shared/nfl.js';

const ENABLED = String(process.env.NFL_LIVE || '').toLowerCase() === 'true';
const ALERT_MIN = Number(process.env.NFL_LIVE_ALERT_SCORE) || 80;   // score threshold for SMS/email
const LIVE_H = Number(process.env.NFL_LIVE_WINDOW_H) || 4;           // consider a game live this long after kickoff
const EXCH_EDGE = Number(process.env.NFL_LIVE_EXCH_EDGE) || 4;       // % gap book vs exchange
const EXCH_VOL = Number(process.env.NFL_LIVE_EXCH_VOL) || 5000;      // min exchange volume
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

const fired = new Set();          // game|market|side|sig — one write per edge per process
const halftimeDone = new Set();   // game_id — halftime lean fired
const lastAlert = new Map();      // game|market|side → ts
const qbSeen = new Map();         // game|team → first passing leader seen
const lastLines = new Map();      // game → { book: { spreadHome, total } } from previous tick

// ── ESPN helpers ──────────────────────────────────────────────
async function espn(path) {
  const res = await fetch(`${ESPN}/${path}`);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}
function matchEvent(events, g) {
  const h = norm(g.home), a = norm(g.away);
  return events.find((ev) => {
    const c = ev.competitions?.[0]?.competitors || [];
    const eh = c.find((x) => x.homeAway === 'home'), ea = c.find((x) => x.homeAway === 'away');
    return eh && ea && norm(eh.team?.displayName) === h && norm(ea.team?.displayName) === a;
  });
}
function gameState(ev) {
  const comp = ev.competitions?.[0] || {};
  const c = comp.competitors || [];
  const home = c.find((x) => x.homeAway === 'home'), away = c.find((x) => x.homeAway === 'away');
  const st = ev.status || {};
  const period = Number(st.period) || 0;
  const halftime = st.type?.name === 'STATUS_HALFTIME' || (period >= 3 && st.type?.state === 'in');
  const leaders = {};
  for (const t of c) {
    const pass = (t.leaders || []).find((l) => l.name === 'passingYards' || l.name === 'passingLeader');
    const ath = pass?.leaders?.[0]?.athlete?.displayName;
    if (ath) leaders[norm(t.team?.displayName)] = ath;
  }
  return {
    id: ev.id, period, clock: st.displayClock, halftime, inProgress: st.type?.state === 'in',
    homeScore: Number(home?.score) || 0, awayScore: Number(away?.score) || 0,
    homeAbbr: home?.team?.abbreviation, awayAbbr: away?.team?.abbreviation, leaders,
  };
}
// First-half breakdown from the summary feed: non-offensive points + empty red-zone trips.
async function firstHalf(eventId) {
  const s = await espn(`summary?event=${eventId}`);
  let nonOff = 0, missed = 0, prev = 0, pts1H = 0;
  for (const p of s.scoringPlays || []) {
    const per = Number(p.period?.number) || 0;
    const tot = (Number(p.homeScore) || 0) + (Number(p.awayScore) || 0);
    const delta = tot - prev; prev = tot;
    if (per > 2) continue;
    pts1H = tot;
    const txt = `${p.type?.text || ''} ${p.text || ''}`;
    if (/interception return|fumble return|kickoff return|punt return|blocked|safety/i.test(txt)) nonOff += delta;
  }
  for (const d of s.drives?.previous || []) {
    const endPer = Number(d.end?.period?.number) || 0;
    if (endPer > 2) continue;
    const r = String(d.result || d.displayResult || '');
    if (!/missed fg|fumble|interception|downs|blocked/i.test(r)) continue;
    // "SEA 14" style end text — inside opponent 20 when the abbr isn't the drive team's
    const m = /^([A-Z]{2,4})\s+(\d{1,2})$/.exec(String(d.end?.text || '').trim());
    if (m && m[1] !== d.team?.abbreviation && Number(m[2]) <= 20) missed++;
  }
  return { pts1H, nonOff, missed };
}

// ── signal builders ───────────────────────────────────────────
function sig(id, label, tier = 2) { return { id, tier, label }; }

function halftimeLean(g, st, fh, wx) {
  const m = computeMarkets(g);
  const liveTotal = g.consensusTotal ?? m.total.consensus;
  if (liveTotal == null) return null;
  const scored = st.homeScore + st.awayScore;
  const proj2H = Math.max(0, (fh.pts1H - fh.nonOff) + fh.missed * 2.5);
  const projTotal = scored + proj2H;
  const edge = Math.round((liveTotal - projTotal) * 10) / 10;
  const windy = wx && wx.wind_mph >= 15;
  if (edge >= 2 && fh.nonOff >= 7) {
    const score = edge >= 3 ? 90 : 80;
    const best = m.total.bestUnder;
    return { market: 'total', side: 'Under', line: best?.line ?? liveTotal, price: best?.price ?? null, book: best?.book ?? null, score,
      signals: [sig('l_2h_total', `1H: ${fh.nonOff} non-offensive pts, live total ${liveTotal} vs proj ${projTotal.toFixed(1)}`, 1)] };
  }
  if (edge <= -2 && fh.missed >= 2 && !windy) {
    const best = m.total.bestOver;
    return { market: 'total', side: 'Over', line: best?.line ?? liveTotal, price: best?.price ?? null, book: best?.book ?? null, score: 75,
      signals: [sig('l_2h_total', `1H: ${fh.missed} empty red-zone trips, live total ${liveTotal} vs proj ${projTotal.toFixed(1)}`, 1)] };
  }
  return null;
}
function staleLive(g) {
  return getStaleLines().filter((r) => r.sport === 'NFL' && r.game_id === g.game_id && (r.quote_age_min == null || r.quote_age_min <= 2))
    .map((r) => ({ market: r.market, side: r.side, line: r.line, price: r.price, book: r.book,
      score: Math.min(95, Math.round(70 + 10 * (r.pts - 1.5))),
      signals: [sig('l_stale', `${r.book} ${r.side} ${r.line} vs field ${r.consensus} (${r.pts}pt, live)`, 1)] }));
}
function exchVsBook(g) {
  const pm = getPredMarket();
  return (pm?.edges || []).filter((e) => e.sport === 'NFL' && e.game_id === g.game_id && e.edge_pct >= EXCH_EDGE && (e.vol || 0) >= EXCH_VOL)
    .map((e) => {
      const m = computeMarkets(g);
      const best = e.side === g.home ? m.ml.bestHome : m.ml.bestAway;
      return { market: 'ml', side: e.side, line: null, price: best?.price ?? e.price, book: best?.book ?? null,
        score: Math.min(90, Math.round(65 + e.edge_pct * 5)),
        signals: [sig('l_exch_ml', `${e.source} ${e.exch_prob}% vs book ${e.book_prob}% (+${e.edge_pct}%, live)`, 2)] };
    });
}
function liveKeys(g) {
  return getKeyNumbers().filter((k) => k.sport === 'NFL' && k.game_id === g.game_id)
    .map((k) => ({ market: 'spread', side: k.side, line: k.line, price: k.price, book: k.book,
      score: k.importance === 'high' ? 75 : 65,
      signals: [sig('l_key', `${k.book} ${fmtOdds(k.line)} crosses key ${k.key} (field ${fmtOdds(k.consensus)}, live)`, 2)] }));
}
function injuryLag(g, st) {
  const out = [];
  for (const team of [g.home, g.away]) {
    const key = `${g.game_id}|${norm(team)}`;
    const cur = st.leaders[norm(team)];
    if (!cur) continue;
    const first = qbSeen.get(key);
    if (!first) { qbSeen.set(key, cur); continue; }
    if (first === cur) continue;
    // QB changed mid-game. Flag books whose spread on the OTHER team hasn't moved ≥2.5 since last tick.
    qbSeen.set(key, cur);
    const opp = team === g.home ? g.away : g.home;
    const prev = lastLines.get(g.game_id) || {};
    for (const [bk, b] of Object.entries(g.books || {})) {
      const sp = b.markets?.[`spreads:${opp}`];
      const was = prev[bk]?.[`spreads:${opp}`];
      if (!sp || was == null) continue;
      const moved = Math.abs((sp.line ?? 0) - was);
      if (moved >= 2.5) continue;
      out.push({ market: 'spread', side: opp, line: sp.line, price: sp.price, book: b.label || bk, score: 85,
        signals: [sig('l_injury', `${team} QB change (${first} → ${cur}); ${b.label || bk} moved only ${moved}pt`, 1)] });
    }
  }
  return out;
}
function snapshotLines(g) {
  const snap = {};
  for (const [bk, b] of Object.entries(g.books || {})) {
    snap[bk] = {};
    for (const [k, v] of Object.entries(b.markets || {})) if (k.startsWith('spreads:') || k.startsWith('totals:')) snap[bk][k] = v.line;
  }
  lastLines.set(g.game_id, snap);
}

// ── main ──────────────────────────────────────────────────────
async function run() {
  if (!ENABLED) { setIntel('nflLive', []); return { summary: 'disabled (set NFL_LIVE=true)' }; }
  const now = Date.now();
  const games = getGames().filter((g) => g.sport === 'NFL' && g.commence_time && (() => {
    const t = Date.parse(g.commence_time); return t <= now && t >= now - LIVE_H * 3600_000;
  })());
  if (!games.length) { setIntel('nflLive', []); return { summary: 'no live NFL games' }; }

  let sb;
  try { sb = await espn('scoreboard'); } catch (e) { return { summary: `ESPN scoreboard failed: ${e.message}` }; }
  const events = sb.events || [];
  const nowIso = new Date().toISOString();
  const rows = [], fresh = [];
  let liveCount = 0;

  for (const g of games) {
    const ev = matchEvent(events, g);
    if (!ev) continue;
    const st = gameState(ev);
    if (!st.inProgress) continue;
    liveCount++;
    const cands = [];

    if (st.halftime && !halftimeDone.has(g.game_id)) {
      halftimeDone.add(g.game_id);
      try { const fh = await firstHalf(st.id); const lean = halftimeLean(g, st, fh, g.weather); if (lean) cands.push(lean); }
      catch (e) { logger.warn('nfl-live', `halftime ${g.game_id}: ${e.message}`); }
    }
    cands.push(...staleLive(g), ...exchVsBook(g), ...liveKeys(g), ...injuryLag(g, st));
    snapshotLines(g);

    // Correlations: same game+side across signal families.
    const bySide = {};
    for (const c of cands) (bySide[`${c.market}|${c.side}`] ||= []).push(c);
    for (const arr of Object.values(bySide)) {
      const ids = new Set(arr.flatMap((c) => c.signals.map((s) => s.id)));
      const bonus = (ids.has('l_2h_total') && ids.has('l_stale') ? 10 : 0) + (ids.has('l_injury') && ids.has('l_stale') ? 10 : 0) + (ids.has('l_exch_ml') && ids.has('l_key') ? 5 : 0);
      if (bonus) for (const c of arr) c.score = Math.min(99, c.score + bonus);
    }

    for (const c of cands) {
      const unit = unitFor(c.score);
      const qualified = unit.mult > 0;
      const row = {
        sport: 'NFL', game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, commence_time: g.commence_time,
        market: c.market, side: c.side, line: c.line ?? null, price: c.price ?? null, book: c.book ?? null,
        raw_score: c.score, score: c.score, confidence: c.score, tier: unit.label,
        unit_mult: unit.mult, unit_dollars: unit.dollars, t1_count: c.signals.filter((s) => s.tier === 1).length,
        signals: c.signals, qualified, over_penalty_applied: false, observational: false, live: true,
        game_clock: `Q${st.period} ${st.clock || ''}`.trim(), live_score: `${st.awayAbbr} ${st.awayScore}–${st.homeAbbr} ${st.homeScore}`,
        status: 'pending', scored_at: nowIso,
      };
      rows.push(row);
      const key = `${g.game_id}|${c.market}|${c.side}|${c.signals[0].id}`;
      if (qualified && !fired.has(key)) { fired.add(key); fresh.push(row); }
    }
  }
  rows.sort((a, b) => b.score - a.score);
  setIntel('nflLive', rows);

  if (fresh.length) {
    // Dedupe against pending rows already in the DB (survives restarts).
    let pending = new Set();
    try {
      const ex = await db.select('monitor_scores', 'game_id,market,side', { match: { status: 'pending', live: true }, limit: 2000 });
      pending = new Set(ex.map((r) => `${r.game_id}|${r.market}|${r.side}`));
    } catch (_) { /* fall back to in-memory dedupe */ }
    // commence_time / book / clock are dashboard-only; strip anything monitor_scores may not have.
    const dbRows = fresh.filter((r) => !pending.has(`${r.game_id}|${r.market}|${r.side}`))
      .map(({ commence_time, book, game_clock, live_score, ...r }) => r);
    if (dbRows.length) { try { await db.insert('monitor_scores', dbRows); } catch (e) { logger.warn('nfl-live', e.message); } }

    for (const r of fresh) {
      if (r.score < ALERT_MIN) continue;
      const ak = `${r.game_id}|${r.market}|${r.side}`;
      if (now - (lastAlert.get(ak) || 0) < 5 * 60_000) continue;
      lastAlert.set(ak, now);
      const body = `🔴 LIVE ${r.matchup} (${r.live_score}, ${r.game_clock}) · ${r.side}${r.line != null ? ' ' + r.line : ''}${r.price != null ? ' ' + fmtOdds(r.price) : ''}${r.book ? ' @ ' + r.book : ''} · ${r.tier} $${r.unit_dollars} · ${r.signals[0].label}`;
      try {
        const res = await notifyAll('Edge Tracker: NFL LIVE', body);
        await db.insert('alert_log', { type: res.email && !res.sms ? 'email' : 'sms', channel: 'nfl-live', recipients: res.total, body, sport: 'NFL', game_id: r.game_id, status: 'sent' });
      } catch (e) { logger.warn('nfl-live', `alert: ${e.message}`); }
    }
  }

  return { summary: `${liveCount} live · ${rows.length} flags (${fresh.length} new)`, data: { live: liveCount, flags: rows.length, fresh: fresh.length } };
}

export default { name: 'nfl-live', run };
