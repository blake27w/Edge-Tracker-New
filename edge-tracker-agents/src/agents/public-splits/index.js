// ══════════════════════════════════════════════════════════════
// Public Betting Splits (Agent 8) — HIGHEST-VALUE addition.
// Fetches % of bets and % of handle per game/market via Claude web
// search (sportsbettingdime + DK Network). Detects:
//   • bets% vs handle% divergence  (more money than tickets = sharp side)
//   • lopsided public positions     (70%+ on one side)
//   • RLM: line NOT moving into — or moving AGAINST — heavy public money
// "RLM against 70%+ public" is emitted as a Tier-1 signal (rlm:true) —
// the most reliable winning signal from manual testing.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { claudeJson, hasClaude, claudeBlockReason, logger } from '../../utils/index.js';
import { getGames, getIntel, setIntel } from '../../store/index.js';

const SPLIT_SPORTS = new Set(['NHL', 'NBA', 'MLB', 'NFL']);

// Line-movement indexes from the latest odds run, split by market so RLM can
// be judged per SIDE (the old game|market sum mixed both sides' moves).
//   totals: net move of the game total (Over rows carry the total's line)
//   spreads: net move of EACH TEAM's own line (side = team name)
// A key is present ONLY when a row carried a real, finite `moved`. The old
// `(m.moved || 0)` turned a row with no magnitude (null, '', NaN) into a 0
// entry, i.e. "this line did not move", when the truth is "this row cannot
// say" — and readers treat a present 0 and an absent key very differently.
// Type-check before coercing (house rule); a row without a usable `moved`
// adds no entry, so its absence stays visible downstream.
// `typeof m.moved !== 'number'` deliberately rejects numeric STRINGS too: the
// only producer (odds' movementsAll) emits numbers, so a future DB-shaped
// producer handing over '1.5' would be silently dropped here, not coerced.
function moveIndexes(moves) {
  const total = new Map(), spread = new Map();
  for (const m of moves || []) {
    if (!m || typeof m.moved !== 'number' || !Number.isFinite(m.moved)) continue;
    if (m.market === 'totals') {
      if (String(m.side).toLowerCase() === 'over') total.set(m.game_id, (total.get(m.game_id) || 0) + m.moved);
    } else if (m.market === 'spreads') {
      const k = `${m.game_id}|${String(m.side).toLowerCase()}`;
      spread.set(k, (spread.get(k) || 0) + m.moved);
    }
  }
  return { total, spread };
}

// Resolve the public side to over/under/home/away using the actual game's team
// names (surname included) — the old check only matched the word "home" or a
// "-" in the string, so team-named sides fell through and RLM under-fired.
const sur = (t) => String(t || '').toLowerCase().split(' ').pop();
export function resolveSide(g, market, side) {
  const s = String(side || '').toLowerCase();
  if (market === 'total') return s.includes('over') ? 'over' : s.includes('under') ? 'under' : null;
  if (s.includes('home')) return 'home';
  if (s.includes('away')) return 'away';
  if (g) {
    if (s.includes(String(g.home).toLowerCase()) || s.includes(sur(g.home))) return 'home';
    if (s.includes(String(g.away).toLowerCase()) || s.includes(sur(g.away))) return 'away';
  }
  return null;
}

// Public % last seen per game|market|side — a surge (pile-on) is its own tell.
const prevBets = new Map();

async function run() {
  if (!hasClaude()) return { summary: 'skipped — no Claude', blocked: claudeBlockReason() };
  const games = getGames().filter((g) => SPLIT_SPORTS.has(g.sport));
  if (!games.length) return { summary: 'no slate for public splits' };

  const slate = games.map((g) => `${g.sport}: ${g.away} @ ${g.home} [${g.game_id}]`).join('\n');
  const prompt = `You are a betting-market analyst. For each game below, search public betting trends (sportsbettingdime.com public-betting-trends pages, DraftKings Network splits, covers.com consensus, VSiN betting splits) and return ONLY JSON: an array of objects with keys:
  game_id, sport, market (spread|total|ml), side (the public side, e.g. "Over", "Home -3.5", "AwayML"),
  bets_pct (number, % of tickets on that side), handle_pct (number, % of money on that side).
Report the side the public is on for each market you can find. Copy game_id exactly. Max 60 entries.

GAMES:
${slate}`;

  const json = await claudeJson(prompt, { maxTokens: 3500 });
  const list = Array.isArray(json) ? json : [];
  // `movementsAll`, NOT `movements`: the latter is odds' gap-filtered STEAM
  // feed, and the question here is not simultaneity but "did the public's own
  // number move at all". A movement withheld by that filter would be a hole in
  // this index, and a hole is read as "no movement data", not as a freeze — so
  // a real RLM off a mid- or idle-tier refetch would be silently LOST rather
  // than mis-called. See the two-feed note in src/agents/odds/index.js.
  const moves = moveIndexes(getIntel('movementsAll'));
  const byId = {}; for (const g of games) byId[g.game_id] = g;
  const now = new Date().toISOString();

  const rows = [];
  let noMoveData = 0; // lopsided rows the RLM/freeze rule could not judge
  for (const r of list) {
    if (!r || !r.game_id) continue;
    const bets = pct(r.bets_pct);
    const handle = pct(r.handle_pct);
    const divergence = bets != null && handle != null ? Math.round((handle - bets) * 10) / 10 : null;
    const lopsided = bets != null && bets >= 70;
    const mk = marketKey(r.market);
    const g = byId[r.game_id];
    const resolved = resolveSide(g, mk, r.side);

    // RLM / FREEZE — judged on the PUBLIC side's own number. One unified rule:
    // books never gift the crowd, so if the heavy side's number moved MORE
    // favorable for its backers, respected money is on the other side (RLM).
    // If it barely moved at all despite the crowd (freeze), books are content
    // taking that action — a weaker version of the same tell. ML has no line
    // history here, so it stays out of both.
    //
    // "Nothing happened" and "I cannot see it" must not look the same: a game
    // with NO movement row is not a line that moved zero. The old `?? 0`
    // collapsed the two, and `freeze` then published "I have no data" as a
    // tell. When the index has no entry for the public side's number, the row
    // says so — net_move null AND rlm/freeze null (not judged), which every
    // reader already treats as "no tell" — and the run counts it.
    //
    // The same holds when no index can even be CHOSEN: a spread row whose
    // game_id is off the slate (side resolved by the literal "home"/"away"
    // substring, no team to key on) is a row the rule could not judge, so it
    // is null/null/null and counted — not a judged `false`. ML is the one
    // intentional exception: it has no line history here by design, so its
    // `false` means "this rule does not apply", and it is not counted.
    let rlm = false, freeze = false, netMove = null;
    if (lopsided && resolved && mk !== 'ml') {
      let idx = null, key = null;
      if (mk === 'total' && (resolved === 'over' || resolved === 'under')) {
        idx = moves.total; key = r.game_id;
      } else if (mk === 'spread' && g && (resolved === 'home' || resolved === 'away')) {
        const team = resolved === 'home' ? g.home : g.away;
        idx = moves.spread; key = `${r.game_id}|${String(team).toLowerCase()}`;
      }
      if (!idx || !idx.has(key)) {
        rlm = null; freeze = null; noMoveData++;
      } else {
        netMove = idx.get(key);
        // Over backers are gifted by the total DROPPING; Under backers by it
        // rising. A spread side's own line rising = its backers get a better
        // number = gifted.
        rlm = mk === 'total' && resolved === 'over' ? netMove <= -0.5 : netMove >= 0.5;
        freeze = !rlm && Math.abs(netMove) < 0.5;
      }
    }

    // Pile-on: the public share SURGED since our last look (late square money).
    const pk = `${r.game_id}|${mk}|${String(r.side || '').toLowerCase()}`;
    const prior = prevBets.get(pk);
    const pileon = prior != null && bets != null && bets - prior >= 10;
    if (bets != null) prevBets.set(pk, bets);

    rows.push({
      sport: r.sport || null, game_id: r.game_id, market: mk, side: r.side || null,
      bets_pct: bets, handle_pct: handle, divergence, rlm, freeze, pileon, net_move: netMove,
      line_open: null, line_current: null, source: 'claude-web', fetched_at: now,
    });
  }

  if (rows.length) {
    try { await db.insert('public_splits', rows); } catch (e) { logger.warn('public-splits', e.message); }
  }
  setIntel('splits', rows);
  const rlmCount = rows.filter((r) => r.rlm).length;
  const freezeCount = rows.filter((r) => r.freeze).length;
  const pileCount = rows.filter((r) => r.pileon).length;
  return {
    summary: `${rows.length} splits · ${rlmCount} RLM (T1) · ${freezeCount} freeze · ${pileCount} pile-on · ${noMoveData} no line data`,
    data: { count: rows.length, rlm: rlmCount, freeze: freezeCount, pileon: pileCount, noMoveData },
  };
}

function marketKey(m) {
  const s = String(m || '').toLowerCase();
  if (s.includes('total') || s.includes('o/u') || s.includes('ou')) return 'total';
  if (s.includes('spread') || s.includes('puck') || s.includes('run')) return 'spread';
  return 'ml';
}
// A public percentage is PRESENT or it is null — never a coerced 0. The old
// `num()` validated the coercion, not the input: `Number(null)`, `Number('')`
// and `Number(false)` are all a finite 0, so a Claude row with `bets_pct: null`
// published as "0% tickets", `divergence = handle - 0` became a large fake
// sharp-side tell, and the 0 was written to `prevBets` so the NEXT run's real
// 75% fired pile-on. Type-check before coercing (house rule): only a number or
// a non-blank numeric string is a reading; a genuine 0 stays 0.
function pct(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default { name: 'public-splits', run };
