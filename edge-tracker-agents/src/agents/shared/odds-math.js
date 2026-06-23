// Shared odds math for the line-intelligence agents.
export const toDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
export const impliedProb = (a) => 1 / toDecimal(a);
export function toAmerican(prob) {
  if (!prob || prob <= 0 || prob >= 1) return null;
  const dec = 1 / prob;
  return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
}
export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export const fmtOdds = (p) => (p > 0 ? '+' + p : '' + p);

// Quote freshness: minutes since a book last changed this price (from the
// Odds API per-market last_update). null when we have no timestamp. An old age
// means the book hasn't MOVED the line — it does NOT mean the quote is gone —
// so only EXTREME ages (a likely dead/suspended market) are acted on.
export function ageMin(ts, now = Date.now()) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}
// Default: a quote unchanged for 90+ min while inside the 36h window is treated
// as a likely dead market (tunable via ODDS_STALE_MIN).
export const STALE_MIN = Number(process.env.ODDS_STALE_MIN) || 90;
