// ══════════════════════════════════════════════════════════════
// ESPN closing-odds fallback (free).
//
// site.api's `/summary` carries a `pickcenter` block, but ESPN empties it for
// older games — the key stays, the array goes to `[]`. That's why the history
// agents were missing ~79% of their games, not rate-limiting. The core API
// keeps the same numbers indefinitely, so we fall back to it.
//
// Both feeds report `spread` from the HOME team's perspective (negative = home
// favored), which is what the callers already assume.
//
// Providers whose name contains "Live" are in-game snapshots, not closing
// numbers — on ORE/MSU 2024 the close was 52.5 and the live entry read 39.5 —
// so they're skipped here or they'd poison the totals.
// ══════════════════════════════════════════════════════════════
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues';

// league: 'nfl' | 'college-football'. Returns { spreadHome, total, provider }
// or null when ESPN has no line on record. Throws on a failed fetch, so the
// caller can tell "no line" apart from "couldn't ask".
export async function coreClosingOdds(league, eventId) {
  const res = await fetch(`${CORE}/${league}/events/${eventId}/competitions/${eventId}/odds`);
  if (!res.ok) throw new Error(`ESPN core odds ${res.status}`);
  const j = await res.json();
  let best = null;
  for (const it of j.items || []) {
    if (/live/i.test(it.provider?.name || '')) continue;
    const total = Number(it.overUnder);
    const spreadHome = Number(it.spread);
    const score = (Number.isFinite(total) ? 1 : 0) + (Number.isFinite(spreadHome) ? 1 : 0);
    if (score && (!best || score > best.score)) {
      best = {
        score,
        total: Number.isFinite(total) ? total : null,
        spreadHome: Number.isFinite(spreadHome) ? spreadHome : null,
        provider: it.provider?.name || null,
      };
    }
  }
  return best;
}
