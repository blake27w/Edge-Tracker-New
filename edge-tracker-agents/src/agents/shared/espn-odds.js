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
import { median } from './odds-math.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// The prices attached to a line. Without these a hit rate can't be turned into
// a return: the same 52.9% is +3.3% at -105, +1.0% at -110 and -1.0% at -115.
// pickcenter entries and core-API odds items use identical field names here.
export function pricesOf(o) {
  return {
    overOdds: num(o.overOdds),
    underOdds: num(o.underOdds),
    homeSpreadOdds: num(o.homeTeamOdds?.spreadOdds),
    awaySpreadOdds: num(o.awayTeamOdds?.spreadOdds),
  };
}

// Consensus across every book quoting a game, rather than whichever record
// happened to have the most populated fields. That heuristic was harmless when
// ESPN served 2 records (2024-26: one book plus its live feed), but 2022-23
// carry 14-15, and picking the first complete one is arbitrary — one 2023 game
// quotes Caesars at -7.5 alongside two other Caesars entries at -10.5.
//
// Each field is medianed independently, because books differ on which fields
// they populate. Lines snap back to the 0.5 grid so a median of an even count
// stays a real number and pushes keep their meaning; prices round to whole
// American odds. `extract` pulls the line out of one entry, since the two
// feeds differ (core exposes `spread` directly, pickcenter sometimes only in
// `details` as "KC -6.5").
export function consensusOf(entries, extract) {
  const picks = [];
  for (const e of entries || []) {
    if (/live/i.test(e.provider?.name || '')) continue;   // in-game, not the close
    const v = extract(e);
    if (v.total == null && v.spreadHome == null) continue;
    picks.push({ ...v, ...pricesOf(e), provider: e.provider?.name || null });
  }
  if (!picks.length) return null;
  const med = (k) => {
    const col = picks.map((x) => x[k]).filter((n) => Number.isFinite(n));
    return col.length ? median(col) : null;
  };
  const grid = (v) => (v == null ? null : Math.round(v * 2) / 2);   // real line, not .25
  const whole = (v) => (v == null ? null : Math.round(v));
  return {
    total: grid(med('total')),
    spreadHome: grid(med('spreadHome')),
    overOdds: whole(med('overOdds')),
    underOdds: whole(med('underOdds')),
    homeSpreadOdds: whole(med('homeSpreadOdds')),
    awaySpreadOdds: whole(med('awaySpreadOdds')),
    books: picks.length,
    provider: picks.length === 1 ? picks[0].provider : `median of ${picks.length} books`,
  };
}

// league: 'nfl' | 'college-football'. Returns { spreadHome, total, provider }
// or null when ESPN has no line on record. Throws on a failed fetch, so the
// caller can tell "no line" apart from "couldn't ask".
export async function coreClosingOdds(league, eventId) {
  const res = await fetch(`${CORE}/${league}/events/${eventId}/competitions/${eventId}/odds`);
  if (!res.ok) throw new Error(`ESPN core odds ${res.status}`);
  const j = await res.json();
  return consensusOf(j.items, (it) => ({ total: num(it.overUnder), spreadHome: num(it.spread) }));
}
