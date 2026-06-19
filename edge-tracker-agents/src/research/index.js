// ══════════════════════════════════════════════════════════════
// Research notes & picks — pasted from the Claude chat (dashboard
// form) or pushed via the MCP connector. Notes are display-only;
// picks (type 'pick') carry market/side/line and get graded by the
// grading agent so research earns its own track record.
// ══════════════════════════════════════════════════════════════
import db from '../db/index.js';

export async function listResearch({ limit = 200, game_id, sport, type } = {}) {
  if (!db.isConnected()) return [];
  const opts = { order: { column: 'created_at', ascending: false }, limit };
  const match = {};
  if (game_id) match.game_id = game_id;
  if (sport) match.sport = sport;
  if (type) match.type = type;
  if (Object.keys(match).length) opts.match = match;
  try { return await db.select('research_notes', '*', opts); } catch (_) { return []; }
}

export async function addResearch(d = {}) {
  if (!db.isConnected()) throw new Error('no DB configured');
  const isPick = d.type === 'pick';
  const body = (d.body || d.note || '').toString().slice(0, 4000);
  if (!body && !isPick) throw new Error('note body required');
  const row = {
    type: isPick ? 'pick' : 'note',
    source: d.source === 'chat' ? 'chat' : 'manual',
    sport: d.sport ? String(d.sport).toUpperCase() : null,
    game_id: d.game_id || null,
    matchup: d.matchup || null,
    body: body || null,
    market: isPick ? (d.market || null) : null,
    side: isPick ? (d.side || null) : null,
    line: isPick && d.line != null && d.line !== '' ? Number(d.line) : null,
    odds: isPick && d.odds != null && d.odds !== '' ? parseInt(d.odds, 10) : null,
    confidence: d.confidence != null && d.confidence !== '' ? Number(d.confidence) : null,
    status: isPick ? 'pending' : 'active',
    created_at: new Date().toISOString(),
  };
  const res = await db.insert('research_notes', row);
  return res?.data?.[0] || row;
}

export async function deleteResearch(id) {
  if (!db.isConnected()) throw new Error('no DB configured');
  if (!id) throw new Error('id required');
  await db.del('research_notes', { match: { id } });
  return { ok: true };
}

export default { listResearch, addResearch, deleteResearch };
