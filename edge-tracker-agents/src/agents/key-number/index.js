// ══════════════════════════════════════════════════════════════
// Key-Number Analysis — football only (NFL/NCAAF), where margins of
// victory cluster hard on 3 and 7 (then 6/10/14/4). Flags when a book
// lets you BUY a side past a key number the field hasn't crossed —
// e.g. the field is +3 but a book hangs +3.5 (you catch the 3), or you
// can lay -2.5 when the field is -3. Free; reuses our own odds. $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setKeyNumbers } from '../../store/index.js';
import { computeMarkets } from '../../games/lines.js';
import { fmtOdds } from '../shared/odds-math.js';

const FOOTBALL = new Set(['NFL', 'NCAAF']);
// Keys in priority order; importance drives sort + display.
const KEYS = [{ k: 3, imp: 'high' }, { k: 7, imp: 'high' }, { k: 6, imp: 'med' }, { k: 10, imp: 'med' }, { k: 14, imp: 'med' }, { k: 4, imp: 'med' }];
const MIN_BOOKS = 3;

function collect(game, team) {
  const out = [];
  for (const [bk, b] of Object.entries(game.books || {})) {
    const o = (b.markets || {})[`spreads:${team}`];
    if (o && o.line != null) out.push({ book: b.label || bk, line: o.line, price: o.price });
  }
  return out;
}

async function run() {
  const games = getGames().filter((g) => FOOTBALL.has(g.sport));
  if (!games.length) { setKeyNumbers([]); return { summary: 'no football games' }; }

  const rows = [];
  for (const g of games) {
    const consH = computeMarkets(g).spread.consensusHome;
    if (consH == null || consH === 0) continue;
    const favTeam = consH < 0 ? g.home : g.away;
    const dogTeam = consH < 0 ? g.away : g.home;
    const favOuts = collect(g, favTeam); // negative lines
    const dogOuts = collect(g, dogTeam); // positive lines
    if (favOuts.length < MIN_BOOKS || dogOuts.length < MIN_BOOKS) continue;
    const consPts = Math.abs(consH);

    // Favorite: laying the fewest points = line closest to 0 (max algebraic).
    const bestFav = favOuts.reduce((a, b) => (b.line > a.line ? b : a));
    const favPts = -bestFav.line;
    // Dog: getting the most points = max line.
    const bestDog = dogOuts.reduce((a, b) => (b.line > a.line ? b : a));
    const dogPts = bestDog.line;

    // Favorite can be bought UNDER a key the field is on/above.
    for (const { k, imp } of KEYS) {
      if (favPts < k && consPts >= k) {
        rows.push({ sport: g.sport, game_id: g.game_id, commence_time: g.commence_time, matchup: `${g.away} @ ${g.home}`,
          side: favTeam, role: 'fav', book: bestFav.book, line: bestFav.line, consensus: consH, key: k, importance: imp, price: bestFav.price });
        break;
      }
    }
    // Dog can be bought OVER a key the field is on/below.
    for (const { k, imp } of KEYS) {
      if (dogPts > k && consPts <= k) {
        rows.push({ sport: g.sport, game_id: g.game_id, commence_time: g.commence_time, matchup: `${g.away} @ ${g.home}`,
          side: dogTeam, role: 'dog', book: bestDog.book, line: bestDog.line, consensus: -consH, key: k, importance: imp, price: bestDog.price });
        break;
      }
    }
  }

  const rank = { high: 0, med: 1 };
  rows.sort((a, b) => (rank[a.importance] - rank[b.importance]) || (b.key - a.key));
  setKeyNumbers(rows);

  if (rows.length) {
    const now = new Date().toISOString();
    try {
      await db.insert('line_signals', rows.map((r) => ({
        type: 'key', sport: r.sport, game_id: r.game_id, matchup: r.matchup, market: 'spread',
        side: r.side, book: r.book, line: r.line, consensus: r.consensus, pts: r.key, aligned: r.importance === 'high',
        detail: `${r.side} ${r.line > 0 ? '+' + r.line : r.line} @ ${r.book} crosses key ${r.key} (field ${r.consensus > 0 ? '+' + r.consensus : r.consensus}, ${fmtOdds(r.price)})`, fetched_at: now,
      })));
    } catch (e) { logger.warn('key-number', e.message); }
  }

  const high = rows.filter((r) => r.importance === 'high').length;
  return { summary: `${rows.length} key-number edges${high ? ` (${high} on 3/7)` : ''}`, data: { count: rows.length, high } };
}

export default { name: 'key-number', run };
