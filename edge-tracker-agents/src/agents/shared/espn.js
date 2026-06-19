// ══════════════════════════════════════════════════════════════
// Shared ESPN fetchers with an in-process TTL cache, so multiple
// agents (grading, opp-grading) reuse the same free ESPN responses
// instead of each calling the API. Finals are cached briefly (a game
// may still be in progress); box scores are cached once available.
// ══════════════════════════════════════════════════════════════
const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const FINALS_TTL = Number(process.env.ESPN_FINALS_TTL_MS) || 15 * 60_000;

const norm = (s) => String(s || '').toLowerCase();
const finalsCache = new Map(); // `${path}|${date}` -> { at, data }
const boxCache = new Map();    // eventId -> boxscore

// Completed finals for an ESPN path (e.g. 'basketball/nba') + YYYYMMDD date.
// Returns [{ id, homeNick, awayNick, home_score, away_score, total }]. Cached ~15 min.
export async function getFinals(path, dateStr) {
  if (!path) return [];
  const key = `${path}|${dateStr}`;
  const hit = finalsCache.get(key);
  if (hit && Date.now() - hit.at < FINALS_TTL) return hit.data;
  const out = [];
  try {
    const res = await fetch(`${BASE}/${path}/scoreboard?dates=${dateStr}`);
    if (res.ok) {
      const data = await res.json();
      for (const ev of data.events || []) {
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
        });
      }
    }
  } catch (_) { /* leave empty; caller treats missing as pending */ }
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
