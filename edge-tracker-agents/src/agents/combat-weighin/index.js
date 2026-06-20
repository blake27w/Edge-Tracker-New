// ══════════════════════════════════════════════════════════════
// C2 — Weigh-In & Fight-Week News (the core combat edge: news speed).
// Runs on an interval but GATES itself internally per sport:
//   • UFC  — only the Friday weigh-in burst (~noon–3pm ET), card ≤48h out.
//            UFC weigh-ins post on a fixed schedule, so we look on Fridays.
//   • BOXING — keyed off market appearance, not a calendar. Any boxing card
//            ≤48h out triggers a check, rate-limited to ~6h between Claude
//            calls (no clean fixed weigh-in slot, so we poll the window).
// Detects OBJECTIVE facts only — missed weight (by how much), official
// scratch, confirmed short-notice replacement — via Claude web search.
// TIMESTAMP-PAIRING: on detection it captures the lines right then and
// marks value_remains only if the opponent's price hasn't already moved
// (line_open vs current). If the market already absorbed it → no play.
// Boxing grades manually until a results feed exists. $0 beyond Claude calls.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger, hasClaude, claudeJson } from '../../utils/index.js';
import { getGames } from '../../store/index.js';
import { combatLine } from '../combat-market/index.js';
import { impliedProb } from '../shared/odds-math.js';

const VALUE_MOVE = Number(process.env.COMBAT_VALUE_MOVE) || 0.03; // opp implied-prob rise since open under this = value remains
const BOX_COOLDOWN_MS = 6 * 3600_000; // boxing has no fixed weigh-in slot → poll the window, but throttle Claude
let lastBox = 0;                       // module-level: last boxing Claude check (ms epoch)

const norm = (s) => String(s || '').toLowerCase();
function matches(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const xs = x.split(' '), ys = y.split(' ');
  return xs[xs.length - 1] === ys[ys.length - 1]; // surname
}

// Weekday (0=Sun..6=Sat) and minutes-of-day in US Eastern, for the UFC gate.
function nowET() {
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
    let wd = 0, h = 0, m = 0;
    for (const p of parts) {
      if (p.type === 'weekday') wd = WD[p.value] ?? 0;
      else if (p.type === 'hour') h = parseInt(p.value, 10) % 24;
      else if (p.type === 'minute') m = parseInt(p.value, 10);
    }
    return { wd, min: h * 60 + m };
  } catch (_) {
    const d = new Date();
    return { wd: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}

// Cards of one sport within the fight-week window (48h ahead, 12h grace behind).
function cardsInWindow(sport, now) {
  return getGames().filter((g) => g.sport === sport && g.commence_time &&
    new Date(g.commence_time).getTime() <= now + 48 * 3600_000 &&
    new Date(g.commence_time).getTime() >= now - 12 * 3600_000);
}

async function run() {
  const now = Date.now();
  if (!hasClaude()) return { summary: 'skipped — no Claude' };

  // Decide which sports to check this tick.
  const active = []; // { sport, cards }
  const { wd, min } = nowET();
  // UFC: Friday noon–3pm ET burst only.
  const ufcCards = cardsInWindow('UFC', now);
  if (ufcCards.length && wd === 5 && min >= 720 && min <= 900) active.push({ sport: 'UFC', cards: ufcCards });
  // Boxing: any card in window, throttled to one Claude check per cooldown.
  const boxCards = cardsInWindow('BOXING', now);
  if (boxCards.length && now - lastBox >= BOX_COOLDOWN_MS) { active.push({ sport: 'BOXING', cards: boxCards }); lastBox = now; }

  if (!active.length) return { summary: 'no combat weigh-in window open' };

  const iso = new Date().toISOString();
  const today = iso.slice(0, 10);
  const news = [];

  for (const { sport, cards } of active) {
    const fighters = cards.flatMap((g) => [g.home, g.away]);
    const noun = sport === 'BOXING' ? 'boxing weigh-in / fight-week' : 'UFC official weigh-in';
    const limitNote = sport === 'BOXING'
      ? 'Boxing has contracted weight limits per bout; only report a fighter OVER his contracted/championship limit.'
      : '';
    const prompt = `Today's ${noun} results. From these fighters: ${fighters.join(', ')}.\n` +
      `Return STRICT JSON: {"misses":[{"fighter":"<exact name>","over_lbs":<number>}],"scratches":["<name>"],"replacements":[{"out":"<name>","in":"<name>"}]}.\n` +
      `Only include fighters who OBJECTIVELY missed weight (with pounds over the limit), were officially scratched, or are confirmed short-notice replacements. ${limitNote} Do NOT judge condition or guess. If none, return empty arrays.`;
    let data;
    try { data = await claudeJson(prompt, { maxTokens: 1200 }); }
    catch (e) { logger.warn('combat-weighin', `${sport} fetch failed: ${e.message}`); continue; }
    if (!data) continue;

    const findFight = (name) => cards.find((g) => matches(g.home, name) || matches(g.away, name));
    const record = (fighterName, type, detail, over_lbs) => {
      const g = findFight(fighterName);
      if (!g) return;
      const compromised = matches(g.home, fighterName) ? g.home : g.away;
      const opponent = compromised === g.home ? g.away : g.home;
      const cl = combatLine(g, compromised), ol = combatLine(g, opponent);
      let value_remains = true;
      if (ol) value_remains = (impliedProb(ol.consensus) - impliedProb(ol.open)) < VALUE_MOVE; // opp not yet bet up
      news.push({
        game_id: g.game_id, fighter: compromised, opponent, sport: g.sport, type, detail,
        over_lbs: over_lbs ?? null, line_at_detection: cl ? cl.consensus : null,
        opp_line_at_detection: ol ? ol.consensus : null, value_remains, detected_at: iso,
      });
    };

    for (const m of data.misses || []) record(m.fighter, 'missed_weight', `missed weight by ${m.over_lbs} lbs`, m.over_lbs);
    for (const s of data.scratches || []) record(s, 'scratch', 'officially scratched');
    for (const r of data.replacements || []) { if (r.in) record(r.in, 'replacement', `short-notice replacement (for ${r.out || '?'})`); }
  }

  // Dedup against anything already recorded today for the same fight+fighter+type.
  let existing = [];
  try { existing = await db.select('combat_news', 'game_id,fighter,type,detected_at', { gte: { detected_at: today + 'T00:00:00Z' } }); } catch (_) { /* none */ }
  const seen = new Set(existing.map((e) => `${e.game_id}|${e.fighter}|${e.type}`));
  const fresh = news.filter((n) => !seen.has(`${n.game_id}|${n.fighter}|${n.type}`));
  if (fresh.length) { try { await db.insert('combat_news', fresh); } catch (e) { logger.warn('combat-weighin', e.message); } }

  const actionable = fresh.filter((n) => n.value_remains).length;
  const sports = active.map((a) => a.sport).join('+');
  return { summary: `${fresh.length} ${sports} fight-week items (${actionable} with value remaining)`, data: { items: fresh.length, actionable } };
}

export default { name: 'combat-weighin', run };
