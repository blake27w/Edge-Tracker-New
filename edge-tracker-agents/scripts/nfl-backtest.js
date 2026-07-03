// ══════════════════════════════════════════════════════════════
// NFL 2025-season backtest — what does last season teach our system?
//
// Run:  node scripts/nfl-backtest.js                    (free parts only)
//       HISTORICAL=1 node scripts/nfl-backtest.js       (+ open/close pulls)
//
// FREE (ESPN scoreboards, $0):
//   1. Margin-landing distribution → recalibrates the key-number LAND_PCT
//      table in src/agents/key-number/index.js with real frequencies.
//   2. Model validation: Elo built from the 2024 season projecting 2025
//      spreads, and a 2024 scoring-environment model projecting 2025 totals —
//      hit rates vs what actually happened.
//
// HISTORICAL=1 (The Odds API historical endpoint — PAID: 10× credit
// multiplier; ~6 snapshots/week × 19 weeks × 20 credits ≈ 2,300 credits
// one-time. Requires ODDS_API_KEY env):
//   3. Opening vs closing lines: does following the market's open→close move
//      (betting the side the line moved TOWARD, at the OPENER number) cover?
//      This validates the CLV premise on NFL specifically, and measures how
//      often the close crosses a key number from the open.
// ══════════════════════════════════════════════════════════════

const ODDS_KEY = process.env.ODDS_API_KEY || '';
const HISTORICAL = /^(1|true|yes)$/i.test(process.env.HISTORICAL || '');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ODDS = 'https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/odds';

const norm = (s) => String(s || '').toLowerCase();
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 90)}`);
  return res.json();
}

// ── Finals for a season window via ESPN (free) ────────────────────
async function seasonFinals(startIso, endIso, label) {
  const out = [];
  for (let d = new Date(startIso); d <= new Date(endIso); d = new Date(d.getTime() + 86400_000)) {
    let data;
    try { data = await getJson(`${ESPN}?dates=${ymd(d)}`); } catch (_) { continue; }
    for (const ev of data.events || []) {
      const comp = (ev.competitions || [])[0];
      if (!comp || !(comp.status?.type?.completed || ev.status?.type?.completed)) continue;
      const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
      const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
      const hs = Number(home?.score), as = Number(away?.score);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      out.push({
        date: ymd(d), homeNick: norm(home.team?.name), awayNick: norm(away.team?.name),
        homeFull: norm(home.team?.displayName), awayFull: norm(away.team?.displayName),
        hs, as, margin: Math.abs(hs - as), homeMargin: hs - as, total: hs + as,
      });
    }
    process.stdout.write(`\r[${label}] ${out.length} finals through ${ymd(d)} `);
  }
  console.log('');
  return out;
}

// ── 1. Margin-landing distribution → key-number calibration ───────
function marginReport(finals) {
  console.log(`\n═══ 1. MARGIN DISTRIBUTION (${finals.length} games) — key-number calibration ═══`);
  const count = {};
  for (const f of finals) count[f.margin] = (count[f.margin] || 0) + 1;
  const rows = Object.entries(count).map(([m, n]) => ({ m: +m, n, pct: pct(n, finals.length) }))
    .sort((a, b) => b.n - a.n).slice(0, 12);
  for (const r of rows) console.log(`  margin ${String(r.m).padStart(2)} → ${String(r.n).padStart(3)} games (${r.pct}%)`);
  const land = {};
  for (const k of [3, 7, 6, 10, 14, 4]) land[k] = pct(count[k] || 0, finals.length);
  console.log(`\n  Suggested LAND_PCT for key-number agent: ${JSON.stringify(land)}`);
  console.log('  (edit src/agents/key-number/index.js LAND_PCT if these differ meaningfully)');
}

// ── 2. Model validation: 2024-built models vs 2025 results ────────
function buildElo(finals) {
  const R = {}; const g = (t) => (R[t] = R[t] ?? 1500);
  for (const f of finals) {
    const h = g(f.homeFull), a = g(f.awayFull);
    const exp = 1 / (1 + Math.pow(10, -((h + 48 - a) / 400))); // +48 Elo home edge
    const act = f.homeMargin > 0 ? 1 : f.homeMargin < 0 ? 0 : 0.5;
    const k = 20 * Math.sqrt(Math.abs(f.homeMargin) || 1);
    R[f.homeFull] = h + (k * (act - exp)) / 4;
    R[f.awayFull] = a - (k * (act - exp)) / 4;
  }
  return R;
}
function buildEnv(finals) {
  const S = {}; // team -> {pf, pa, n}
  for (const f of finals) {
    (S[f.homeFull] = S[f.homeFull] || { pf: 0, pa: 0, n: 0 }); S[f.homeFull].pf += f.hs; S[f.homeFull].pa += f.as; S[f.homeFull].n++;
    (S[f.awayFull] = S[f.awayFull] || { pf: 0, pa: 0, n: 0 }); S[f.awayFull].pf += f.as; S[f.awayFull].pa += f.hs; S[f.awayFull].n++;
  }
  const lg = Object.values(S).reduce((t, s) => t + s.pf / s.n, 0) / Object.keys(S).length;
  return { S, lg };
}
function modelReport(prev, cur) {
  console.log(`\n═══ 2. MODEL VALIDATION — 2024-built models vs 2025 results ═══`);
  const elo = buildElo(prev), { S, lg } = buildEnv(prev);
  let spOk = 0, spN = 0, totLeanOk = 0, totLeanN = 0;
  for (const f of cur) {
    const h = elo[f.homeFull], a = elo[f.awayFull];
    if (h && a) { spN++; if ((h + 48 > a) === (f.homeMargin > 0)) spOk++; }
    const hs = S[f.homeFull], as2 = S[f.awayFull];
    if (hs && as2) {
      const proj = (hs.pf / hs.n + as2.pa / as2.n) / 2 + (as2.pf / as2.n + hs.pa / hs.n) / 2;
      const seasonAvg = 2 * lg;
      if (Math.abs(proj - seasonAvg) >= 4) { totLeanN++; if ((proj > seasonAvg) === (f.total > seasonAvg)) totLeanOk++; }
    }
  }
  console.log(`  Elo straight-up winner:            ${spOk}/${spN} (${pct(spOk, spN)}%) — sanity floor ~62-67%`);
  console.log(`  Scoring-env total lean (|proj-avg|≥4): ${totLeanOk}/${totLeanN} (${pct(totLeanOk, totLeanN)}%) — >52.4% is bet-worthy vs flat juice`);
  console.log('  NOTE: without closing lines this tests reality, not the market. Run HISTORICAL=1 to test vs the close (the bar that matters).');
}

// ── 3. Open→close vs outcomes (The Odds API historical; credits!) ──
async function snapshot(dateIso) {
  const p = new URLSearchParams({ apiKey: ODDS_KEY, regions: 'us', markets: 'spreads,totals', oddsFormat: 'american', date: dateIso });
  const data = await getJson(`${ODDS}?${p}`);
  const out = new Map(); // event key -> {homeFull, awayFull, spreadHome, total, commence}
  for (const ev of data.data || []) {
    const sp = [], tot = [];
    for (const bm of ev.bookmakers || []) for (const mk of bm.markets || []) for (const oc of mk.outcomes || []) {
      if (mk.key === 'spreads' && oc.name === ev.home_team && oc.point != null) sp.push(oc.point);
      if (mk.key === 'totals' && oc.name === 'Over' && oc.point != null) tot.push(oc.point);
    }
    out.set(ev.id, { homeFull: norm(ev.home_team), awayFull: norm(ev.away_team), commence: ev.commence_time, spreadHome: median(sp), total: median(tot) });
  }
  return out;
}
async function openCloseReport(finals) {
  console.log(`\n═══ 3. OPEN→CLOSE vs OUTCOMES (historical odds; ~2.3k credits) ═══`);
  const KEYS = new Set([3, 4, 6, 7, 10, 14]);
  let atsFollowOk = 0, atsFollowN = 0, totFollowOk = 0, totFollowN = 0, keyCross = 0, pairs = 0;
  let mvSpread = 0, mvTotal = 0;
  // Week anchors: first Tuesday after Sep 1 2025, for 19 weeks.
  let tue = new Date('2025-09-02T18:00:00Z');
  for (let w = 0; w < 19; w++) {
    const opens = await snapshot(tue.toISOString().replace(/\.\d+Z$/, 'Z')).catch(() => null);
    // Closes: snapshots just before each kickoff cluster, as day-offsets from
    // Tue 18:00Z — TNF (Fri 00:15Z), Sun 1pm ET (16:55Z), Sun 4:25pm (20:15Z),
    // SNF (Mon 00:15Z), MNF (Tue 00:15Z).
    const closeTimes = [2.26, 4.954, 5.093, 5.26, 6.26].map((d) => new Date(tue.getTime() + d * 86400_000));
    const closes = new Map();
    for (const ct of closeTimes) {
      const snap = await snapshot(ct.toISOString().replace(/\.\d+Z$/, 'Z')).catch(() => null);
      if (snap) for (const [id, v] of snap) {
        const dt = Date.parse(v.commence) - ct.getTime();
        if (dt > 0 && dt < 2 * 3600_000) closes.set(id, v); // snapshot just before this game's kickoff
      }
    }
    if (opens) for (const [id, o] of opens) {
      const c = closes.get(id);
      if (!c || o.spreadHome == null || c.spreadHome == null || o.total == null || c.total == null) continue;
      const fin = finals.find((f) => f.homeFull === o.homeFull && f.awayFull === o.awayFull);
      if (!fin) continue;
      pairs++;
      const dSp = c.spreadHome - o.spreadHome, dTot = c.total - o.total;
      mvSpread += Math.abs(dSp); mvTotal += Math.abs(dTot);
      // Follow the spread move at the OPEN number: line moved toward home (dSp<0 = home now laying more) → bet home at open.
      if (Math.abs(dSp) >= 0.5) {
        atsFollowN++;
        const betHome = dSp < 0;
        const cover = betHome ? fin.homeMargin + o.spreadHome > 0 : fin.homeMargin + o.spreadHome < 0;
        if (cover) atsFollowOk++;
      }
      if (Math.abs(dTot) >= 0.5) {
        totFollowN++;
        const betOver = dTot > 0;
        if ((betOver && fin.total > o.total) || (!betOver && fin.total < o.total)) totFollowOk++;
      }
      for (const k of KEYS) { const lo = Math.min(Math.abs(o.spreadHome), Math.abs(c.spreadHome)), hi = Math.max(Math.abs(o.spreadHome), Math.abs(c.spreadHome)); if (lo < k && hi > k) { keyCross++; break; } }
    }
    tue = new Date(tue.getTime() + 7 * 86400_000);
    process.stdout.write(`\r[open/close] week ${w + 1}/19 · ${pairs} paired games `);
  }
  console.log('');
  console.log(`  Paired games (open+close+final):   ${pairs}`);
  console.log(`  Follow the spread move @ open #:   ${atsFollowOk}/${atsFollowN} ATS (${pct(atsFollowOk, atsFollowN)}%) — >52.4% validates chasing steam/CLV`);
  console.log(`  Follow the total move @ open #:    ${totFollowOk}/${totFollowN} (${pct(totFollowOk, totFollowN)}%)`);
  console.log(`  Avg |move|: spread ${(mvSpread / (pairs || 1)).toFixed(2)} pts · total ${(mvTotal / (pairs || 1)).toFixed(2)} pts`);
  console.log(`  Open→close crossed a key number:   ${keyCross}/${pairs} (${pct(keyCross, pairs)}%) — how often the opener number itself was the edge`);
}

(async () => {
  console.log('NFL 2025-season backtest — free parts first.');
  const finals25 = await seasonFinals('2025-09-04', '2026-01-07', '2025 finals');
  if (!finals25.length) { console.error('No 2025 finals from ESPN — check network.'); process.exit(1); }
  marginReport(finals25);
  const finals24 = await seasonFinals('2024-09-05', '2025-01-08', '2024 finals');
  if (finals24.length) modelReport(finals24, finals25);
  if (HISTORICAL) {
    if (!ODDS_KEY) { console.error('HISTORICAL=1 requires ODDS_API_KEY.'); process.exit(1); }
    await openCloseReport(finals25);
  } else {
    console.log('\n(Skipped open/close analysis — rerun with HISTORICAL=1 ODDS_API_KEY=… to spend ~2.3k credits on it.)');
  }
  console.log('\nDone.');
})();
