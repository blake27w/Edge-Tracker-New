// ══════════════════════════════════════════════════════════════
// Tennis — Surface & Style Matchup (T2). Uses Jeff Sackmann's open
// match data (free) to build per-player surface win-rates, then flags
// matches where one player over-performs on the court's surface vs.
// their own baseline (surface specialist) more than the opponent — the
// edge the market underweights vs. raw ranking/form.
//
// Supporting (T2) signal: boosts a play but doesn't qualify one alone;
// qualification still needs a Tier-1 (steam or fatigue). Surface rates
// change slowly, so the Sackmann CSVs are cached and refreshed weekly.
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getTennisGames, setIntel } from '../../store/index.js';

const REFRESH_MS = 7 * 86400_000;
const MIN_SAMPLE = 15;        // min matches on a surface to trust the rate
const DELTA_GAP = 0.10;       // specialist-delta gap to flag an edge

// player(normalized) -> { all:{w,l}, Hard:{w,l}, Clay:{w,l}, Grass:{w,l} }
let RATES = null;
let loadedAt = 0;

const norm = (s) => String(s || '').toLowerCase().trim();

function sources() {
  const y = new Date().getFullYear();
  const out = [];
  for (const yr of [y, y - 1]) {
    out.push(`https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_${yr}.csv`);
    out.push(`https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_${yr}.csv`);
  }
  return out;
}

async function loadRates() {
  const rates = {};
  let rows = 0;
  for (const url of sources()) {
    let text;
    try { const res = await fetch(url); if (!res.ok) continue; text = await res.text(); }
    catch (e) { logger.warn('tennis-surface', `${url.split('/').pop()}: ${e.message}`); continue; }
    const lines = text.split('\n');
    const header = lines[0].split(',');
    const iSurf = header.indexOf('surface'), iW = header.indexOf('winner_name'), iL = header.indexOf('loser_name');
    if (iSurf < 0 || iW < 0 || iL < 0) continue;
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const surf = c[iSurf], w = norm(c[iW]), l = norm(c[iL]);
      if (!w || !l || !surf) continue;
      (rates[w] ||= {}); (rates[l] ||= {});
      ((rates[w].all ||= { w: 0, l: 0 }).w++); ((rates[l].all ||= { w: 0, l: 0 }).l++);
      ((rates[w][surf] ||= { w: 0, l: 0 }).w++); ((rates[l][surf] ||= { w: 0, l: 0 }).l++);
      rows++;
    }
  }
  RATES = rates; loadedAt = Date.now();
  return rows;
}

const pct = (r) => (r && (r.w + r.l) ? r.w / (r.w + r.l) : null);

// Surface inferred from the tournament key (covers majors/big events; else null).
function inferSurface(key) {
  const k = norm(key);
  if (/wimbledon|queen|halle|eastbourne|hertogenbosch|newport|mallorca|stuttgart/.test(k)) return 'Grass';
  if (/roland_garros|french|monte_carlo|madrid|\brome\b|barcelona|hamburg|kitzbuhel|gstaad|bastad|umag|estoril|munich|houston|geneva|lyon|cordoba|santiago|buenos/.test(k)) return 'Clay';
  return 'Hard';
}

// specialist delta = surface win% - overall win%
function delta(player, surface) {
  const p = RATES[norm(player)];
  if (!p) return null;
  const sp = pct(p[surface]), ov = pct(p.all);
  if (sp == null || ov == null) return null;
  if ((p[surface].w + p[surface].l) < MIN_SAMPLE) return null;
  return { delta: sp - ov, surfWin: sp };
}

async function run() {
  const games = getTennisGames();
  if (!games.length) { setIntel('tennisSurface', []); return { summary: 'no tennis matches' }; }
  if (!RATES || Date.now() - loadedAt > REFRESH_MS) {
    const n = await loadRates();
    if (!RATES || !Object.keys(RATES).length) return { summary: 'Sackmann data unavailable' };
    logger.info('tennis-surface', `loaded ${n} matches into surface rates`);
  }

  const now = new Date().toISOString();
  const rows = [], signals = [];
  for (const g of games) {
    const surface = inferSurface(g.tournament);
    const d1 = delta(g.p1, surface), d2 = delta(g.p2, surface);
    if (!d1 || !d2) continue;
    const gap = d1.delta - d2.delta;
    if (Math.abs(gap) < DELTA_GAP) continue;
    const favored = gap > 0 ? g.p1 : g.p2;
    const fd = gap > 0 ? d1 : d2;
    const detail = `${favored} surface specialist on ${surface} (+${Math.round(fd.delta * 100)}% vs baseline, ${Math.round(fd.surfWin * 100)}% on ${surface})`;
    rows.push({ game_id: g.game_id, p1: g.p1, p2: g.p2, surface, favored, edge: Math.round(gap * 100) / 100, detail, fetched_at: now });
    signals.push({ game_id: g.game_id, favored, detail });
  }

  if (rows.length) { try { await db.insert('tennis_matchups', rows); } catch (e) { logger.warn('tennis-surface', e.message); } }
  setIntel('tennisSurface', signals);
  return { summary: `${signals.length} surface edges across ${games.length} matches · free Sackmann`, data: { edges: signals.length } };
}

export default { name: 'tennis-surface', run };
