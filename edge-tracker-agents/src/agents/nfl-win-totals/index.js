// ══════════════════════════════════════════════════════════════
// NFL Season Win-Totals Scanner. The classic offseason play: compare a
// model's projected wins to the posted Over/Under for each team.
//   Model wins = sum of per-game Elo win probabilities over the team's
//   actual schedule, using the preseason power ratings (nfl-power).
//   Posted totals come via a throttled Claude web lookup (no clean free
//   feed for season win totals). We flag teams where model − posted
//   exceeds a threshold, and devig the O/U prices to show the book's lean.
// OBSERVATIONAL — graded only after the season completes. Strict, $0 plus
// one metered Claude call per day.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger, hasClaude, claudeJson } from '../../utils/index.js';
import { getPower, setNflWinTotals } from '../../store/index.js';
import { getSeasonSchedule, teamSchedules, upcomingSeason, norm } from '../shared/nfl.js';
import { impliedProb } from '../shared/odds-math.js';

const HFA = 55;                                            // Elo home-field, matches nfl-power
const EDGE = Number(process.env.NFL_WINTOTAL_EDGE) || 1.3; // flag at |model − posted| ≥ this many wins
const REFRESH_MS = 20 * 3600_000;                          // posted totals refresh ~daily
let lastFetch = 0, lastPosted = [];

const winProb = (self, opp, home) => 1 / (1 + Math.pow(10, (opp - (self + (home ? HFA : 0))) / 400));
const matchTeam = (name, teams) => teams.find((t) => { const x = norm(t), y = norm(name); return x === y || x.includes(y) || y.includes(x) || x.split(' ').pop() === y.split(' ').pop(); });

// Posted Over/Under win totals for all 32 teams (throttled Claude lookup).
async function fetchPosted() {
  if (Date.now() - lastFetch < REFRESH_MS && lastPosted.length) return lastPosted;
  if (!hasClaude()) return lastPosted;
  const season = upcomingSeason();
  const prompt = `Current posted ${season} NFL regular-season WIN TOTALS (over/under, 17 games) from a major US sportsbook (e.g. DraftKings or FanDuel).\n` +
    `Return STRICT JSON: {"totals":[{"team":"<full team name>","total":<number, e.g. 9.5>,"over_price":<american odds>,"under_price":<american odds>}]}.\n` +
    `Include all 32 teams if available. Use the current consensus number. Omit a team only if no total is posted. If none are posted yet, return {"totals":[]}.`;
  try {
    const data = await claudeJson(prompt, { maxTokens: 2000 });
    if (data && Array.isArray(data.totals)) { lastPosted = data.totals.filter((t) => t && t.team && Number.isFinite(+t.total)); lastFetch = Date.now(); }
  } catch (e) { logger.warn('nfl-win-totals', `posted fetch: ${e.message}`); }
  return lastPosted;
}

async function run() {
  const power = getPower('NFL');
  const teams = Object.keys(power);
  if (teams.length < 24) { setNflWinTotals([]); return { summary: 'preseason power ratings not ready (run nfl-power)' }; }

  const season = upcomingSeason();
  let sched;
  try { sched = await getSeasonSchedule(season); }
  catch (e) { return { summary: `schedule fetch failed: ${e.message}` }; }
  if (!sched.length) { setNflWinTotals([]); return { summary: `no ${season} schedule posted yet` }; }

  // Model expected wins per team over its real schedule.
  const bySched = teamSchedules(sched);
  const ratingOf = (team) => (power[team]?.rating ?? 1500);
  const model = {}; // team -> expected wins
  for (const [team, games] of Object.entries(bySched)) {
    let w = 0;
    for (const g of games) {
      const opp = matchTeam(g.opp, teams);
      w += winProb(ratingOf(team), opp ? ratingOf(opp) : 1500, g.home);
    }
    model[team] = Math.round(w * 10) / 10;
  }

  const posted = await fetchPosted();
  const now = new Date().toISOString();
  const rows = [];
  for (const p of posted) {
    const team = matchTeam(p.team, Object.keys(model));
    if (!team) continue;
    const mWins = model[team];
    const edge = Math.round((mWins - p.total) * 10) / 10;
    // Devig the O/U prices to show the book's own lean on the number.
    let fairOver = null;
    if (Number.isFinite(+p.over_price) && Number.isFinite(+p.under_price)) {
      const o = impliedProb(+p.over_price), u = impliedProb(+p.under_price);
      if (o && u) fairOver = Math.round((o / (o + u)) * 1000) / 10;
    }
    rows.push({
      season, team, posted_total: +p.total, model_wins: mWins, edge,
      side: edge > 0 ? 'Over' : 'Under', over_price: +p.over_price || null,
      under_price: +p.under_price || null, fair_over_pct: fairOver,
      qualified: Math.abs(edge) >= EDGE, observational: true, updated_at: now,
    });
  }
  rows.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  setNflWinTotals(rows);

  if (rows.length) { try { await db.upsert('nfl_win_totals', rows.map(({ qualified, observational, ...r }) => r), 'season,team'); } catch (e) { logger.warn('nfl-win-totals', e.message); } }

  const flagged = rows.filter((r) => r.qualified).length;
  return { summary: posted.length ? `${rows.length} teams priced · ${flagged} edges ≥${EDGE} wins` : `model ready (${teams.length} teams) · no posted totals yet`, data: { priced: rows.length, flagged } };
}

export default { name: 'nfl-win-totals', run };
