// ══════════════════════════════════════════════════════════════
// Shared ESPN fetchers with an in-process TTL cache, so multiple
// agents (grading, opp-grading) reuse the same free ESPN responses
// instead of each calling the API. Finals are cached briefly (a game
// may still be in progress); box scores are cached once available.
// ══════════════════════════════════════════════════════════════
const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const FINALS_TTL = Number(process.env.ESPN_FINALS_TTL_MS) || 15 * 60_000;

// Fold diacritics before casing, matching grading's norm(). Both sides of
// every nickname comparison must fold or neither can: folding only the play's
// matchup would newly break an accented nickname. Strictly widens what matches.
// FOLD covers what NFD cannot: stroked and ligature letters are precomposed
// single code points with no combining mark to strip, plus the typographic
// apostrophe. Keep this table identical to grading's.
const FOLD = { ø: 'o', ł: 'l', ß: 'ss', đ: 'd', æ: 'ae', œ: 'oe', '’': "'" };
const FOLD_RE = /[øłßđæœ’]/gi;
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(FOLD_RE, (c) => FOLD[c.toLowerCase()] || c)
  .toLowerCase();
const finalsCache = new Map(); // `${path}|${date}` -> { at, data }
const boxCache = new Map();    // eventId -> boxscore
// Raw scoreboard events per (path, date), shared by getFinals AND getSchedule
// so a doubleheader check costs nothing extra — both read the one fetch.
const eventsCache = new Map(); // `${path}|${date}` -> { at, events }

async function fetchEvents(path, dateStr) {
  const key = `${path}|${dateStr}`;
  const hit = eventsCache.get(key);
  if (hit && Date.now() - hit.at < FINALS_TTL) return hit.events;
  let events = [];
  try {
    const res = await fetch(`${BASE}/${path}/scoreboard?dates=${dateStr}`);
    if (res.ok) events = (await res.json())?.events || [];
  } catch (_) { /* leave empty; caller treats missing as pending */ }
  eventsCache.set(key, { at: Date.now(), events });
  return events;
}

// Completed finals for an ESPN path (e.g. 'basketball/nba') + YYYYMMDD date.
// Returns [{ id, homeNick, awayNick, home_score, away_score, total, startTime }].
// Cached ~15 min. `startTime` (the competition's own kickoff, comp.date) is what
// lets a caller tell "this final is my game" from "this final shares my
// matchup's nickname but is a different game" once two games share a date.
export async function getFinals(path, dateStr) {
  if (!path) return [];
  const out = [];
  for (const ev of await fetchEvents(path, dateStr)) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    if (!(comp.status?.type?.completed || ev.status?.type?.completed)) continue;
    const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
    const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    const hs = Number(home.score), as = Number(away.score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    // "Final/OT", "Final/2OT", "Final/SO", "Final/11" (extra innings) → overtime.
    const detail = comp.status?.type?.detail || comp.status?.type?.shortDetail || '';
    const overtime = /final/i.test(detail) && /\/(\d*ot|so|\d+)/i.test(detail);
    out.push({
      id: ev.id,
      homeNick: norm(home.team?.name || home.team?.shortDisplayName),
      awayNick: norm(away.team?.name || away.team?.shortDisplayName),
      home_score: hs, away_score: as, total: hs + as, overtime, detail,
      startTime: comp.date || ev.date || null,
    });
  }
  return out;
}

// ALL scheduled events for a date (completed or not), so a caller can tell a
// true "one game" from "one game finished, one still live" — getFinals drops
// the unfinished one, which is exactly what let a doubleheader's game 2 get
// silently graded off game 1's score (a confirmed D111 defect). Shares the
// same cached fetch as getFinals — this never costs an extra request.
// Returns [{ homeNick, awayNick, startTime, completed }].
export async function getSchedule(path, dateStr) {
  if (!path) return [];
  const out = [];
  for (const ev of await fetchEvents(path, dateStr)) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
    const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    out.push({
      homeNick: norm(home.team?.name || home.team?.shortDisplayName),
      awayNick: norm(away.team?.name || away.team?.shortDisplayName),
      startTime: comp.date || ev.date || null,
      completed: !!(comp.status?.type?.completed || ev.status?.type?.completed),
    });
  }
  return out;
}

// Completed UFC fights for a date (ESPN MMA). [{ names:[a,b], winner }].
export async function getUfcResults(dateStr) {
  const key = `ufc|${dateStr}`;
  const hit = finalsCache.get(key);
  if (hit && Date.now() - hit.at < FINALS_TTL) return hit.data;
  const out = [];
  try {
    const res = await fetch(`${BASE}/mma/ufc/scoreboard?dates=${dateStr}`);
    if (res.ok) {
      const data = await res.json();
      for (const ev of data.events || []) {
        for (const comp of ev.competitions || []) {
          if (!comp.status?.type?.completed) continue;
          const cs = comp.competitors || [];
          const names = cs.map((c) => c.athlete?.displayName || c.athlete?.shortName || '').filter(Boolean);
          const winner = cs.find((c) => c.winner)?.athlete?.displayName;
          if (names.length >= 2 && winner) out.push({ names, winner });
        }
      }
    }
  } catch (_) { /* leave pending */ }
  finalsCache.set(key, { at: Date.now(), data: out });
  return out;
}

// Box score for a single event. Cached once available (never cache a miss).
export async function getBox(path, eventId) {
  if (boxCache.has(eventId)) return boxCache.get(eventId);
  let box = null;
  try {
    const res = await fetch(`${BASE}/${path}/summary?event=${eventId}`);
    if (res.ok) box = (await res.json())?.boxscore || null;
  } catch (_) { /* leave pending */ }
  if (box) boxCache.set(eventId, box);
  return box;
}
