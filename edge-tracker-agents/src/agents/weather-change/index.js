// ══════════════════════════════════════════════════════════════
// Weather-Change detection — a SPEED edge layered on the weather agent.
// The line opens on one forecast; if the wind forecast worsens materially
// before the game and the book HASN'T re-hung the total yet, that gap is
// the edge. We reuse the weather agent's data (no new API calls): compare
// each game's earliest vs latest forecast in game_weather, and the opener
// vs current total. When the wind newly turns significant AND the total is
// still stale, we ALERT (act before the book moves) and flag it for the
// Action Board. The actual wind→total lean is already scored by the signal
// engine via the weather agent, so this does NOT add points (no double
// count) — it's a timing/notification edge. $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { getGames, getIntel, setIntel } from '../../store/index.js';

const WIND_DELTA = Number(process.env.WX_WIND_DELTA) || 8;   // mph the forecast must worsen by
const LINE_REACT = Number(process.env.WX_LINE_REACT) || 1.0; // total move (runs/pts) that means the book reacted
const alerted = new Set();

async function run() {
  const games = getGames().filter((g) => g.consensusTotal != null && (g.sport === 'MLB' || g.sport === 'NFL'));
  if (!games.length) { setIntel('weatherChange', []); return { summary: 'no totals games to watch' }; }

  // Latest forecast per game (already fetched by the weather agent).
  const latest = {};
  for (const w of getIntel('weather') || []) latest[w.game_id] = w;

  // Earliest forecast today per game (the "forecast when the line was fresh").
  const first = {};
  try {
    const since = new Date(Date.now() - 18 * 3600_000).toISOString();
    const rows = await db.select('game_weather', 'game_id,wind_mph,fetched_at', { gte: { fetched_at: since }, order: { column: 'fetched_at', ascending: true }, limit: 4000 });
    for (const r of rows) if (!(r.game_id in first)) first[r.game_id] = r; // first seen = earliest
  } catch (_) { /* no history yet → can't detect a change */ }

  // Opener totals (to tell whether the book already reacted).
  const opener = {};
  try {
    const op = await db.select('opening_lines', 'game_id,line', { match: { market: 'total' }, limit: 4000 });
    for (const o of op) opener[o.game_id] = Number(o.line);
  } catch (_) { /* optional */ }

  const now = new Date().toISOString();
  const rows = [];
  for (const g of games) {
    const cur = latest[g.game_id], f = first[g.game_id];
    if (!cur || cur.dome) continue;
    const curWind = Number(cur.wind_mph) || 0;
    const firstWind = f ? Number(f.wind_mph) || 0 : null;
    // The wind must have newly turned significant (≥15) AND worsened by WIND_DELTA.
    if (curWind < 15 || firstWind == null || curWind - firstWind < WIND_DELTA) continue;
    const lean = cur.total_impact; // 'under' | 'over' | 'neutral'
    if (lean !== 'under' && lean !== 'over') continue;

    // Has the book already moved the total in the wind's direction?
    const op = opener[g.game_id];
    let stale = true, moved = null;
    if (op != null) {
      moved = Math.round((op - g.consensusTotal) * 10) / 10; // + = total dropped
      const reacted = lean === 'under' ? moved >= LINE_REACT : -moved >= LINE_REACT;
      stale = !reacted;
    }
    if (!stale) continue; // book already adjusted → no edge

    rows.push({
      game_id: g.game_id, sport: g.sport, matchup: `${g.away} @ ${g.home}`, lean,
      first_wind: Math.round(firstWind), cur_wind: Math.round(curWind),
      opener_total: op ?? null, cur_total: g.consensusTotal,
      note: `Wind ${Math.round(firstWind)}→${Math.round(curWind)}mph since open, total still ${g.consensusTotal}${op != null ? ` (opened ${op})` : ''} → ${lean === 'under' ? 'Under' : 'Over'}`,
      detected_at: now,
    });
  }
  setIntel('weatherChange', rows);

  if (rows.length) {
    try { await db.insert('weather_changes', rows); } catch (e) { logger.warn('weather-change', e.message); }
    for (const r of rows) {
      const k = `${r.game_id}|${r.lean}`;
      if (alerted.has(k)) continue;
      alerted.add(k);
      const body = `🌬️ Weather shift — ${r.matchup}: wind ${r.first_wind}→${r.cur_wind}mph, total still ${r.cur_total} → ${r.lean === 'under' ? 'Under' : 'Over'}. Bet before the book re-hangs it.`;
      try {
        const res = await notifyAll('Edge Tracker: weather shift', body);
        await db.insert('alert_log', { type: res.email && !res.sms ? 'email' : 'sms', channel: 'weather', recipients: res.total, body, sport: r.sport, game_id: r.game_id, status: 'sent' });
      } catch (e) { logger.warn('weather-change', `alert: ${e.message}`); }
    }
  }

  return { summary: `${rows.length} live weather-vs-line edges · free (reuses weather data)`, data: { edges: rows.length } };
}

export default { name: 'weather-change', run };
