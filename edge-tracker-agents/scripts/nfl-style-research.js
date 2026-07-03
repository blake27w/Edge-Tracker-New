// ══════════════════════════════════════════════════════════════
// NFL offensive-style & defensive-funnel research — free (ESPN).
//
// Run:  node scripts/nfl-style-research.js        (~8-12 min, ~600 fetches)
//
// Measures each team's SCHEME FINGERPRINT from what actually happened —
// no scheme labels, no narrative:
//   OFFENSE: plays/g proxy, pass rate, reception share by position
//            (WR/TE/RB), WR1 concentration, lead-back carry share →
//            the KEY POSITION each offense funnels volume through.
//   DEFENSE: the same shares ALLOWED, indexed vs league average →
//            positional funnels (e.g. "+25% TE production allowed").
//   PERSISTENCE: 2024 vs 2025 year-over-year correlation per metric →
//            which style stats are projectable into 2026 at all.
//
// Positions come from each box score's athlete data when present, else
// from current team rosters (position rarely changes even when teams do).
// Unmatched players are counted honestly as UNK, never guessed.
// ══════════════════════════════════════════════════════════════

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const norm = (s) => String(s || '').toLowerCase();
const POS_GROUPS = ['WR', 'TE', 'RB', 'QB'];

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// name -> position from all 32 current rosters (fallback when the box score
// doesn't carry position). ~33 free calls.
async function rosterPositions() {
  const map = new Map();
  let teams = [];
  try { teams = (await getJson(`${BASE}/teams?limit=40`))?.sports?.[0]?.leagues?.[0]?.teams || []; } catch (_) { return map; }
  for (const t of teams) {
    const id = t.team?.id;
    if (!id) continue;
    try {
      const r = await getJson(`${BASE}/teams/${id}/roster`);
      for (const grp of r.athletes || []) {
        for (const a of grp.items || []) {
          const pos = a.position?.abbreviation;
          if (a.displayName && pos) map.set(norm(a.displayName), pos);
        }
      }
    } catch (_) { /* skip team */ }
  }
  return map;
}

async function seasonEventIds(year) {
  const ids = [];
  for (let w = 1; w <= 18; w++) {
    try {
      const data = await getJson(`${BASE}/scoreboard?dates=${year}&seasontype=2&week=${w}`);
      for (const ev of data.events || []) if ((ev.competitions || [])[0]?.status?.type?.completed) ids.push(ev.id);
    } catch (_) { /* skip */ }
  }
  return ids;
}

const statNum = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-\/]/g, '').split('/').pop()); return Number.isFinite(n) ? n : null; };
const frac = (v) => { const p = String(v ?? '').split('/'); return p.length === 2 ? { c: parseFloat(p[0]), a: parseFloat(p[1]) } : null; };

// One game → per-team { passAtt, rushAtt, recByPos, carriesByRb: {player:carries}, recByPlayer } for offense + who the opponent was.
function extractTeams(box, posOf) {
  const out = [];
  for (const team of box?.players || []) {
    const name = team.team?.displayName;
    if (!name) continue;
    const T = { team: name, passAtt: 0, rushAtt: 0, rec: { WR: 0, TE: 0, RB: 0, QB: 0, UNK: 0 }, recTotal: 0, carries: {}, recByPlayer: {} };
    for (const grp of team.statistics || []) {
      const gname = norm(grp.name || grp.text || grp.type);
      const labels = (grp.labels || grp.keys || []).map((s) => String(s).toUpperCase());
      const idx = (l) => labels.indexOf(l);
      for (const a of grp.athletes || []) {
        const player = a.athlete?.displayName;
        if (!player) continue;
        const pos = a.athlete?.position?.abbreviation || posOf.get(norm(player)) || 'UNK';
        if (gname.includes('passing')) {
          const i = idx('C/ATT'); const f = i >= 0 ? frac(a.stats?.[i]) : null;
          if (f && Number.isFinite(f.a)) T.passAtt += f.a;
        }
        if (gname.includes('rushing')) {
          const i = idx('CAR'); const c = i >= 0 ? statNum(a.stats?.[i]) : null;
          if (c) { T.rushAtt += c; T.carries[player] = (T.carries[player] || 0) + c; }
        }
        if (gname.includes('receiving')) {
          const i = idx('REC'); const r = i >= 0 ? statNum(a.stats?.[i]) : null;
          if (r) {
            const bucket = POS_GROUPS.includes(pos) ? pos : 'UNK';
            T.rec[bucket] += r; T.recTotal += r;
            T.recByPlayer[player] = (T.recByPlayer[player] || 0) + r;
          }
        }
      }
    }
    out.push(T);
  }
  // attach opponents
  if (out.length === 2) { out[0].opp = out[1].team; out[1].opp = out[0].team; }
  return out;
}

// Aggregate a season: per-team offense profile + what each DEFENSE allowed.
async function seasonProfiles(year, posOf, label) {
  const ids = await seasonEventIds(year);
  const off = new Map(), def = new Map();
  const bump = (map, team) => map.get(team) || map.set(team, { g: 0, passAtt: 0, rushAtt: 0, rec: { WR: 0, TE: 0, RB: 0, QB: 0, UNK: 0 }, recTotal: 0, topRb: 0, rbAtt: 0, wr1: 0, playerRec: {}, playerCar: {} }).get(team);
  let done = 0, unk = 0, recAll = 0;
  for (const id of ids) {
    let box;
    try { box = (await getJson(`${BASE}/summary?event=${id}`))?.boxscore; } catch (_) { continue; }
    for (const T of extractTeams(box, posOf)) {
      const o = bump(off, T.team);
      o.g++; o.passAtt += T.passAtt; o.rushAtt += T.rushAtt; o.recTotal += T.recTotal;
      for (const p of Object.keys(T.rec)) o.rec[p] += T.rec[p];
      unk += T.rec.UNK; recAll += T.recTotal;
      for (const [pl, c] of Object.entries(T.carries)) o.playerCar[pl] = (o.playerCar[pl] || 0) + c;
      for (const [pl, r] of Object.entries(T.recByPlayer)) o.playerRec[pl] = (o.playerRec[pl] || 0) + r;
      if (T.opp) {
        const d = bump(def, T.opp);
        d.g++; d.passAtt += T.passAtt; d.rushAtt += T.rushAtt; d.recTotal += T.recTotal;
        for (const p of Object.keys(T.rec)) d.rec[p] += T.rec[p];
      }
    }
    done++;
    if (done % 25 === 0) process.stdout.write(`\r[${label}] ${done}/${ids.length} games `);
  }
  console.log(`\r[${label}] ${done}/${ids.length} games done (unmatched-position receptions: ${recAll ? Math.round((unk / recAll) * 100) : 0}%)`);
  // finalize vectors
  const vec = new Map();
  for (const [team, o] of off) {
    const plays = (o.passAtt + o.rushAtt) / o.g;
    const carVals = Object.values(o.playerCar).sort((a, b) => b - a);
    const recVals = Object.values(o.playerRec).sort((a, b) => b - a);
    vec.set(team, {
      plays: Math.round(plays * 10) / 10,
      passRate: Math.round((o.passAtt / (o.passAtt + o.rushAtt)) * 1000) / 10,
      wrShare: Math.round((o.rec.WR / (o.recTotal || 1)) * 1000) / 10,
      teShare: Math.round((o.rec.TE / (o.recTotal || 1)) * 1000) / 10,
      rbShare: Math.round((o.rec.RB / (o.recTotal || 1)) * 1000) / 10,
      wr1Share: Math.round(((recVals[0] || 0) / (o.recTotal || 1)) * 1000) / 10,
      rb1CarryShare: Math.round(((carVals[0] || 0) / (o.rushAtt || 1)) * 1000) / 10,
    });
  }
  const dvec = new Map();
  for (const [team, d] of def) {
    dvec.set(team, {
      passRateFaced: Math.round((d.passAtt / (d.passAtt + d.rushAtt)) * 1000) / 10,
      wrShare: Math.round((d.rec.WR / (d.recTotal || 1)) * 1000) / 10,
      teShare: Math.round((d.rec.TE / (d.recTotal || 1)) * 1000) / 10,
      rbShare: Math.round((d.rec.RB / (d.recTotal || 1)) * 1000) / 10,
    });
  }
  return { vec, dvec };
}

const mean = (a) => a.reduce((t, x) => t + x, 0) / a.length;
function corr(pairs) {
  const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return dx && dy ? Math.round((num / Math.sqrt(dx * dy)) * 100) / 100 : null;
}

(async () => {
  console.log('NFL style & funnel research (free ESPN) — measured fingerprints, no scheme labels.\n');
  console.log('[rosters] fetching 32 team rosters for position mapping…');
  const posOf = await rosterPositions();
  console.log(`[rosters] ${posOf.size} players mapped`);
  const s25 = await seasonProfiles(2025, posOf, '2025');
  const s24 = await seasonProfiles(2024, posOf, '2024');

  // League averages 2025
  const teams = [...s25.vec.keys()].sort();
  const lg = {};
  for (const k of ['plays', 'passRate', 'wrShare', 'teShare', 'rbShare', 'wr1Share', 'rb1CarryShare']) lg[k] = Math.round(mean(teams.map((t) => s25.vec.get(t)[k])) * 10) / 10;
  console.log(`\n═══ 1. OFFENSE STYLE FINGERPRINTS (2025) — league avg: ${lg.plays} plays/g · ${lg.passRate}% pass · rec share WR ${lg.wrShare}% / TE ${lg.teShare}% / RB ${lg.rbShare}% ═══`);
  console.log('  team                          plays  pass%  WR%   TE%   RB%   WR1%  RB1car%  KEY POSITION');
  for (const t of teams) {
    const v = s25.vec.get(t);
    // Key position = biggest positive deviation from league share.
    const dev = [['WR', v.wrShare - lg.wrShare], ['TE', v.teShare - lg.teShare], ['RB(rec)', v.rbShare - lg.rbShare]];
    if (v.rb1CarryShare - lg.rb1CarryShare > 8) dev.push(['RB1(carries)', v.rb1CarryShare - lg.rb1CarryShare]);
    if (v.wr1Share - lg.wr1Share > 5) dev.push(['WR1(funnel)', v.wr1Share - lg.wr1Share]);
    dev.sort((a, b) => b[1] - a[1]);
    const key = dev[0][1] > 2 ? `${dev[0][0]} (+${Math.round(dev[0][1])}%)` : 'balanced';
    console.log(`  ${t.padEnd(29)} ${String(v.plays).padStart(5)} ${String(v.passRate).padStart(6)} ${String(v.wrShare).padStart(5)} ${String(v.teShare).padStart(5)} ${String(v.rbShare).padStart(5)} ${String(v.wr1Share).padStart(5)} ${String(v.rb1CarryShare).padStart(7)}  ${key}`);
  }

  console.log('\n═══ 2. DEFENSIVE FUNNELS (2025) — reception share ALLOWED vs league avg ═══');
  const dTeams = [...s25.dvec.keys()].sort();
  const funnels = [];
  for (const t of dTeams) {
    const d = s25.dvec.get(t);
    funnels.push({ t, pos: 'TE', dev: Math.round((d.teShare - lg.teShare) * 10) / 10 });
    funnels.push({ t, pos: 'RB', dev: Math.round((d.rbShare - lg.rbShare) * 10) / 10 });
    funnels.push({ t, pos: 'WR', dev: Math.round((d.wrShare - lg.wrShare) * 10) / 10 });
  }
  funnels.sort((a, b) => b.dev - a.dev);
  console.log('  Leakiest (allow MORE than avg):');
  for (const f of funnels.slice(0, 8)) console.log(`    ${f.t.padEnd(29)} +${f.dev}% to ${f.pos}`);
  console.log('  Stingiest (allow LESS than avg):');
  for (const f of funnels.slice(-8).reverse()) console.log(`    ${f.t.padEnd(29)} ${f.dev}% to ${f.pos}`);

  console.log('\n═══ 3. YEAR-OVER-YEAR PERSISTENCE (2024 → 2025, r across teams) ═══');
  for (const k of ['plays', 'passRate', 'wrShare', 'teShare', 'rbShare', 'wr1Share', 'rb1CarryShare']) {
    const pairs = [];
    for (const t of teams) if (s24.vec.has(t)) pairs.push([s24.vec.get(t)[k], s25.vec.get(t)[k]]);
    console.log(`  ${k.padEnd(14)} r = ${corr(pairs)}`);
  }
  const dpairs = { teShare: [], rbShare: [], wrShare: [] };
  for (const t of dTeams) if (s24.dvec.has(t)) for (const k of Object.keys(dpairs)) dpairs[k].push([s24.dvec.get(t)[k], s25.dvec.get(t)[k]]);
  for (const k of Object.keys(dpairs)) console.log(`  def ${k.padEnd(10)} r = ${corr(dpairs[k])}`);
  console.log('  → r ≥ ~0.4 = projectable into next season (esp. where the coordinator stays);');
  console.log('    r near 0 = the stat reshuffles yearly — do not project it.');

  console.log('\nDone. Paste this output back to Claude to turn findings into system changes.');
})();
