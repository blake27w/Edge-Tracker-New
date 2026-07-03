// ══════════════════════════════════════════════════════════════
// NFL QB-Status Monitor — the sport's biggest line-mover, as a SPEED
// edge (the NFL analog of the MLB SP-scratch monitor). A starting-QB
// downgrade moves spreads 3–7 points; soft books lag the news. This
// polls ESPN's free NFL injury feed, tracks each QB's status, and the
// moment a QB's status CHANGES (e.g. Questionable → Out) it alerts and
// records the event. No fabricated point impact — the alert IS the
// edge (act before the book moves); leans stay observational.
//
// The ESPN injuries feed shape is parsed defensively and this agent is
// LOUD when it can't parse (summary says so) — validate against live
// data in preseason (Aug). Dormant outside Aug–Feb. $0.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger, notifyAll } from '../../utils/index.js';
import { setIntel } from '../../store/index.js';

const URL = process.env.NFL_INJURY_URL || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
const lastStatus = new Map(); // player name -> status
const alerted = new Set();

function inWindow() { const m = new Date().getUTCMonth(); return m >= 7 || m <= 1; } // Aug–Feb

// Pull [{team, player, position, status}] out of ESPN's injuries payload,
// tolerating the couple of shapes the site API uses.
function parse(data) {
  const out = [];
  const teams = data?.injuries || data?.items || [];
  for (const t of teams) {
    const teamName = t.displayName || t.team?.displayName || t.team?.name || null;
    for (const inj of t.injuries || t.items || []) {
      const ath = inj.athlete || inj.player || {};
      const pos = ath.position?.abbreviation || ath.position?.name || inj.position || '';
      const status = inj.status || inj.type?.description || inj.details?.type || null;
      const name = ath.displayName || ath.fullName || null;
      if (name && status) out.push({ team: teamName, player: name, position: String(pos), status: String(status) });
    }
  }
  return out;
}

async function run() {
  if (!inWindow()) { setIntel('qbWatch', []); return { summary: 'offseason — dormant (Aug–Feb)' }; }

  let data;
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`ESPN injuries ${res.status}`);
    data = await res.json();
  } catch (e) { return { summary: `ESPN injuries unavailable: ${e.message}` }; }

  const rows = parse(data);
  if (!rows.length) return { summary: 'parsed 0 injuries — ESPN feed shape may have drifted (validate!)' };

  const qbs = rows.filter((r) => /^QB$/i.test(r.position));
  const now = new Date().toISOString();
  const changes = [];
  for (const q of qbs) {
    const prev = lastStatus.get(q.player);
    lastStatus.set(q.player, q.status);
    if (prev == null || prev === q.status) continue; // baseline or unchanged
    changes.push({ team: q.team, player: q.player, old_status: prev, new_status: q.status, detected_at: now });
  }

  // Publish the current QB injury board (reference) + persist/alert changes.
  setIntel('qbWatch', qbs.map((q) => ({ team: q.team, player: q.player, status: q.status })));
  if (changes.length) {
    try { await db.insert('nfl_qb_status', changes); } catch (e) { logger.warn('nfl-qb', e.message); }
    for (const c of changes) {
      const k = `${c.player}|${c.new_status}`;
      if (alerted.has(k)) continue;
      alerted.add(k);
      const body = `🏈 QB STATUS — ${c.player}${c.team ? ` (${c.team})` : ''}: ${c.old_status} → ${c.new_status}. Biggest line-mover in the sport — check the number before the book moves.`;
      try {
        const r = await notifyAll('Edge Tracker: NFL QB status change', body);
        await db.insert('alert_log', { type: r.email && !r.sms ? 'email' : 'sms', channel: 'nfl-qb', recipients: r.total, body, sport: 'NFL', status: 'sent' });
      } catch (e) { logger.warn('nfl-qb', `alert: ${e.message}`); }
    }
  }

  return {
    summary: `${qbs.length} QBs on the injury board · ${changes.length} status change${changes.length === 1 ? '' : 's'} · free ESPN`,
    data: { qbs: qbs.length, changes: changes.length },
  };
}

export default { name: 'nfl-qb', run };
