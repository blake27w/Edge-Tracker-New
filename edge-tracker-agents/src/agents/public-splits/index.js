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
import { claudeJson, hasClaude, logger } from '../../utils/index.js';
import { getGames, getIntel, setIntel } from '../../store/index.js';

const SPLIT_SPORTS = new Set(['NHL', 'NBA', 'MLB', 'NFL']);

// Net line move per game+market from the latest odds run (consensus direction).
function moveIndex(moves) {
  const idx = new Map(); // game_id|market -> net moved (positive = up, negative = down)
  for (const m of moves) {
    const key = `${m.game_id}|${m.market}`;
    idx.set(key, (idx.get(key) || 0) + (m.moved || 0));
  }
  return idx;
}

async function run() {
  if (!hasClaude()) return { summary: 'skipped — no Claude' };
  const games = getGames().filter((g) => SPLIT_SPORTS.has(g.sport));
  if (!games.length) return { summary: 'no slate for public splits' };

  const slate = games.map((g) => `${g.sport}: ${g.away} @ ${g.home} [${g.game_id}]`).join('\n');
  const prompt = `You are a betting-market analyst. For each game below, search public betting trends (sportsbettingdime.com public-betting-trends pages, DraftKings Network splits) and return ONLY JSON: an array of objects with keys:
  game_id, sport, market (spread|total|ml), side (the public side, e.g. "Over", "Home -3.5", "AwayML"),
  bets_pct (number, % of tickets on that side), handle_pct (number, % of money on that side).
Report the side the public is on for each market you can find. Copy game_id exactly. Max 60 entries.

GAMES:
${slate}`;

  const json = await claudeJson(prompt, { maxTokens: 3500 });
  const list = Array.isArray(json) ? json : [];
  const moves = moveIndex(getIntel('movements'));
  const now = new Date().toISOString();

  const rows = [];
  for (const r of list) {
    if (!r || !r.game_id) continue;
    const bets = num(r.bets_pct);
    const handle = num(r.handle_pct);
    const divergence = bets != null && handle != null ? Math.round((handle - bets) * 10) / 10 : null;
    const lopsided = bets != null && bets >= 70;

    // RLM: heavy public on a side, but the line moved AGAINST that side.
    // totals: public Over (line should rise); if it fell → RLM Under.
    const net = moves.get(`${r.game_id}|${marketKey(r.market)}`) ?? 0;
    let rlm = false;
    if (lopsided) {
      const side = String(r.side || '').toLowerCase();
      const publicIsOverOrFav = side.includes('over') || side.includes('home') || side.includes('fav') || side.includes('-');
      // If the public is on the "up" side but line moved down (or vice versa).
      if (publicIsOverOrFav && net < 0) rlm = true;
      if (!publicIsOverOrFav && net > 0) rlm = true;
    }

    rows.push({
      sport: r.sport || null, game_id: r.game_id, market: marketKey(r.market), side: r.side || null,
      bets_pct: bets, handle_pct: handle, divergence, rlm,
      line_open: null, line_current: null, source: 'claude-web', fetched_at: now,
    });
  }

  if (rows.length) {
    try { await db.insert('public_splits', rows); } catch (e) { logger.warn('public-splits', e.message); }
  }
  setIntel('splits', rows);
  const rlmCount = rows.filter((r) => r.rlm).length;
  return {
    summary: `${rows.length} splits, ${rlmCount} RLM-vs-public (T1)`,
    data: { count: rows.length, rlm: rlmCount },
  };
}

function marketKey(m) {
  const s = String(m || '').toLowerCase();
  if (s.includes('total') || s.includes('o/u') || s.includes('ou')) return 'total';
  if (s.includes('spread') || s.includes('puck') || s.includes('run')) return 'spread';
  return 'ml';
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export default { name: 'public-splits', run };
