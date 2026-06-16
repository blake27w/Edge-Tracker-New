// ══════════════════════════════════════════════════════════════
// Prop Engine (Agent 11) — Phase 1: the two highest-EV, automation-
// advantage triggers.
//   1. Injury-triggered alerts: when the Injury Agent flags a starter
//      OUT, pull the backup/teammates' prop lines and flag stale numbers
//      before books repost (the window is minutes-to-hours).
//   2. Weather-triggered passing Unders: 15+ mph wind → QB passing-yard
//      props that haven't dropped proportionally.
// Props are exempt from the totals Under-bias (individual matchup driven).
// Claude is only called when there's a trigger, so quiet slates cost $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { claudeJson, hasClaude, logger } from '../../utils/index.js';
import { getGames, getIntel, setPropPlays } from '../../store/index.js';

async function run() {
  const injuries = getIntel('injuries').filter((i) => i.status === 'OUT' && i.impact !== 'low');
  const weather = getIntel('weather').filter((w) => !w.dome && (w.wind_mph || 0) >= 15);
  const games = getGames();

  if (!injuries.length && !weather.length) {
    setPropPlays([]);
    return { summary: 'no prop triggers (injury/weather) — idle' };
  }
  if (!hasClaude()) return { summary: `${injuries.length} injury + ${weather.length} weather triggers, but no Claude` };

  const injuryLines = injuries
    .map((i) => `OUT: ${i.player} (${i.team}, ${i.sport}) [game ${i.game_id || '?'}] — ${i.detail || ''}`)
    .join('\n');
  const weatherLines = weather
    .map((w) => `WIND ${w.wind_mph}mph: ${w.away} @ ${w.home} [game ${w.game_id}]`)
    .join('\n');

  const prompt = `You are a player-prop analyst exploiting two fast-moving edges. Search current prop markets and return ONLY JSON: an array of objects with keys:
  game_id, sport, player, stat_type (e.g. "passing_yards", "points", "hits"), line (number), side (OVER|UNDER),
  price (american odds int, optional), book (best book), trigger (injury|weather), rationale (one sentence).

1) INJURY trigger — a starter is OUT. Surface the backup's and teammates' props whose lines look STALE (haven't moved to reflect the increased role). Favor OVERs on the beneficiaries.
${injuryLines || '(none)'}

2) WEATHER trigger — 15+ mph wind. Surface QB passing-yard props that should drop ~15-20 yards but haven't; favor UNDER.
${weatherLines || '(none)'}

Only include genuinely actionable, stale-looking lines. Max 25 entries.`;

  const json = await claudeJson(prompt, { maxTokens: 3000 });
  const list = Array.isArray(json) ? json : [];
  const now = new Date().toISOString();

  const snapshots = list
    .filter((r) => r && r.player && r.stat_type)
    .map((r) => ({
      sport: r.sport || null, game_id: r.game_id || null, player_id: null, player: r.player,
      stat_type: r.stat_type, line: num(r.line), side: (r.side || 'OVER').toUpperCase(),
      price: num(r.price), book: r.book || null, trigger: (r.trigger || 'injury').toLowerCase(),
      fetched_at: now,
    }));

  if (snapshots.length) {
    try { await db.insert('prop_snapshots', snapshots); } catch (e) { logger.warn('prop-engine', e.message); }
  }

  // Publish as prop plays for the dashboard queue.
  const plays = snapshots.map((s, i) => ({
    sport: s.sport, game_id: s.game_id, matchup: matchupFor(games, s.game_id),
    market: 'prop', side: `${s.player} ${s.side} ${s.line} ${s.stat_type}`,
    line: s.line, score: s.trigger === 'injury' ? 78 : 74, confidence: s.trigger === 'injury' ? 78 : 74,
    tier: '1u', unit_mult: 1, unit_dollars: 12, t1_count: 1,
    signals: [{ tier: 1, id: s.trigger, label: list[i]?.rationale || `${s.trigger} trigger` }],
    qualified: true, market_trigger: s.trigger, scored_at: now,
  }));
  setPropPlays(plays);

  const injCount = snapshots.filter((s) => s.trigger === 'injury').length;
  const wxCount = snapshots.filter((s) => s.trigger === 'weather').length;
  return {
    summary: `${snapshots.length} prop alerts (${injCount} injury, ${wxCount} weather)`,
    data: { count: snapshots.length, injury: injCount, weather: wxCount },
  };
}

function matchupFor(games, gameId) {
  const g = games.find((x) => x.game_id === gameId);
  return g ? `${g.away} @ ${g.home}` : null;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export default { name: 'prop-engine', run };
