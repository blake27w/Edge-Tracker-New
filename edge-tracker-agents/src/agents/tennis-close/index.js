// ══════════════════════════════════════════════════════════════
// Tennis Close-Capture (opt-in). Daily ingest gives one price point per
// match — not enough for CLV (you need an entry AND a close). This grabs a
// genuine CLOSING price by fetching h2h ONLY for matches starting within
// the next couple hours (a small set), writing it to line_snapshots so the
// CLV tracker has a distinct close point. OFF by default (respects the
// "ingest once a day" cost rule); enable with TENNIS_CLOSE_CAPTURE=true.
// Per-run + per-day caps keep spend bounded even when on. $ = a few Odds
// API credits per imminent match.
// ══════════════════════════════════════════════════════════════
import config from '../../config/index.js';
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getTennisGames } from '../../store/index.js';
import { hasOddsBudget } from '../odds/index.js';

const { oddsApi, BOOKS } = config;
const WINDOW_H = Number(process.env.TENNIS_CLOSE_WINDOW_H) || 2;
const MAX_PER_RUN = Number(process.env.TENNIS_CLOSE_MAX) || 12;
const MAX_PER_DAY = Number(process.env.TENNIS_CLOSE_MAX_DAY) || 120;
let day = today(), used = 0;
function today() { return new Date().toISOString().slice(0, 10); }

async function fetchEvent(tournament, eventId) {
  const params = new URLSearchParams({ apiKey: oddsApi.key, regions: 'us', markets: 'h2h', oddsFormat: 'american', bookmakers: BOOKS.join(',') });
  const res = await fetch(`${oddsApi.base}/sports/${tournament}/events/${eventId}/odds?${params}`);
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw new Error(`Odds ${res.status}`);
  return res.json();
}

async function run() {
  if (!config.tennisCloseCapture) return { summary: 'disabled (set TENNIS_CLOSE_CAPTURE=true)' };
  if (!oddsApi.key) return { summary: 'skipped — no ODDS_API_KEY' };
  if (!hasOddsBudget(config.rules.oddsReserve)) return { summary: 'skipped — protecting odds budget' };
  if (today() !== day) { day = today(); used = 0; }

  const now = Date.now();
  const games = getTennisGames().filter((g) => g.tournament && g.commence_time && (() => {
    const t = new Date(g.commence_time).getTime();
    return t >= now - 15 * 60_000 && t <= now + WINDOW_H * 3600_000;
  })());
  if (!games.length) return { summary: 'no tennis matches near start' };

  const nowIso = new Date().toISOString();
  const ls = [];
  let scanned = 0;
  for (const g of games) {
    if (scanned >= MAX_PER_RUN || used >= MAX_PER_DAY) break;
    let data;
    try { data = await fetchEvent(g.tournament, g.game_id); } catch (e) { logger.warn('tennis-close', `${g.p1} v ${g.p2}: ${e.message}`); continue; }
    scanned++; used++;
    if (!data) continue;
    for (const bm of data.bookmakers || []) {
      for (const mk of bm.markets || []) {
        if (mk.key !== 'h2h') continue;
        for (const oc of mk.outcomes || []) {
          if (oc.price == null) continue;
          ls.push({ sport: 'TENNIS', game_id: data.id || g.game_id, commence_time: g.commence_time, home: g.p1, away: g.p2, book: bm.key, market: 'h2h', side: oc.name, line: null, price: Math.round(oc.price), fetched_at: nowIso });
        }
      }
    }
  }
  if (ls.length) { try { await db.insert('line_snapshots', ls); } catch (e) { logger.warn('tennis-close', e.message); } }
  return { summary: `${scanned} imminent tennis matches captured (${ls.length} close prices)`, data: { scanned, prices: ls.length, used } };
}

export default { name: 'tennis-close', run };
