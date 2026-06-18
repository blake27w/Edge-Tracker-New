// ══════════════════════════════════════════════════════════════
// Line math shared by the odds agent (opening-line capture) and the
// games board (current consensus + best-book price shopping).
// ══════════════════════════════════════════════════════════════

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

// Given a normalized game (with .books), compute consensus lines and the
// best available price per side across the tracked books.
export function computeMarkets(game) {
  const books = game.books || {};
  const home = game.home, away = game.away;
  const totalLines = [], spreadHome = [], mlHome = [], mlAway = [];
  let bestUnder = null, bestOver = null, bestMlHome = null, bestMlAway = null;

  for (const [bk, b] of Object.entries(books)) {
    const label = b.label || bk;
    const mk = b.markets || {};
    const ov = mk['totals:Over'], un = mk['totals:Under'];
    if (ov && ov.line != null) totalLines.push(ov.line);
    if (un && un.price != null && (!bestUnder || un.price > bestUnder.price)) bestUnder = { book: label, line: un.line, price: un.price };
    if (ov && ov.price != null && (!bestOver || ov.price > bestOver.price)) bestOver = { book: label, line: ov.line, price: ov.price };
    const sh = mk[`spreads:${home}`]; if (sh && sh.line != null) spreadHome.push(sh.line);
    const mh = mk[`h2h:${home}`]; if (mh && mh.price != null) { mlHome.push(mh.price); if (!bestMlHome || mh.price > bestMlHome.price) bestMlHome = { book: label, price: mh.price }; }
    const ma = mk[`h2h:${away}`]; if (ma && ma.price != null) { mlAway.push(ma.price); if (!bestMlAway || ma.price > bestMlAway.price) bestMlAway = { book: label, price: ma.price }; }
  }

  return {
    total: { consensus: median(totalLines), bestUnder, bestOver },
    spread: { consensusHome: median(spreadHome) },
    ml: { consensusHome: median(mlHome), consensusAway: median(mlAway), bestHome: bestMlHome, bestAway: bestMlAway },
  };
}

export default { computeMarkets };
