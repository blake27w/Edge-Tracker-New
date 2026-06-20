// ══════════════════════════════════════════════════════════════
// C2 — Weigh-In & Fight-Week News (the core combat edge: news speed).
// Scheduled as a tight Friday burst (UFC weigh-ins post ~noon ET).
// Detects OBJECTIVE facts only — missed weight (by how much), official
// scratch, confirmed short-notice replacement — via Claude web search.
// TIMESTAMP-PAIRING: on detection it captures the lines right then and
// marks value_remains only if the opponent's price hasn't already moved
// (line_open vs current). If the market already absorbed it → no play.
// UFC only for v1. $0 beyond a few Claude calls on fight Fridays.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger, hasClaude, claudeJson } from '../../utils/index.js';
import { getGames } from '../../store/index.js';
import { combatLine } from '../combat-market/index.js';
import { impliedProb } from '../shared/odds-math.js';

const VALUE_MOVE = Number(process.env.COMBAT_VALUE_MOVE) || 0.03; // opp implied-prob rise since open under this = value remains
const norm = (s) => String(s || '').toLowerCase();
function matches(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const xs = x.split(' '), ys = y.split(' ');
  return xs[xs.length - 1] === ys[ys.length - 1]; // surname
}

async function run() {
  const now = Date.now();
  const ufc = getGames().filter((g) => g.sport === 'UFC' && g.commence_time &&
    new Date(g.commence_time).getTime() <= now + 48 * 3600_000 &&
    new Date(g.commence_time).getTime() >= now - 12 * 3600_000);
  if (!ufc.length) return { summary: 'no UFC card in window' };
  if (!hasClaude()) return { summary: 'skipped — no Claude' };

  const fighters = ufc.flatMap((g) => [g.home, g.away]);
  const prompt = `Today's UFC official weigh-in results. From these fighters: ${fighters.join(', ')}.\n` +
    `Return STRICT JSON: {"misses":[{"fighter":"<exact name>","over_lbs":<number>}],"scratches":["<name>"],"replacements":[{"out":"<name>","in":"<name>"}]}.\n` +
    `Only include fighters who OBJECTIVELY missed weight (with pounds over the limit), were officially scratched, or are confirmed short-notice replacements. Do NOT judge condition or guess. If none, return empty arrays.`;
  let data;
  try { data = await claudeJson(prompt, { maxTokens: 1200 }); } catch (e) { return { summary: `weigh-in fetch failed: ${e.message}` }; }
  if (!data) return { summary: 'no weigh-in data' };

  const findFight = (name) => ufc.find((g) => matches(g.home, name) || matches(g.away, name));
  const iso = new Date().toISOString();
  const today = iso.slice(0, 10);
  const news = [];

  const record = (fighterName, type, detail, over_lbs) => {
    const g = findFight(fighterName);
    if (!g) return;
    const compromised = matches(g.home, fighterName) ? g.home : g.away;
    const opponent = compromised === g.home ? g.away : g.home;
    const cl = combatLine(g, compromised), ol = combatLine(g, opponent);
    let value_remains = true;
    if (ol) value_remains = (impliedProb(ol.consensus) - impliedProb(ol.open)) < VALUE_MOVE; // opp not yet bet up
    news.push({
      game_id: g.game_id, fighter: compromised, opponent, sport: 'UFC', type, detail,
      over_lbs: over_lbs ?? null, line_at_detection: cl ? cl.consensus : null,
      opp_line_at_detection: ol ? ol.consensus : null, value_remains, detected_at: iso,
    });
  };

  for (const m of data.misses || []) record(m.fighter, 'missed_weight', `missed weight by ${m.over_lbs} lbs`, m.over_lbs);
  for (const s of data.scratches || []) record(s, 'scratch', 'officially scratched');
  for (const r of data.replacements || []) { if (r.in) record(r.in, 'replacement', `short-notice replacement (for ${r.out || '?'})`); }

  // Dedup against anything already recorded today for the same fight+fighter+type.
  let existing = [];
  try { existing = await db.select('combat_news', 'game_id,fighter,type,detected_at', { gte: { detected_at: today + 'T00:00:00Z' } }); } catch (_) { /* none */ }
  const seen = new Set(existing.map((e) => `${e.game_id}|${e.fighter}|${e.type}`));
  const fresh = news.filter((n) => !seen.has(`${n.game_id}|${n.fighter}|${n.type}`));
  if (fresh.length) { try { await db.insert('combat_news', fresh); } catch (e) { logger.warn('combat-weighin', e.message); } }

  const actionable = fresh.filter((n) => n.value_remains).length;
  return { summary: `${fresh.length} fight-week items (${actionable} with value remaining)`, data: { items: fresh.length, actionable } };
}

export default { name: 'combat-weighin', run };
