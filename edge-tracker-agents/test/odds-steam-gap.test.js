// ══════════════════════════════════════════════════════════════
// The steam feed's gap filter — the one guard that rehydration MADE necessary.
//
// `sharp` reads getIntel('movements') — the GAP-FILTERED one of the odds
// agent's two published feeds; the complete one, `movementsAll`, belongs to
// `public-splits` — and treats >= 3 co-directional rows in it
// as STEAM: a claim about SIMULTANEITY ("3 books moved totals Over down"). That
// was safe by construction before the baseline was rehydrated, because a
// movement row could only exist if two consecutive in-process fetches of that
// key straddled the move. With rehydration a baseline can be up to
// ODDS_MOVE_MAX_GAP_MIN (360) minutes old, so a total that drifted 44.5 -> 43.5
// over an afternoon at three books would arrive in one array and be published
// as coordinated money — and flow on into corroborate / public-fade /
// sharp-divergence / export.
//
// So odds filters sharp's feed to gaps within one odds cycle before
// publishing, and the rows carry `gap_min` wherever they land. Both halves are
// tested: the wide-gap drift must not reach `sharp`, and a genuinely
// simultaneous move must still get through — a filter that drops everything
// would pass the first assertion on its own.
//
// `line_movements` is NOT filtered, and neither is `movementsAll`: the row is a
// true observation, it is just not evidence of simultaneity.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';
// Not mocked: what `sharp` can actually see is the thing being asserted, and a
// faked store would prove nothing about the real publish path.
import { getIntel } from '../src/store/index.js';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const BOOKS = ['draftkings', 'fanduel', 'betmgm'];

// The feed's current total. Runs mutate it between calls.
let TOTAL = 43.5;

// 300 minutes old: inside the 360-minute emit bound (so these DO produce
// movement rows) and far outside the 35-minute steam bound.
const SNAPS = BOOKS.flatMap((book) => ['Over', 'Under'].map((side) => ({
  game_id: 'g1', book, market: 'totals', side,
  line: 44.5, price: -110, fetched_at: iso(now - 300 * MIN),
})));

const ev = () => ({
  id: 'g1', home_team: 'Home', away_team: 'Away', commence_time: iso(now + 20 * MIN),
  bookmakers: BOOKS.map((key) => ({
    key, last_update: iso(Date.now()),
    markets: [{
      key: 'totals', last_update: iso(Date.now()),
      outcomes: [{ name: 'Over', point: TOTAL, price: -110 }, { name: 'Under', point: TOTAL, price: -110 }],
    }],
  })),
});

let mod;
let sharp;
let fdb;

// The per-key fetch dedup is `Date.now() - lastFetch < ivMs`, and ivMs here is
// a fraction of a millisecond — two runs inside the same millisecond make the
// second one paced-skip. One tick between runs, and only that.
const tick = () => new Promise((r) => setTimeout(r, 5));

before(async () => {
  for (const k of ['ODDS_STRIKE_MIN', 'ODDS_NEAR_MIN', 'ODDS_MID_MIN', 'ODDS_IDLE_MIN']) {
    process.env[k] = '0.000001';
  }

  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: { allocation: { A: 1 }, monthlyBudget: 20000, tier: 'starter', key: 'test-key',
        footballSports: [], footballPriority: 'false', footballPriorityOn: () => false,
        base: 'https://api.the-odds-api.com/v4' },
      SPORTS: { A: { key: 'k_A' } },
      BOOKS, BOOK_LABELS: { draftkings: 'DK', fanduel: 'FD', betmgm: 'MGM' },
      rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: false,
    },
  });

  fdb = fakeDb({ line_snapshots: SNAPS });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb,
    namedExports: { isMissingRelation: fdb.isMissingRelation },
  });

  const fl = fakeLogger();
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: fl.logger, notifyAll: async () => ({ total: 0 }) },
  });

  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?') ? [{ key: 'k_A', active: true }] : [ev()]),
  });

  mod = await import('../src/agents/odds/index.js');
  sharp = (await import('../src/agents/sharp/index.js')).default;
});
after(() => mock.reset());

// ── The pure filter ─────────────────────────────────────────────
const row = (gap) => ({ game_id: 'g1', book: 'draftkings', market: 'totals', side: 'Over', direction: 'down', moved: -1, gap_min: gap });

test('the filter keeps one odds cycle and drops an afternoon', () => {
  const kept = mod.steamSafeMovements([row(0), row(4), row(10), row(30.1), row(35), row(35.1), row(300)]);
  assert.deepEqual(kept.map((r) => r.gap_min), [0, 4, 10, 30.1, 35],
    'strike (4), near (10) and a real mid gap (30 + the wake grid) are one odds cycle; 300 minutes is not simultaneity by any reading');
});

test('a row that cannot prove its gap is dropped, not trusted', () => {
  // gap_min is what makes these rows self-identifying wherever they land. A row
  // without it (a pre-fix row, or any other producer) cannot be SHOWN to be
  // simultaneous, and steam is a claim that has to be shown.
  assert.deepEqual(mod.steamSafeMovements([{ ...row(1), gap_min: null }]), []);
  assert.deepEqual(mod.steamSafeMovements([{ ...row(1), gap_min: undefined }]), []);
  assert.deepEqual(mod.steamSafeMovements([{ ...row(1), gap_min: 'soon' }]), []);
  assert.deepEqual(mod.steamSafeMovements(null), []);
});

// ── End to end, through the real store and the real sharp agent ──
test('a 5-hour rehydrated drift at three books is NOT published as steam', async () => {
  const res = await mod.default.run();

  // Every row is real and every row is written: 3 books x {Over, Under},
  // 44.5 -> 43.5 measured off a 300-minute-old rehydrated baseline.
  assert.equal(res.data.movements, 6, res.summary);
  const written = fdb.calls.insert.filter((c) => c.table === 'line_movements').at(-1).rows;
  assert.equal(written.length, 6, 'line_movements is NOT filtered — the observation is true');
  assert.ok(written.every((r) => r.gap_min > 290), `gap_min must ride on the row: ${JSON.stringify(written[0])}`);
  assert.ok(written.every((r) => r.baseline_source === 'rehydrated'));

  // ... and none of it reaches the steam path.
  assert.equal(res.data.steamFeed, 0, res.summary);
  assert.equal(res.data.steamDropped, 6);
  assert.match(res.summary, /too wide for steam/, 'the drop has to be visible, not silent');
  assert.equal(getIntel('movements').length, 0,
    'the published feed is what sharp reads — a six-hour drift in it is reported as coordinated money');

  // The actual consequence, through the real agent: before the filter this run
  // emitted `signal_type: 'steam', detail: "3 books moved totals Over down"`.
  const s = await sharp.run();
  // The history reader sees the six written rows too; none is gap-eligible.
  assert.match(s.summary, /^0 steam · /, s.summary);
  assert.equal(s.data.clusters, 0);
  assert.equal(getIntel('sharp').length, 0);
  assert.equal(fdb.calls.insert.filter((c) => c.table === 'sharp_signals').length, 0,
    'nothing fabricated into sharp_signals either');
});

test('a move inside one odds cycle still reaches sharp — the filter is not a mute button', async () => {
  // Run 1 left every key with a fresh in-process baseline, so this move's gap
  // is the inter-run gap: milliseconds. Same code path, same books, opposite
  // outcome — which is what makes the previous test evidence about the GAP
  // rather than about the filter being on.
  TOTAL = 43;
  await tick();
  const res = await mod.default.run();

  assert.equal(res.data.movements, 6, res.summary);
  assert.equal(res.data.steamDropped, 0, res.summary);
  assert.equal(res.data.steamFeed, 6);
  assert.equal(getIntel('movements').length, 6);
  assert.ok(getIntel('movements').every((m) => Number.isFinite(m.gap_min)),
    'the in-memory rows stay self-identifying — gap_min is not a Postgres-only column');

  const s = await sharp.run();
  const steam = getIntel('sharp');
  assert.ok(steam.length >= 1, s.summary);
  assert.ok(steam.some((x) => x.signal_type === 'steam' && /3 books moved totals/.test(x.detail)),
    `a genuinely simultaneous 3-book move must still be steam: ${JSON.stringify(steam)}`);
});

// ── The boundary, exactly, and the type matrix ───────────────────
// Added by the verification pass: the bound is a <= comparison against a value
// rounded to 1dp, and the rows can arrive from any producer of that array, so
// both edges are worth pinning rather than inferring.

test('the bound is inclusive at 35 and nothing above it survives', () => {
  const keep = (g) => mod.steamSafeMovements([row(g)]).length === 1;
  assert.equal(keep(34.9), true);
  assert.equal(keep(35), true, 'inclusive — MID (30) plus the wake-grid headroom it needs');
  assert.equal(keep(35.1), false, 'one tenth of a minute over is over');
  assert.equal(keep(0), true, 'two observations in the same instant is the simultaneous case');
});

test('a real MID-tier gap lands INSIDE the bound — measured, not assumed', () => {
  // Why 35 and not MID_MIN's 30. The per-key dedup fires on
  // `now - lastFetch >= ivMs`, so a real MID-tier gap is 30 minutes PLUS the
  // wake grid (odds wakes every 3 min on `starter`) PLUS the fetch — and
  // gap_min rounds to 1dp, which left only a ~3-second grace at 30. A MID
  // refetch 3 seconds late measured 30.1 and was dropped, so the feed carried
  // only STRIKE (4) and NEAR (10): the one tier the constant was chosen to
  // admit was the one it excluded. 35 admits it with headroom for the grid.
  const cur = { sport: 'A', game_id: 'g1', market: 'totals', book: 'draftkings', side: 'Over', line: 43.5, price: -110 };
  const gapOf = (ms) => {
    const v = mod.movementFrom({ line: 44.5, price: -110, at: Date.now() - ms, source: 'rehydrated' }, cur, Date.now());
    assert.ok(v && v.move, 'well inside the 360-minute write bound');
    return v.move;
  };

  const justLate = gapOf(30 * MIN + 3_000);
  assert.equal(justLate.gap_min, 30.1, 'rounded to 1dp');
  assert.equal(mod.steamSafeMovements([justLate]).length, 1,
    'an ordinary mid-tier refetch IS one odds cycle and must reach the steam feed');

  // A full wake-grid tick (3 min) late is still one mid-tier cycle.
  const oneGridLate = gapOf(30 * MIN + 3 * MIN);
  assert.equal(oneGridLate.gap_min, 33);
  assert.equal(mod.steamSafeMovements([oneGridLate]).length, 1, 'a whole wake tick of slack still fits');

  // The idle tier does not, and that is the line the bound is drawing.
  const idle = gapOf(180 * MIN);
  assert.equal(mod.steamSafeMovements([idle]).length, 0, 'a three-hour drift is not steam');
});

test('only a number or a numeric string is a gap — everything else is dropped', () => {
  // Same family as the null case already covered: `Number()` turns '  ', [],
  // true and false into finite numbers, and every one of them would read as
  // gap ZERO, the most simultaneous row there is. `sharp` is the named
  // follow-up for checking gap_min itself, so this array's own filter is the
  // only thing standing between a foreign producer and a fabricated steam call.
  const kept = (g) => mod.steamSafeMovements([{ ...row(1), gap_min: g }]).length;
  assert.equal(kept('35'), 1, 'Postgres hands numerics back as strings');
  assert.equal(kept('36'), 0);
  assert.equal(kept(0), 1);
  for (const junk of ['  ', [], [5], true, false, {}, 'soon', NaN, Infinity, -Infinity, -5]) {
    assert.equal(kept(junk), 0, `${JSON.stringify(junk) ?? String(junk)} is not a gap`);
  }
});

test('movementFrom never produces a gap the filter has to second-guess', () => {
  // The only in-repo producer of these rows: a future or unparseable `at` is a
  // stale verdict, never a movement with a negative or NaN gap.
  const cur = { sport: 'A', game_id: 'g1', market: 'totals', book: 'draftkings', side: 'Over', line: 43.5, price: -110 };
  const t = Date.now();
  for (const at of [t + 5 * MIN, NaN, undefined, null, 'nope']) {
    const v = mod.movementFrom({ line: 44.5, price: -110, at, source: 'rehydrated' }, cur, t);
    assert.deepEqual(v, { stale: true }, `at=${String(at)} must be stale, not a movement`);
  }
});
