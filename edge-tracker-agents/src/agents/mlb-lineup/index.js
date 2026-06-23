// ══════════════════════════════════════════════════════════════
// MLB Lineup / Pitcher-Scratch monitor — a pure SPEED edge. A late
// starting-pitcher change is one of the biggest line movers in baseball,
// and soft books lag the news by minutes. This polls the slate often
// (StatsAPI, free, no key), snapshots each game's probable starters, and
// when a starter CHANGES from what we last saw, it pulls both pitchers'
// season ERA to gauge the swing and emits:
//   • an instant alert (the speed edge — act before the book moves), and
//   • a totals lean the signal engine reads as a supporting (Tier-2)
//     signal: a downgrade (worse replacement) → Over, an upgrade → Under.
// Observational + CLV-validated like everything else. Cold start just
// records the baseline (no alert on first sight). $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';

const ERA_SWING = Number(process.env.SP_ERA_SWING) || 1.0; // ERA delta to call a directional lean
function ymd(d) { return d.toISOString().slice(0, 10); }

// game_id|side -> { id, name } seen last run; and changes we've already alerted.
const lastSP = new Map();
const alerted = new Set();

async function fetchSlate(dateStr) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB StatsAPI ${res.status}`);
  return res.json();
}

// Season ERA for a pitcher id (null if unavailable — never block on it).
async function seasonEra(id) {
  if (!id) return null;
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/people/${id}?hydrate=stats(group=[pitching],type=[season])`);
    if (!res.ok) return null;
    const data = await res.json();
    const splits = data.people?.[0]?.stats?.[0]?.splits || [];
    const era = splits[0]?.stat?.era;
    const n = parseFloat(era);
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}

async function run() {
  const games = getGames().filter((g) => g.sport === 'MLB');
  if (!games.length) { setIntel('lineup', []); return { summary: 'no MLB games on the slate' }; }

  let data;
  try { data = await fetchSlate(ymd(new Date())); }
  catch (e) { return { summary: `MLB StatsAPI unavailable: ${e.message}` }; }

  // Map today's probables by "Away@Home".
  const probs = {};
  for (const day of data.dates || []) {
    for (const gm of day.games || []) {
      const home = gm.teams?.home?.team?.name, away = gm.teams?.away?.team?.name;
      if (!home || !away) continue;
      probs[`${away}@${home}`] = {
        home: { id: gm.teams?.home?.probablePitcher?.id || null, name: gm.teams?.home?.probablePitcher?.fullName || null },
        away: { id: gm.teams?.away?.probablePitcher?.id || null, name: gm.teams?.away?.probablePitcher?.fullName || null },
      };
    }
  }

  const now = new Date().toISOString();
  const leanByGame = {};   // game_id -> 'over' | 'under'
  const changes = [];
  for (const g of games) {
    const p = probs[`${g.away}@${g.home}`];
    if (!p) continue;
    for (const side of ['home', 'away']) {
      const cur = p[side];
      if (!cur.name) continue;
      const key = `${g.game_id}|${side}`;
      const prev = lastSP.get(key);
      lastSP.set(key, cur);
      // First time we see this game's starter → baseline only, no alert.
      if (!prev || !prev.name) continue;
      if (prev.id === cur.id || prev.name === cur.name) continue; // unchanged
      // Real change → measure the swing.
      const [oldEra, newEra] = await Promise.all([seasonEra(prev.id), seasonEra(cur.id)]);
      let lean = null;
      if (oldEra != null && newEra != null) {
        if (newEra - oldEra >= ERA_SWING) lean = 'over';      // worse replacement → more runs
        else if (oldEra - newEra >= ERA_SWING) lean = 'under'; // better replacement → fewer runs
      }
      const team = side === 'home' ? g.home : g.away;
      if (lean) leanByGame[g.game_id] = lean;
      changes.push({
        game_id: g.game_id, sport: 'MLB', matchup: `${g.away} @ ${g.home}`, team, side,
        old_pitcher: prev.name, new_pitcher: cur.name,
        old_era: oldEra, new_era: newEra, lean, detected_at: now,
      });
    }
  }

  // Publish per-game leans for the signal engine (totals supporting signal).
  const rows = Object.entries(leanByGame).map(([game_id, lean]) => {
    const c = changes.find((x) => x.game_id === game_id && x.lean === lean);
    return { game_id, sport: 'MLB', lean, note: c ? `SP change ${c.team}: ${c.old_pitcher}→${c.new_pitcher} (ERA ${c.old_era}→${c.new_era})` : 'SP change' };
  });
  setIntel('lineup', rows);

  // Persist + alert the changes (the speed edge), deduped.
  if (changes.length) {
    try { await db.insert('pitcher_changes', changes); } catch (e) { logger.warn('mlb-lineup', e.message); }
    for (const c of changes) {
      const k = `${c.game_id}|${c.side}|${c.new_pitcher}`;
      if (alerted.has(k)) continue;
      alerted.add(k);
      const dir = c.lean === 'over' ? ' → Over lean' : c.lean === 'under' ? ' → Under lean' : '';
      const body = `🔄 MLB SP change — ${c.matchup}: ${c.team} ${c.old_pitcher} → ${c.new_pitcher}${c.old_era != null ? ` (ERA ${c.old_era}→${c.new_era})` : ''}${dir}. Act before the book moves.`;
      try {
        const r = await notifyAll('Edge Tracker: MLB pitcher change', body);
        await db.insert('alert_log', { type: r.email && !r.sms ? 'email' : 'sms', channel: 'lineup', recipients: r.total, body, sport: 'MLB', game_id: c.game_id, status: 'sent' });
      } catch (e) { logger.warn('mlb-lineup', `alert: ${e.message}`); }
    }
  }

  return {
    summary: `${changes.length} SP change${changes.length === 1 ? '' : 's'} (${rows.length} with a lean) · ${Object.keys(probs).length} games tracked · free StatsAPI`,
    data: { changes: changes.length, leans: rows.length },
  };
}

export default { name: 'mlb-lineup', run };
