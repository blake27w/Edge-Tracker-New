// ══════════════════════════════════════════════════════════════
// sharp through a scripted DAY on the 5-minute cadence, plus the edges the
// per-case tests in sharp-history.test.js cannot reach: window slicing across
// runs, the breaker with steam flowing through memory, emission under churn
// and across a restart, and the coercion shapes Postgres actually hands back.
//
// The day is the test the spec's recipe admits cannot be run live on demand:
// 12 games across 3 sports, movement rows landing over 6 hours with the real
// cadence mix (4/10/12.5/30-min strike/near/mid gaps, 180-min idle rows, a
// few pre-fix `gap_min: null` rows), one genuine 3-book steam that gains a
// fourth book 20 minutes later, one 2-book near-miss, and one 3-book move with
// small gaps whose intervals do not overlap. Every run is checked against an
// INDEPENDENT oracle computed from the row list — not against the reader.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './helpers/fake-db.js';

const MIN = 60_000;
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const pg = (ms) => iso(ms).replace('Z', '+00:00');

let fdb, orch, store, sharp, hist;
const warns = [], infos = [];
const realNow = Date.now;
let clock = realNow();
const setClock = (ms) => { clock = ms; };

before(async () => {
  Date.now = () => clock;
  fdb = fakeDb({ line_movements: [] });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb, namedExports: { isMissingRelation: fdb.isMissingRelation },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: {
        info: (a, m) => infos.push(`${a}: ${m}`),
        warn: (a, m) => warns.push(`${a}: ${m}`),
        error: () => {},
      },
      notifyAll: async () => ({ total: 0 }),
      getFeed: () => [], getMetrics: () => ({}),
      getClaudeUsage: async () => ({ projectedMonthly: 0 }),
      hasClaude: () => false,
      claudeBlockReason: () => 'ANTHROPIC_API_KEY is not set in this deployment',
      detectModel: async () => null, parseJson: () => null,
      claude: async () => '', claudeJson: async () => null,
      sendSms: async () => ({ total: 0 }), sendEmail: async () => ({ total: 0 }),
    },
  });
  store = await import('../src/store/index.js');
  orch = await import('../src/orchestrator/index.js');
  hist = await import('../src/agents/sharp/history.js');
  const s = await import('../src/agents/sharp/index.js');
  sharp = s.default;
  sharp.__reset = s.__resetSharp;
});
after(() => { Date.now = realNow; try { orch.stop(); } catch (_) { /* ignore */ } mock.reset(); });

const BOOKS = ['draftkings', 'fanduel', 'betmgm'];
const sigInserts = () => fdb.calls.insert.filter((c) => c.table === 'sharp_signals');
const insertedRows = () => sigInserts().flatMap((c) => c.rows);
const histSelects = () => fdb.calls.select.filter((c) => c.table === 'line_movements');
const game = (id, kickoff, sport = 'A') => ({ game_id: id, sport, commence_time: iso(kickoff) });
// A history row as PostgREST returns it: numerics as strings, +00:00 stamps.
const hrow = (o) => ({
  sport: 'A', market: 'totals', side: 'Over', direction: 'down',
  line_open: '44.5', line_current: '44', moved: '-0.5', gap_min: '4', ...o,
  detected_at: typeof o.detected_at === 'number' ? pg(o.detected_at) : o.detected_at,
});
// The same row as movementFrom publishes it in memory: numbers, an ISO Z stamp.
const memOf = (r) => ({
  ...r, line_open: Number(r.line_open), line_current: Number(r.line_current), moved: Number(r.moved),
  gap_min: typeof r.gap_min === 'string' && r.gap_min.trim() !== '' ? Number(r.gap_min) : r.gap_min,
  detected_at: iso(Date.parse(r.detected_at)),
});

beforeEach(() => {
  setClock(realNow());
  warns.length = 0; infos.length = 0;
  fdb.calls.select.length = 0; fdb.calls.insert.length = 0;
  fdb.fail = {};
  fdb.isConnected = () => true;
  fdb.setRows('line_movements', []);
  fdb.setRows('sharp_signals', []);
  store.setGames([game('g1', clock + 20 * MIN)]);
  store.setIntel('movements', []);
  store.setIntel('sharp', []);
  sharp.__reset();
  for (const d of store.getDegraded()) store.clearDegraded(d.key);
});

// ═══════════════════════════════════════════════════════════════
// 1. A realistic day
// ═══════════════════════════════════════════════════════════════
test('a scripted six-hour day on the 5-minute cadence: one steam, one near-miss, one disjoint triple, one cluster gaining a fourth book', async () => {
  const T0 = Date.UTC(2026, 10, 8, 14, 0, 0); // Sunday 14:00Z
  const at = (min) => T0 + min * MIN;
  const games = [
    game('nfl1', at(120), 'NFL'), game('nfl2', at(240), 'NFL'), game('nfl3', at(420), 'NFL'), game('nfl4', at(540), 'NFL'),
    game('nba1', at(480), 'NBA'), game('nba2', at(540), 'NBA'), game('nba3', at(600), 'NBA'), game('nba4', at(660), 'NBA'),
    game('mlb1', at(270), 'MLB'), game('mlb2', at(300), 'MLB'), game('mlb3', at(420), 'MLB'), game('mlb4', at(480), 'MLB'),
  ];
  const sportOf = Object.fromEntries(games.map((g) => [g.game_id, g.sport]));
  const all = []; // every row the day will produce, with its ms `t`
  const push = (o) => { all.push({ ...hrow({ sport: sportOf[o.game_id], ...o }), t: o.detected_at }); };

  // Background: one single-book row per game per hour at a mixed cadence —
  // strike/near/mid gaps, keys that never share a book, so none can cluster.
  const gaps = ['4', '10', '12.5', '30'];
  const mkts = ['h2h', 'spreads', 'totals'];
  games.forEach((g, i) => {
    for (let h = 0; h < 6; h++) {
      push({ game_id: g.game_id, book: BOOKS[(i + h) % 3], market: mkts[(i + h) % 3], side: `side${i % 2}`,
        direction: h % 2 ? 'up' : 'down', gap_min: gaps[(i + h) % 4], detected_at: at(h * 60 + ((i * 7) % 55)) });
    }
  });
  // Idle-tier rows: three books, one key, SAME instant, gap 180 — a whole
  // market moving on the idle cadence. Simultaneous-looking and not steam.
  for (const [gid, m] of [['nfl3', 60], ['mlb3', 180], ['nfl3', 300]]) {
    for (const book of BOOKS) push({ game_id: gid, book, market: 'spreads', side: 'idle', direction: 'up', gap_min: '180', detected_at: at(m) });
  }
  // Pre-fix rows (D73): three books, one key, one instant, gap null.
  for (const m of [10, 130]) for (const book of BOOKS) push({ game_id: 'mlb4', book, market: 'totals', side: 'Under', direction: 'up', gap_min: null, detected_at: at(m) });

  // A. The genuine steam: nfl1 totals Over down at 60/62/63 with gaps 4/10/4
  //    → intervals [56,60] [52,62] [59,63] meet in [59,60]. Then caesars at 83
  //    with gap 30 → [53,83] still contains [59,60]: the cluster GAINS a book
  //    twenty minutes later.
  push({ game_id: 'nfl1', book: 'draftkings', gap_min: '4', detected_at: at(60) });
  push({ game_id: 'nfl1', book: 'fanduel', gap_min: '10', detected_at: at(62) });
  push({ game_id: 'nfl1', book: 'betmgm', gap_min: '4', detected_at: at(63) });
  push({ game_id: 'nfl1', book: 'caesars', gap_min: '30', detected_at: at(83) });
  // B. Two books only.
  push({ game_id: 'nba1', book: 'draftkings', market: 'spreads', side: 'LAL', direction: 'up', line_open: '-3.5', line_current: '-4', moved: '-0.5', gap_min: '4', detected_at: at(120) });
  push({ game_id: 'nba1', book: 'fanduel', market: 'spreads', side: 'LAL', direction: 'up', line_open: '-3.5', line_current: '-4', moved: '-0.5', gap_min: '10', detected_at: at(121) });
  // C. Three books, small gaps, disjoint: [146,150] [156,160] [166,170].
  push({ game_id: 'nba2', book: 'draftkings', market: 'h2h', side: 'BOS', direction: 'up', gap_min: '4', detected_at: at(150) });
  push({ game_id: 'nba2', book: 'fanduel', market: 'h2h', side: 'BOS', direction: 'up', gap_min: '4', detected_at: at(160) });
  push({ game_id: 'nba2', book: 'betmgm', market: 'h2h', side: 'BOS', direction: 'up', gap_min: '4', detected_at: at(170) });

  store.setGames(games);
  const gapNum = (g) => (g === null || g === '' ? null : Number(g));
  const RUNS = 72; // 6h at 5 min
  let steamRuns = 0;
  for (let k = 0; k <= RUNS; k++) {
    const now = at(k * 5);
    setClock(now);
    // History lags the insert by ~3 minutes; the memory feed is the last odds
    // run's rows. Between them every row is visible, some in both.
    fdb.setRows('line_movements', all.filter((r) => r.t <= now - 3 * MIN).map(({ t, ...r }) => r));
    store.setIntel('movements', all.filter((r) => r.t > now - 5 * MIN && r.t <= now).map(({ t, ...r }) => memOf(r)));
    fdb.calls.insert.length = 0;

    const res = await sharp.run();

    // ── Oracle ───────────────────────────────────────────────────
    const since = now - 45 * MIN;
    const onSlate = games.filter((g) => { const t = Date.parse(g.commence_time); return t >= now - 3 * H && t <= now + 36 * H; });
    const slateIds = new Set(onSlate.map((g) => g.game_id));
    const nGames = onSlate.length;
    // Only slate games are read: once nfl1 is 3h past kickoff its rows are invisible.
    const win = all.filter((r) => slateIds.has(r.game_id) && r.t <= now && r.t >= since);
    const elig = win.filter((r) => { const g = gapNum(r.gap_min); return g !== null && g >= 0 && g <= 35; });
    const preFix = win.filter((r) => r.gap_min === null).length;
    const markets = new Set(elig.map((r) => `${r.game_id}|${r.market}|${r.side}`)).size;
    const steam = k >= 13 && k <= 21; // all three nfl1 rows inside the 45m window
    const expectBooks = k >= 17 && k <= 21 ? 4 : 3;
    const tag = `run ${k} (T0+${k * 5}m): ${res.summary}`;

    assert.equal(res.blocked, undefined, tag);
    assert.equal(res.data.source, 'history+memory', tag);
    assert.equal(res.data.games, nGames, tag);
    assert.equal(res.data.rows, win.length, `${tag} — union deduped to exactly the rows in the window`);
    assert.equal(res.data.eligible, elig.length, tag);
    assert.equal(res.data.preFix, preFix, tag);
    if (!win.length) {
      assert.equal(res.summary, `0 steam · 0 movement rows in the last 45m across ${nGames} games · history+memory`, tag);
    } else if (!steam) {
      assert.equal(res.summary, `0 steam · ${win.length} rows / ${elig.length} gap-eligible / 0 simultaneous clusters · ${nGames} games · history+memory`, tag);
      assert.equal(store.getIntel('sharp').length, 0, tag);
      assert.equal(res.data.inserted, 0, tag);
      assert.equal(sigInserts().length, 0, tag);
    } else {
      steamRuns++;
      assert.equal(res.summary, `1 steam · ${win.length} rows / ${elig.length} gap-eligible / ${markets} markets · ${nGames} games · history+memory · window 45m`, tag);
      const sg = store.getIntel('sharp');
      assert.equal(sg.length, 1, tag);
      assert.equal(sg[0].game_id, 'nfl1');
      assert.equal(sg[0].sport, 'NFL');
      assert.equal(sg[0].side, 'Under', 'a coordinated DOWN move on a total is Under money');
      assert.equal(sg[0].books.length, expectBooks, tag);
      assert.match(sg[0].detail, /within 1m · (history|history\+memory)$/, tag);
      const expectInsert = k === 13 || k === 17 ? 1 : 0;
      assert.equal(res.data.inserted, expectInsert, `${tag} — insert only on first sight (run 13) and on gaining caesars (run 17)`);
      assert.equal(sigInserts().length, expectInsert, tag);
      if (k === 13) {
        assert.deepEqual(insertedRows()[0].books, ['betmgm', 'draftkings', 'fanduel']);
        assert.match(insertedRows()[0].detail, /· history\+memory$/, 'betmgm landed 2 minutes ago — still memory-only');
      }
      if (k === 17) assert.deepEqual(insertedRows()[0].books, ['betmgm', 'caesars', 'draftkings', 'fanduel']);
    }
    assert.equal(histSelects().length, nGames, `${tag} — one select per slate game`);
    fdb.calls.select.length = 0;
  }
  assert.equal(steamRuns, 9);
  assert.equal(warns.length, 0, `no warnings on a healthy day:\n${warns.join('\n')}`);
  // Cross-run totals: the whole day wrote exactly two sharp_signals rows.
  // (fdb.calls.insert is reset per run above; the table itself accumulates.)
  const written = fdb.rows('sharp_signals');
  assert.equal(written.length, 2, 'exactly two rows for the whole day');
  assert.equal(written[0].books.length, 3);
  assert.equal(written[1].books.length, 4);
  // The near-miss and the disjoint triple never reached the table.
  assert.ok(written.every((r) => r.game_id === 'nfl1'));
});

// ═══════════════════════════════════════════════════════════════
// 2. Window edges
// ═══════════════════════════════════════════════════════════════
test('window edges: a row whose interval starts before the window still joins a cluster; the window cannot slice an admissible cluster', async () => {
  const now = clock;
  // Rows at −40/−39/−38 with gaps 30/10/4: intervals [−70,−40] [−49,−39] [−42,−38]
  // → lo −42, hi −40. The oldest interval starts 25 minutes before the window
  // opens; the ROW is inside it, which is all the gte asks.
  fdb.setRows('line_movements', [
    hrow({ game_id: 'g1', book: 'draftkings', gap_min: '30', detected_at: now - 40 * MIN }),
    hrow({ game_id: 'g1', book: 'fanduel', gap_min: '10', detected_at: now - 39 * MIN }),
    hrow({ game_id: 'g1', book: 'betmgm', gap_min: '4', detected_at: now - 38 * MIN }),
  ]);
  const r = await sharp.run();
  assert.match(r.summary, /^1 steam · 3 rows \/ 3 gap-eligible/, r.summary);
  assert.equal(store.getIntel('sharp')[0].detail.match(/within (\S+)m/)[1], '2');

  // Oldest row 44m, newest 1m: for these to intersect the newest would need a
  // gap >= 43 > the bound, so the window edge (45 = bound + one tick) can
  // never be what separates an admissible cluster. Shown both ways.
  fdb.setRows('line_movements', [
    hrow({ game_id: 'g1', book: 'draftkings', gap_min: '4', detected_at: now - 44 * MIN }),
    hrow({ game_id: 'g1', book: 'fanduel', gap_min: '30', detected_at: now - 20 * MIN }),
    hrow({ game_id: 'g1', book: 'betmgm', gap_min: '35', detected_at: now - 1 * MIN }),
  ]);
  const r2 = await sharp.run();
  assert.match(r2.summary, /^0 steam · 3 rows \/ 3 gap-eligible \/ 0 simultaneous clusters/, r2.summary);
  // Exactly on the trailing edge: a row at −45m is still read (gte), at −45m−1s it is not.
  fdb.setRows('line_movements', [
    hrow({ game_id: 'g1', book: 'draftkings', gap_min: '4', detected_at: now - 45 * MIN }),
    hrow({ game_id: 'g1', book: 'fanduel', gap_min: '4', detected_at: now - 45 * MIN - 1000 }),
  ]);
  assert.equal((await sharp.run()).data.rows, 1, 'the window is closed at −45m, open past it');
});

test('a cluster is counted once across the runs it lives in and never re-emitted when it ages out and a member re-ticks', async () => {
  const t0 = clock;
  // Cluster at t0−2/−1/0; the day advances by 5-minute runs. It is first seen
  // on run 0 and lives until the oldest row (t0−2) leaves the window.
  const rows = BOOKS.map((book, i) => hrow({ game_id: 'g1', book, gap_min: '10', detected_at: t0 - i * MIN }));
  fdb.setRows('line_movements', rows);
  const inserted = [];
  for (let k = 0; k <= 10; k++) {
    setClock(t0 + k * 5 * MIN);
    const r = await sharp.run();
    inserted.push(r.data.inserted);
    const alive = t0 - 2 * MIN >= Date.now() - 45 * MIN;
    assert.equal(r.data.signals, alive ? 1 : 0, `run ${k}: ${r.summary}`);
  }
  assert.deepEqual(inserted, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'one first detection, never a second');
  // The cluster is gone from the window; fanduel ticks again alone. Not steam.
  setClock(t0 + 55 * MIN);
  fdb.setRows('line_movements', [...rows, hrow({ game_id: 'g1', book: 'fanduel', gap_min: '4', detected_at: Date.now() - MIN })]);
  const r = await sharp.run();
  assert.equal(r.data.rows, 1);
  assert.equal(r.data.signals, 0);
  assert.equal(sigInserts().length, 1);
});

test('slate edges: −3h and +36h are closed bounds, with games straddling each', () => {
  const now = clock;
  const games = [
    game('tooOld', now - 3 * H - 6 * MIN), game('edgeOld', now - 3 * H), game('old', now - 2 * H - 54 * MIN),
    game('near', now + 10 * MIN), game('far', now + 35 * H + 54 * MIN), game('edgeFar', now + 36 * H), game('tooFar', now + 36 * H + 6 * MIN),
  ];
  assert.deepEqual(hist.selectSlate(games, now).map((g) => g.game_id), ['near', 'far', 'edgeFar', 'old', 'edgeOld']);
});

test('a game leaving the slate is no longer read, and its fresh rows cannot form steam', async () => {
  // Kickoff at t0+1h; by t0+4h+5m it is older than −3h and leaves the slate.
  const t0 = clock;
  store.setGames([game('g1', t0 + H), game('g2', t0 + 10 * H)]);
  fdb.setRows('line_movements', BOOKS.map((book, i) => hrow({ game_id: 'g1', book, gap_min: '10', detected_at: t0 - i * MIN })));
  assert.equal((await sharp.run()).data.inserted, 1);
  setClock(t0 + 4 * H + 5 * MIN);
  const r = await sharp.run();
  assert.equal(r.data.games, 1, 'g1 has left the slate');
  // Fresh rows for g1 while it is OFF the slate are not read (one select: g2).
  fdb.setRows('line_movements', BOOKS.map((book) => hrow({ game_id: 'g1', book, gap_min: '10', detected_at: Date.now() - MIN })));
  fdb.calls.select.length = 0;
  await sharp.run();
  assert.equal(histSelects().length, 1);
  assert.equal(histSelects()[0].opts.match.game_id, 'g2');
});

// ═══════════════════════════════════════════════════════════════
// 3. Breaker + probe + memory
// ═══════════════════════════════════════════════════════════════
test('reads fail for 3 runs while memory carries a genuine steam: published memory-only, blocked literal constant, streak climbs, blockedSince pinned', async () => {
  store.setGames([game('g1', clock + 20 * MIN), game('g2', clock + 25 * MIN), game('g3', clock + 30 * MIN)]);
  fdb.fail['select:line_movements'] = new Error('canceling statement due to statement timeout');
  store.setIntel('movements', BOOKS.map((book, i) => memOf(hrow({ game_id: 'g1', book, gap_min: '10', detected_at: clock - i * MIN }))));
  const health = () => orch.getHealth().find((x) => x.name === 'sharp');
  const degraded = () => store.getDegraded().filter((d) => d.key === 'sharp|blocked');
  let since = null;
  for (let n = 1; n <= 6; n++) {
    setClock(clock + 5 * MIN);
    await orch.runAgentOnceForTest(sharp);
    const h = health();
    assert.equal(store.getIntel('sharp').length, 1, `run ${n}: the memory-only steam is published every run`);
    assert.equal(store.getIntel('sharp')[0].books.length, 3);
    // Runs 1–3 read the whole slate (3/3); from run 4 the breaker is open and
    // only the probe game is queried, so the honest line is 1/1.
    const scope = n <= 3 ? '3/3' : '1/1';
    assert.match(h.lastResult, new RegExp(`^blind — history read failed for ${scope} games(, \\d+ consecutive runs)? · memory-only: 1 steam · 3 rows / 3 gap-eligible$`), `run ${n}: ${h.lastResult}`);
    if (n < 3) {
      assert.equal(h.blockedRuns, 0, `run ${n}: pre-breaker`);
      assert.equal(h.blockedReason, null);
      assert.equal(degraded().length, 0);
    } else {
      assert.equal(h.blockedReason, 'history read failed', `run ${n}: the constant literal`);
      assert.equal(h.blockedRuns, n - 2, `run ${n}: the orchestrator's streak climbs`);
      if (!since) since = h.blockedSince;
      assert.ok(since);
      assert.equal(h.blockedSince, since, `run ${n}: blockedSince pinned to the first blocked run`);
      assert.equal(degraded().length, 1);
      assert.match(degraded()[0].detail, new RegExp(`^not doing its job — history read failed \\(${n - 2} consecutive runs since ${since}\\)$`));
      assert.match(h.lastResult, new RegExp(`, ${n} consecutive runs · memory-only`));
    }
  }
  assert.equal(sigInserts().length, 1, 'the memory-only cluster was written once, not once per run');
  assert.equal(insertedRows()[0].detail.endsWith('· memory'), true);
  // Breaker open from run 4: one probe select per run, not three.
  const perRun = fdb.calls.select.filter((c) => c.table === 'line_movements').length;
  assert.equal(perRun, 3 * 3 + 3 * 1, '3 full-slate runs (3 selects) then 3 probe runs (1 select)');
});

test('the probe closes the breaker on a game with ZERO rows, and the full slate resumes with no wedge', async () => {
  store.setGames([game('g1', clock + 20 * MIN), game('g2', clock + 25 * MIN), game('g3', clock + 30 * MIN)]);
  fdb.fail['select:line_movements'] = new Error('timeout');
  for (let n = 1; n <= 4; n++) await orch.runAgentOnceForTest(sharp);
  assert.equal(orch.getHealth().find((x) => x.name === 'sharp').blockedRuns, 2);
  fdb.fail = {};
  fdb.setRows('line_movements', []); // the probe game answers: nothing there
  fdb.calls.select.length = 0;
  await orch.runAgentOnceForTest(sharp);
  const h = orch.getHealth().find((x) => x.name === 'sharp');
  assert.equal(histSelects().length, 1, 'the closing run is the probe');
  assert.equal(h.lastResult, '0 steam · 0 movement rows in the last 45m across 1 of 3 games (probe) · history+memory');
  assert.equal(h.blockedRuns, 0);
  assert.equal(h.blockedReason, null);
  assert.equal(store.getDegraded().filter((d) => d.key === 'sharp|blocked').length, 0);
  fdb.calls.select.length = 0;
  await orch.runAgentOnceForTest(sharp);
  assert.equal(histSelects().length, 3, 'next run: the full slate');
  assert.equal(orch.getHealth().find((x) => x.name === 'sharp').lastResult, '0 steam · 0 movement rows in the last 45m across 3 games · history+memory');
});

test('one persistently sick game among 24 never trips the breaker: the same honest line every run, no probe, never blocked', async () => {
  store.setGames(Array.from({ length: 24 }, (_, i) => game(`g${i}`, clock + (i + 1) * MIN)));
  fdb.setRows('line_movements', BOOKS.map((book, i) => hrow({ game_id: 'g5', book, gap_min: '10', detected_at: clock - i * MIN })));
  const orig = fdb.select;
  fdb.select = async (t, c, o) => {
    if (o.match && o.match.game_id === 'g0') { fdb.calls.select.push({ table: t, cols: c, opts: o }); throw new Error('timeout'); }
    return orig(t, c, o);
  };
  try {
    const lines = new Set();
    for (let n = 1; n <= 8; n++) {
      setClock(clock + 5 * MIN);
      fdb.calls.select.length = 0;
      await orch.runAgentOnceForTest(sharp);
      const h = orch.getHealth().find((x) => x.name === 'sharp');
      lines.add(h.lastResult);
      assert.equal(h.blockedRuns, 0, `run ${n}`);
      assert.equal(histSelects().length, 24, `run ${n}: the whole slate, every run`);
      assert.equal(store.getIntel('sharp').length, 1, `run ${n}: the other 23 games still see steam`);
    }
    assert.equal(lines.size, 1, `no flap in the published state:\n${[...lines].join('\n')}`);
    assert.match([...lines][0], /^1 steam · 3 rows \/ 3 gap-eligible \/ 1 markets · 24 games · history\+memory · window 45m, 1 read failure$/);
    assert.equal(sigInserts().length, 1);
  } finally { fdb.select = orig; }
});

test('the probe is pinned to the soonest game (the D76 idiom): it is the same game every probe run', async () => {
  store.setGames([game('soonest', clock + 5 * MIN), game('g2', clock + 25 * MIN), game('g3', clock + 30 * MIN)]);
  fdb.fail['select:line_movements'] = new Error('timeout');
  for (let n = 1; n <= 6; n++) await sharp.run();
  const probes = histSelects().slice(9);
  assert.equal(probes.length, 3);
  assert.ok(probes.every((c) => c.opts.match.game_id === 'soonest'));
});

// ═══════════════════════════════════════════════════════════════
// 4. Emission under churn
// ═══════════════════════════════════════════════════════════════
test('three books stepping 44.5 → 44 → 43.5 → 43 over 20 minutes write ONE sharp_signals row; a restart mid-steam re-emits once', async () => {
  const t0 = clock;
  const rows = [];
  const steps = [['44.5', '44'], ['44', '43.5'], ['43.5', '43']];
  steps.forEach(([open, cur], s) => {
    BOOKS.forEach((book, i) => rows.push(hrow({ game_id: 'g1', book, line_open: open, line_current: cur, moved: '-0.5',
      gap_min: i === 1 ? '10' : '4', detected_at: t0 + s * 10 * MIN + i * MIN })));
  });
  const runAt = async (min) => {
    setClock(t0 + min * MIN);
    fdb.setRows('line_movements', rows.filter((r) => Date.parse(r.detected_at) <= Date.now()));
    return sharp.run();
  };
  const r1 = await runAt(3);
  assert.equal(r1.data.inserted, 1, r1.summary);
  for (const m of [8, 13, 18, 23, 28]) {
    const r = await runAt(m);
    assert.equal(r.data.signals, 1, `t0+${m}: ${r.summary}`);
    assert.equal(r.data.inserted, 0, `t0+${m}: a member ticking again inside the stab point is the same claim`);
    assert.equal(store.getIntel('sharp')[0].books.length, 3);
  }
  assert.equal(fdb.rows('sharp_signals').length, 1);
  assert.equal(fdb.rows('sharp_signals')[0].books.length, 3);
  assert.equal(r1.data.rows, 3);
  assert.equal((await runAt(28)).data.rows, 9, 'every step is its own row — the stepping is visible, the emission is not repeated');

  // Restart mid-steam: process-local memory is gone, one re-emission, then quiet.
  sharp.__reset();
  const r2 = await runAt(33);
  assert.equal(r2.data.inserted, 1, 'a restart re-emits each live cluster once');
  for (const m of [38, 43]) assert.equal((await runAt(m)).data.inserted, 0, `t0+${m}: and not again`);
  // The first step (t0..t0+2) ages out of the window at t0+48 while the later
  // steps keep the same three books clustered: the stab point — and the
  // cluster's `hi` — moves forward. Keying emission on `hi` re-inserts HERE,
  // on every step that ages out; keying on the book set does not.
  for (const [m, rows] of [[48, 6], [53, 6], [58, 3]]) {
    const r = await runAt(m);
    assert.equal(r.data.rows, rows, `t0+${m}: the window floor (t0+${m - 45}) has dropped the older steps`);
    assert.equal(r.data.signals, 1, `t0+${m}: ${r.summary}`);
    assert.equal(r.data.inserted, 0, `t0+${m}: the window moving under a live cluster is not a new claim`);
  }
  assert.equal(fdb.rows('sharp_signals').length, 2);
});

// ═══════════════════════════════════════════════════════════════
// 5. Coercion
// ═══════════════════════════════════════════════════════════════
test('gap_min coercion: "12.5", 0 and "0" are gaps; null, "", "  " are pre-fix and never a zero', async () => {
  const t = clock - 2 * MIN;
  fdb.setRows('line_movements', [
    hrow({ game_id: 'g1', book: 'draftkings', gap_min: '12.5', detected_at: t }),
    hrow({ game_id: 'g1', book: 'fanduel', gap_min: 0, detected_at: t }),
    hrow({ game_id: 'g1', book: 'betmgm', gap_min: '0', detected_at: t }),
    hrow({ game_id: 'g1', book: 'caesars', gap_min: null, detected_at: t }),
    hrow({ game_id: 'g1', book: 'pointsbet', gap_min: '', detected_at: t }),
    hrow({ game_id: 'g1', book: 'bet365', gap_min: '  ', detected_at: t }),
  ]);
  const r = await sharp.run();
  assert.equal(r.data.rows, 6);
  assert.equal(r.data.eligible, 3, r.summary);
  assert.equal(r.data.preFix, 3, 'Number("")/Number(null)/Number("  ") are a finite 0 — none of these may become one');
  assert.equal(r.data.signals, 1);
  const sg = store.getIntel('sharp')[0];
  assert.deepEqual(sg.books, ['betmgm', 'draftkings', 'fanduel'], 'a zero-width interval [t,t] still stabs t; the three blanks never join');
  assert.match(sg.detail, /within 0m · history$/);
  assert.equal(hist.normalizeRow(hrow({ game_id: 'g1', book: 'x', gap_min: '12.5', detected_at: t })).gap_min, 12.5);
  for (const g of [null, '', '  ']) assert.equal(hist.normalizeRow(hrow({ game_id: 'g1', book: 'x', gap_min: g, detected_at: t })).gap_min, null, JSON.stringify(g));
});

test('detected_at coercion: +00:00, Z and 6-digit fractions land on one timeline, and the same instant dedupes across formats', async () => {
  const t = clock - 2 * MIN;
  const base = iso(t).replace(/\.\d{3}Z$/, '');
  const stamps = [`${base}.000000+00:00`, `${base}Z`, `${base}.000+00:00`];
  for (const s of stamps) assert.equal(hist.normalizeRow(hrow({ game_id: 'g1', book: 'x', detected_at: s })).at, Date.parse(`${base}Z`), s);
  fdb.setRows('line_movements', BOOKS.map((book, i) => hrow({ game_id: 'g1', book, gap_min: '10', detected_at: stamps[i] })));
  // Memory carries the same three moves with the Z stamp and a 3-digit fraction.
  store.setIntel('movements', BOOKS.map((book) => memOf(hrow({ game_id: 'g1', book, gap_min: '10', detected_at: `${base}.000Z` }))));
  const r = await sharp.run();
  assert.equal(r.data.rows, 3, `one instant in three spellings is three rows, not six (${r.summary})`);
  assert.equal(r.data.signals, 1);
  assert.match(store.getIntel('sharp')[0].detail, /within 10m · history$/, 'one instant, gap 10 each: the intersection is the whole [t−10, t]');
  // A 6-digit fraction is not rounded away: .123456 and .123 are the same ms.
  const a = hist.normalizeRow(hrow({ game_id: 'g1', book: 'x', detected_at: `${base}.123456+00:00` }));
  const b = hist.normalizeRow(hrow({ game_id: 'g1', book: 'x', detected_at: `${base}.123Z` }));
  assert.equal(a.at, b.at);
  assert.equal(hist.mergeMovements([a], [b]).length, 1);
});

test('rows that cannot be placed are dropped, not counted: empty book, empty side, unparseable or missing detected_at, a direction that is neither up nor down', async () => {
  const t = clock - 2 * MIN;
  fdb.setRows('line_movements', [
    ...BOOKS.map((book) => hrow({ game_id: 'g1', book, gap_min: '10', detected_at: t })),
    hrow({ game_id: 'g1', book: '', gap_min: '10', detected_at: t }),
    hrow({ game_id: 'g1', book: null, gap_min: '10', detected_at: t }),
    hrow({ game_id: 'g1', book: 'x1', side: '', gap_min: '10', detected_at: t }),
    hrow({ game_id: 'g1', book: 'x2', gap_min: '10', detected_at: 'soon' }),
    hrow({ game_id: 'g1', book: 'x3', gap_min: '10', detected_at: null }),
    hrow({ game_id: 'g1', book: 'x4', gap_min: '10', detected_at: '' }),
    hrow({ game_id: 'g1', book: 'x5', gap_min: '10', direction: 'flat', detected_at: t }),
  ]);
  // The fake select's gte on an unparseable stamp drops the row before the
  // reader sees it; PostgREST would never return one either. The rest reach
  // normalizeRow and must not survive it.
  const r = await sharp.run();
  assert.equal(r.data.rows, 3, r.summary);
  assert.equal(r.data.signals, 1);
  assert.deepEqual(store.getIntel('sharp')[0].books, ['betmgm', 'draftkings', 'fanduel']);
  assert.equal(hist.normalizeRow(hrow({ game_id: 'g1', book: '', detected_at: t })), null);
  assert.equal(hist.normalizeRow(hrow({ game_id: 'g1', book: 'x', detected_at: 'soon' })), null);
  assert.equal(hist.normalizeRow(hrow({ game_id: 'g1', book: 'x', direction: 'flat', detected_at: t })), null);
});

test('a memory row older than the window or for a game off the slate is not merged', async () => {
  store.setIntel('movements', [
    ...BOOKS.map((book) => memOf(hrow({ game_id: 'g1', book, gap_min: '10', detected_at: clock - 50 * MIN }))),
    ...BOOKS.map((book) => memOf(hrow({ game_id: 'notOnSlate', book, gap_min: '10', detected_at: clock - MIN }))),
  ]);
  const r = await sharp.run();
  assert.equal(r.summary, '0 steam · 0 movement rows in the last 45m across 1 games · history+memory', r.summary);
});
