// ══════════════════════════════════════════════════════════════
// NFL props MODEL backtest — free (ESPN box scores only).
//
// Run:  node scripts/nfl-props-backtest.js        (~6-10 min, ~550 fetches)
//
// WHY NOT A LINES BACKTEST: historical player-prop odds cost ~11-22k credits
// for one season (The Odds API 10× multiplier, per event per market) — the
// entire monthly budget — and our real prop edge (stale books in the minutes
// after an injury/QB trigger) cannot be reconstructed historically at any
// price. Speed edges validate LIVE (the prop close-capture → CLV pipeline).
//
// WHAT THIS TESTS INSTEAD — the modeling layer's three assumptions:
//   1. Prior-year volume predicts this year (the nfl-props baselines).
//   2. Which stats are most stable game-to-game (which prop markets to trust).
//   3. When usage shifts vs season norm, it PERSISTS (the premise of the
//      planned in-season rolling-usage model — validate before building).
// ══════════════════════════════════════════════════════════════

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const STATS = ['passYds', 'rushAtt', 'rushYds', 'rec', 'recYds'];
const norm = (s) => String(s || '').toLowerCase();

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// Completed game ids for a season (regular weeks 1-18).
async function seasonEventIds(year) {
  const ids = [];
  for (let w = 1; w <= 18; w++) {
    try {
      const data = await getJson(`${BASE}/scoreboard?dates=${year}&seasontype=2&week=${w}`);
      for (const ev of data.events || []) {
        if ((ev.competitions || [])[0]?.status?.type?.completed) ids.push({ id: ev.id, week: w });
      }
    } catch (_) { /* skip week */ }
  }
  return ids;
}

function statNum(v) { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; }

// Per-player stat line from one box score. Defensive label lookup.
function extract(box, week) {
  const out = [];
  for (const team of box?.players || []) {
    for (const grp of team.statistics || []) {
      const gname = norm(grp.name || grp.text || grp.type);
      const labels = (grp.labels || grp.keys || []).map((s) => String(s).toUpperCase());
      const idx = (l) => labels.indexOf(l);
      for (const a of grp.athletes || []) {
        const player = a.athlete?.displayName;
        if (!player) continue;
        const row = { player, week };
        if (gname.includes('passing')) { const i = idx('YDS'); if (i >= 0) row.passYds = statNum(a.stats?.[i]); }
        if (gname.includes('rushing')) {
          const c = idx('CAR'), y = idx('YDS');
          if (c >= 0) row.rushAtt = statNum(a.stats?.[c]);
          if (y >= 0) row.rushYds = statNum(a.stats?.[y]);
        }
        if (gname.includes('receiving')) {
          const r = idx('REC'), y = idx('YDS');
          if (r >= 0) row.rec = statNum(a.stats?.[r]);
          if (y >= 0) row.recYds = statNum(a.stats?.[y]);
        }
        if (Object.keys(row).length > 2) out.push(row);
      }
    }
  }
  return out;
}

// season -> Map player -> { stat -> [gameValues in week order] }
async function seasonLogs(year, label) {
  const ids = await seasonEventIds(year);
  const players = new Map();
  let done = 0;
  for (const { id, week } of ids) {
    let box;
    try { box = (await getJson(`${BASE}/summary?event=${id}`))?.boxscore; } catch (_) { continue; }
    for (const row of extract(box, week)) {
      const p = players.get(row.player) || players.set(row.player, {}).get(row.player);
      for (const s of STATS) if (row[s] != null) (p[s] ||= []).push(row[s]);
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`\r[${label}] ${done}/${ids.length} box scores `);
  }
  console.log(`\r[${label}] ${done}/${ids.length} box scores done`);
  return players;
}

const avg = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);

(async () => {
  console.log('NFL props MODEL backtest (free ESPN) — see header for what this can/cannot test.\n');
  const s24 = await seasonLogs(2024, '2024');
  const s25 = await seasonLogs(2025, '2025');

  // ── 1. Do prior-year averages predict this year? ─────────────────
  console.log('\n═══ 1. BASELINE PREDICTIVENESS — 2024 per-game avg vs 2025 early-season (wks 1-6) ═══');
  for (const s of STATS) {
    let n = 0, mae = 0, dirOk = 0, dirN = 0;
    for (const [player, p24] of s24) {
      const g24 = p24[s], p25 = s25.get(player);
      if (!g24 || g24.length < 8 || !p25 || !p25[s]) continue;
      const early25 = p25[s].slice(0, 6);
      if (early25.length < 3) continue;
      const base = avg(g24), act = avg(early25);
      n++; mae += Math.abs(act - base);
      // Direction test: players well above/below the positional median in 2024 —
      // did they stay on that side in 2025? (proxy for over/under a market line)
      dirN++; if ((base > 0) && Math.sign(act - base) !== 0) dirOk += Math.abs(act - base) / base <= 0.25 ? 1 : 0;
    }
    if (n) console.log(`  ${s.padEnd(8)} n=${String(n).padStart(3)} · avg miss ${Math.round((mae / n) * 10) / 10}/game · within ±25% of baseline: ${Math.round((dirOk / dirN) * 100)}%`);
  }
  console.log('  → smaller miss + higher within-±25% = the baseline is usable for that market.');

  // ── 2. Which stats are most stable game-to-game? ─────────────────
  console.log('\n═══ 2. STAT STABILITY (2025) — game-to-game volatility by market ═══');
  for (const s of STATS) {
    let cvSum = 0, n = 0;
    for (const [, p] of s25) {
      const g = p[s];
      if (!g || g.length < 8) continue;
      const m = avg(g);
      if (!m || m < 2) continue;
      const sd = Math.sqrt(g.reduce((t, x) => t + (x - m) ** 2, 0) / g.length);
      cvSum += sd / m; n++;
    }
    if (n) console.log(`  ${s.padEnd(8)} volatility (CV) ${Math.round((cvSum / n) * 100)}% across ${n} qualifying players`);
  }
  console.log('  → lower CV = more predictable = the market our model should trust most (expect volume stats < yardage).');

  // ── 3. Do usage shifts persist? (rolling-usage model premise) ────
  console.log('\n═══ 3. USAGE-SHIFT PERSISTENCE (2025) — when rolling-3 diverges ≥25% from season-to-date ═══');
  for (const s of ['rushAtt', 'rec']) {
    let shifts = 0, persisted = 0;
    for (const [, p] of s25) {
      const g = p[s];
      if (!g || g.length < 8) continue;
      for (let i = 5; i < g.length - 1; i++) {
        const season = avg(g.slice(0, i - 2)), roll = avg(g.slice(i - 2, i + 1));
        if (season == null || roll == null || season < 2) continue;
        if (Math.abs(roll - season) / season >= 0.25 && Math.abs(roll - season) >= 2) {
          shifts++;
          const next = g[i + 1];
          if (Math.abs(next - roll) < Math.abs(next - season)) persisted++;
        }
      }
    }
    if (shifts) console.log(`  ${s.padEnd(8)} ${shifts} shifts detected · next game closer to the NEW level ${Math.round((persisted / shifts) * 100)}% of the time`);
  }
  console.log('  → >55% persistence validates the in-season rolling-usage model; <50% kills it.');

  console.log('\nDone. Paste this output back to Claude to turn findings into system changes.');
})();
