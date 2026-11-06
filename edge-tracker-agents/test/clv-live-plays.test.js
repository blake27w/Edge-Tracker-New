// ══════════════════════════════════════════════════════════════
// CLV tracker — plays that have NO closing line by construction must not be
// read as a snapshot-coverage defect.
//
// Live production, 2026-11-06: the watchdog reported "15 plays past close
// with only one snapshot batch — no CLV measurable" (`clv|unmeasurable`) on
// every run since boot, while `line_snapshots` took ~60k rows in three hours.
// The 4-day lookback held exactly 15 non-prop, not-yet-recorded qualified
// plays: 7 NFL in-game plays (`monitor_scores.live = true`, scored 15-75 min
// AFTER kickoff by the signal engine and nfl-live) and 8 TENNIS moneylines
// (tennis-ingest polls once a day, tennis-close is off, so entry and close
// are the same daily batch).
//
// A live bet has no closing-line value against a close that happened before
// it was placed — D37 says so, and capture() correctly returns
// `{unmeasurable: true}` for it at clv-tracker/index.js:164. The defect is
// that run() never looks at `live` (it is not even in the select's column
// list), so those plays are counted into `unmeasurable` and trip the
// `unmeasurable >= ALARM_MIN && !records.length` alarm at index.js:332 with a
// message that blames snapshot coverage. The 8 tennis plays genuinely have
// one batch — but 8 is under the 12-play floor on its own; it is the 7 live
// plays that push the count over.
//
// These tests drive the real run() against a scripted db with the production
// lifecycle: 3-minute snapshot cadence for six hours before kickoff and
// through the game, spread + total on both sides, 8 books per batch.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';

const MIN = 60_000;
const BOOKS = ['dk', 'fd', 'mgm', 'czr', 'pn', 'br', 'wh', 'esp'];
const iso = (ms) => new Date(ms).toISOString();

let db, degraded, run, config, store;

before(async () => {
  // The tennis category below depends on close-capture being OFF, which is the
  // production default; pin it so a developer's shell env can't flip the test.
  // `config` is imported AFTER the pin, because it reads the env at load time.
  delete process.env.TENNIS_CLOSE_CAPTURE;
  config = (await import('../src/config/index.js')).default;
  db = fakeDb();
  degraded = [];
  const { logger } = fakeLogger();
  // The real store is kept alongside the recording stub so the TTL/clear
  // semantics the watchdog relies on can be asserted against the real thing.
  store = await import('../src/store/index.js');
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: { setClvReport: () => {}, reportDegraded: (k, d) => { degraded.push({ k, d }); store.reportDegraded(k, d); } },
  });
  run = (await import('../src/agents/clv-tracker/index.js')).default.run;
});
after(() => mock.reset());

// One NFL game as the odds agent records it: a batch every 3 minutes from six
// hours before kickoff until `until`, every batch carrying spread (both teams)
// and total (Over/Under) across 8 books. The feed keeps quoting a game once it
// is underway, so in-play batches are real rows too — with a live total that
// has collapsed because points have already been scored.
function nflSnapshots({ gameId, home, away, kickoff, until, spread = 3.5, total = 44.5 }) {
  const rows = [];
  for (let t = kickoff - 360 * MIN; t <= until; t += 3 * MIN) {
    const inPlay = t > kickoff;
    const line = inPlay ? total - 14 : total;
    const sp = inPlay ? spread + 3 : spread;
    for (const book of BOOKS) {
      const base = { sport: 'NFL', game_id: gameId, commence_time: iso(kickoff), home, away, book, fetched_at: iso(t) };
      rows.push({ ...base, market: 'spreads', side: home, line: -sp, price: -110 });
      rows.push({ ...base, market: 'spreads', side: away, line: sp, price: -110 });
      rows.push({ ...base, market: 'totals', side: 'Over', line, price: -110 });
      rows.push({ ...base, market: 'totals', side: 'Under', line, price: -110 });
    }
  }
  return rows;
}

// The four in-game plays nfl-live / the signal engine issue on one game, as
// they land in monitor_scores: `live: true`, scored_at after kickoff.
function livePlays({ gameId, home, away, kickoff, offsetsMin }) {
  const [a, b, c, d] = offsetsMin;
  return [
    { sport: 'NFL', game_id: gameId, market: 'spread', side: away, line: 3.5, scored_at: iso(kickoff + a * MIN), qualified: true, live: true, status: 'pending' },
    { sport: 'NFL', game_id: gameId, market: 'spread', side: home, line: -3.5, scored_at: iso(kickoff + b * MIN), qualified: true, live: true, status: 'pending' },
    { sport: 'NFL', game_id: gameId, market: 'total', side: 'Under', line: 48.5, scored_at: iso(kickoff + c * MIN), qualified: true, live: true, status: 'pending' },
    { sport: 'NFL', game_id: gameId, market: 'total', side: 'Over', line: 40.5, scored_at: iso(kickoff + d * MIN), qualified: true, live: true, status: 'pending' },
  ];
}

// One tennis match as tennis-ingest mirrors it: a single daily h2h batch, and
// the play tennis-signal logs seconds later off that same batch. With
// tennis-close disabled nothing else is ever written for the match.
function tennisMatch({ id, p1, p2, ingestAt, startsAt }) {
  const snaps = BOOKS.slice(0, 4).flatMap((book) => [
    { sport: 'TENNIS', game_id: id, commence_time: iso(startsAt), home: p1, away: p2, book, market: 'h2h', side: p1, line: null, price: -150, fetched_at: iso(ingestAt) },
    { sport: 'TENNIS', game_id: id, commence_time: iso(startsAt), home: p1, away: p2, book, market: 'h2h', side: p2, line: null, price: 130, fetched_at: iso(ingestAt) },
  ]);
  const play = { sport: 'TENNIS', game_id: id, market: 'ml', side: p1, line: null, scored_at: iso(ingestAt + 18_000), qualified: true, live: false, observational: true, status: 'pending' };
  return { snaps, play };
}

const alarms = () => degraded.filter((d) => d.k === 'clv|unmeasurable');

test('the production window: 7 live NFL plays + 8 single-batch tennis plays must not trip the coverage alarm', async () => {
  degraded.length = 0;
  const now = Date.now();
  const snapshots = [], plays = [];

  // Sunday night game, three days ago: plays issued in the 1st-3rd quarters.
  const sea = { gameId: 'chi-sea', home: 'Seattle Seahawks', away: 'Chicago Bears', kickoff: now - 3 * 1440 * MIN };
  snapshots.push(...nflSnapshots({ ...sea, until: sea.kickoff + 200 * MIN }));
  plays.push(...livePlays({ ...sea, offsetsMin: [16, 39, 96, 96] }));

  // Thursday night game, kicked off 95 minutes ago and still being quoted.
  const bal = { gameId: 'jax-bal', home: 'Baltimore Ravens', away: 'Jacksonville Jaguars', kickoff: now - 95 * MIN };
  snapshots.push(...nflSnapshots({ ...bal, until: now - 2 * MIN }));
  plays.push(...livePlays({ ...bal, offsetsMin: [16, 73, 73, 73] }).slice(0, 3));

  // Two days of tennis, four matches each, ingested once at 22:28 and played
  // the next afternoon.
  for (let day = 2; day >= 1; day--) {
    const ingestAt = now - day * 1440 * MIN - 4 * 60 * MIN;
    for (let m = 0; m < 4; m++) {
      const t = tennisMatch({ id: `t${day}${m}`, p1: `P${day}${m}a`, p2: `P${day}${m}b`, ingestAt, startsAt: ingestAt + (14 + m) * 60 * MIN });
      snapshots.push(...t.snaps);
      plays.push(t.play);
    }
  }

  assert.equal(plays.filter((p) => p.live).length, 7);
  assert.equal(plays.length, 15);
  db.setRows('line_snapshots', snapshots);
  db.setRows('monitor_scores', plays);
  db.setRows('clv_records', []);
  db.calls.select.length = 0;

  const r = await run();

  // The projection is part of the fix. fakeDb records `cols` but does not
  // apply them, so a row keeps `live` whatever run() asked for — dropping it
  // from the select would pass every assertion below on this fake while
  // PostgREST handed production rows with no `live` at all. Pin the query.
  const playsQ = db.calls.select.find((c) => c.table === 'monitor_scores');
  assert.ok(playsQ, 'run() reads monitor_scores');
  assert.ok(playsQ.cols.split(',').map((c) => c.trim()).includes('live'),
    `monitor_scores projection must carry \`live\` — got '${playsQ.cols}'`);

  assert.deepEqual(alarms(), [],
    `no coverage defect exists — every game has a batch every 3 minutes — yet got: ${JSON.stringify(alarms())} (summary: ${r.summary})`);
  assert.equal(r.data.unmeasurable, 8,
    `only the eight single-batch tennis plays lack a close; a live bet is out of scope, not unmeasurable (summary: ${r.summary})`);
  assert.equal(r.data.inPlay, 7, 'and the seven live plays are reported for what they are');
});

test('a window of nothing but live in-game plays never alarms on snapshot coverage, at any count', async () => {
  // The sharper contract, so the fix cannot be "raise CLV_ALARM_MIN": twelve
  // live plays over three fully-covered games is the alarm floor exactly.
  degraded.length = 0;
  const now = Date.now();
  const snapshots = [], plays = [];
  for (let g = 0; g < 3; g++) {
    const game = { gameId: `g${g}`, home: `Home ${g}`, away: `Away ${g}`, kickoff: now - (g + 1) * 600 * MIN };
    snapshots.push(...nflSnapshots({ ...game, until: game.kickoff + 200 * MIN }));
    plays.push(...livePlays({ ...game, offsetsMin: [12, 30, 48, 70] }));
  }
  assert.equal(plays.length, 12);
  db.setRows('line_snapshots', snapshots);
  db.setRows('monitor_scores', plays);
  db.setRows('clv_records', []);

  const r = await run();

  assert.deepEqual(alarms(), [], `summary: ${r.summary}; degraded: ${JSON.stringify(degraded)}`);
  assert.equal(r.data.unmeasurable, 0, `live plays are not a coverage gap (summary: ${r.summary})`);
  assert.equal(r.data.recorded, 0, 'and a live number must never be written as a closing line');
});

// ── The other categories that must stay out of the alarm population ──

test('a prop play is "untracked market", not "too early" forever', async () => {
  // capture() used to return null for a market with no line_snapshots feed —
  // the same null as the timing guard — so six props read as "6 too early"
  // on every run for the life of the lookback.
  degraded.length = 0;
  db.setRows('line_snapshots', []);
  db.setRows('monitor_scores', [
    { sport: 'NFL', game_id: 'x', market: 'player_props', side: 'Over', line: 72.5, scored_at: iso(Date.now() - 60 * MIN), qualified: true, live: false, status: 'pending' },
    { sport: 'NFL', game_id: 'x', market: 'spread', side: null, line: 3.5, scored_at: iso(Date.now() - 60 * MIN), qualified: true, live: false, status: 'pending' },
  ]);
  db.setRows('clv_records', []);
  db.calls.select.length = 0;

  const r = await run();

  assert.equal(r.data.untracked, 2, `summary: ${r.summary}`);
  assert.equal(r.data.tooEarly, 0, 'nothing is pending — these markets will never have a close');
  assert.equal(db.calls.select.filter((c) => c.table === 'line_snapshots').length, 0, 'and no snapshot query is spent on them');
});

test('TENNIS with close-capture off is "no close-capture": in unmeasurable, out of the alarm population, at any count', async () => {
  // tennis-ingest writes one h2h batch a day and tennis-close is disabled, so
  // entry and close are the same batch BY DESIGN. Twelve of them — the alarm
  // floor exactly — must not read as a snapshot-coverage outage. Enabling
  // close-capture is a separate decision with API cost; this test does not
  // take it.
  degraded.length = 0;
  const now = Date.now();
  const snapshots = [], plays = [];
  for (let day = 3; day >= 1; day--) {
    const ingestAt = now - day * 1440 * MIN - 4 * 60 * MIN;
    for (let m = 0; m < 4; m++) {
      const t = tennisMatch({ id: `u${day}${m}`, p1: `Q${day}${m}a`, p2: `Q${day}${m}b`, ingestAt, startsAt: ingestAt + (14 + m) * 60 * MIN });
      snapshots.push(...t.snaps);
      plays.push(t.play);
    }
  }
  assert.equal(plays.length, 12);
  db.setRows('line_snapshots', snapshots);
  db.setRows('monitor_scores', plays);
  db.setRows('clv_records', []);

  const r = await run();

  assert.deepEqual(alarms(), [], `summary: ${r.summary}; degraded: ${JSON.stringify(degraded)}`);
  assert.equal(r.data.unmeasurable, 12, 'they genuinely have no close');
  assert.equal(r.data.noCloseCapture, 12, 'and the reason is named');
  assert.equal(r.data.recorded, 0);
});

test('a game with no commence_time is unmeasurable, never a fabricated close from the newest in-play batch', async () => {
  // Without a kickoff the close query has no upper bound, so the newest batch
  // we hold — in-play, with a collapsed total — would become "the close" and
  // `done` would then lock that CLV in. Twelve such plays: still no alarm,
  // and nothing written.
  degraded.length = 0;
  const now = Date.now();
  const snapshots = [], plays = [];
  for (let g = 0; g < 3; g++) {
    const kickoff = now - (g + 1) * 600 * MIN;
    const game = { gameId: `n${g}`, home: `H${g}`, away: `A${g}`, kickoff };
    snapshots.push(...nflSnapshots({ ...game, until: kickoff + 200 * MIN }).map((s) => ({ ...s, commence_time: null })));
    // Pre-game plays, logged an hour before kickoff — measurable if only we
    // knew when kickoff was.
    plays.push(...livePlays({ ...game, offsetsMin: [-60, -50, -40, -30] }).map((p) => ({ ...p, live: false })));
  }
  assert.equal(plays.length, 12);
  db.setRows('line_snapshots', snapshots);
  db.setRows('monitor_scores', plays);
  db.setRows('clv_records', []);
  db.calls.upsert.length = 0;

  const r = await run();

  assert.equal(r.data.recorded, 0, `a live number must never be written as a closing line (summary: ${r.summary})`);
  assert.equal(db.calls.upsert.filter((c) => c.table === 'clv_records').length, 0);
  assert.equal(r.data.noCommence, 12, `summary: ${r.summary}`);
  assert.equal(r.data.unmeasurable, 12);
  assert.deepEqual(alarms(), [], `no kickoff is not a coverage gap: ${JSON.stringify(degraded)}`);
});

// ── Regression sweep on the alarm population ─────────────────────
//
// The fix narrowed WHO is counted, not the floor. Each category is walked
// to the edge of ALARM_MIN (12) so that the floor is shown to be real for
// the one branch that remains, and shown NOT to be reachable through any of
// the branches that were wrongly feeding it.

// A pre-game NFL spread in a tracked market with exactly ONE snapshot batch:
// the play was logged seconds after the only batch the game ever got, and
// the game has since kicked off. capture() finds entry === close and returns
// `{unmeasurable}` with no further marker — this is the genuine coverage
// failure the alarm exists for.
function singleBatchPlay({ id, kickoff, batchAt = kickoff - 120 * MIN, sport = 'NFL', live = false, commence = iso(kickoff) }) {
  const home = `H-${id}`, away = `A-${id}`;
  const snaps = BOOKS.map((book) => ({
    sport, game_id: id, commence_time: commence, home, away, book,
    market: 'spreads', side: away, line: 3.5, price: -110, fetched_at: iso(batchAt),
  }));
  const play = { sport, game_id: id, market: 'spread', side: away, line: 3.5, scored_at: iso(batchAt + 10_000), qualified: true, live, status: 'pending' };
  return { snaps, play };
}

// N single-batch pre-game plays over N games that kicked off 1-N hours ago.
function singleBatchWindow(n, now) {
  const snapshots = [], plays = [];
  for (let i = 0; i < n; i++) {
    const g = singleBatchPlay({ id: `sb${i}`, kickoff: now - (i + 1) * 60 * MIN });
    snapshots.push(...g.snaps);
    plays.push(g.play);
  }
  return { snapshots, plays };
}

async function runWith({ snapshots, plays }) {
  degraded.length = 0;
  for (const d of store.getDegraded()) store.clearDegraded(d.key);
  db.setRows('line_snapshots', snapshots);
  db.setRows('monitor_scores', plays);
  db.setRows('clv_records', []);
  db.calls.upsert.length = 0;
  return run();
}
const clvUpserts = () => db.calls.upsert.filter((c) => c.table === 'clv_records');
const counts = (r) => {
  const { inPlay, untracked, noCloseCapture, noCommence, unmeasurable, recorded } = r.data;
  return { inPlay, untracked, noCloseCapture, noCommence, unmeasurable, recorded };
};

test('twelve pre-game plays in a tracked market with one batch only DO alarm — the floor is real', async () => {
  const now = Date.now();
  const w = singleBatchWindow(12, now);
  const r = await runWith(w);

  assert.equal(alarms().length, 1, `the coverage branch still fires at the floor (summary: ${r.summary}; degraded: ${JSON.stringify(degraded)})`);
  assert.deepEqual(counts(r), { inPlay: 0, untracked: 0, noCloseCapture: 0, noCommence: 0, unmeasurable: 12, recorded: 0 });
  assert.equal(clvUpserts().length, 0, 'nothing fabricated');

  // The message claims only what the surviving branch measures.
  const msg = alarms()[0].d;
  assert.doesNotMatch(msg, /only one snapshot batch/, `the old wording blamed coverage for every category: ${msg}`);
  assert.match(msg, /^12 pre-game plays past kickoff with no pre-kickoff batch distinct from entry/, msg);
});

test('eleven such plays do not alarm — ALARM_MIN is unchanged at 12', async () => {
  const now = Date.now();
  const r = await runWith(singleBatchWindow(11, now));
  assert.deepEqual(alarms(), [], `summary: ${r.summary}`);
  assert.deepEqual(counts(r), { inPlay: 0, untracked: 0, noCloseCapture: 0, noCommence: 0, unmeasurable: 11, recorded: 0 });
});

test('twelve where one is LIVE: eleven in the population, no alarm, no row for the live play', async () => {
  const now = Date.now();
  const w = singleBatchWindow(11, now);
  // A live bet on a densely-covered game, scored 20 minutes into it.
  const g = { gameId: 'lv', home: 'Home LV', away: 'Away LV', kickoff: now - 60 * MIN };
  w.snapshots.push(...nflSnapshots({ ...g, until: now - 2 * MIN }));
  w.plays.push(livePlays({ ...g, offsetsMin: [20, 0, 0, 0] })[0]);
  assert.equal(w.plays.length, 12);

  const r = await runWith(w);

  assert.deepEqual(alarms(), [], `summary: ${r.summary}; degraded: ${JSON.stringify(degraded)}`);
  assert.deepEqual(counts(r), { inPlay: 1, untracked: 0, noCloseCapture: 0, noCommence: 0, unmeasurable: 11, recorded: 0 });
  assert.equal(clvUpserts().length, 0, 'a live play must never produce a clv_records row');
  assert.equal(db.calls.select.filter((c) => c.table === 'line_snapshots' && c.opts.match?.game_id === 'lv').length, 0,
    'and no snapshot query is spent on it');
});

test('twelve where one is TENNIS without close-capture: counted as noCloseCapture, no alarm', async () => {
  assert.equal(config.tennisCloseCapture, false, 'precondition: the production default');
  const now = Date.now();
  const w = singleBatchWindow(11, now);
  const ingestAt = now - 20 * 60 * MIN;
  const t = tennisMatch({ id: 'tn', p1: 'Pa', p2: 'Pb', ingestAt, startsAt: now - 30 * MIN });
  w.snapshots.push(...t.snaps);
  w.plays.push(t.play);
  assert.equal(w.plays.length, 12);

  const r = await runWith(w);

  assert.deepEqual(alarms(), [], `summary: ${r.summary}; degraded: ${JSON.stringify(degraded)}`);
  // Tennis is genuinely unmeasurable (inside the 12) but explained, so the
  // alarm population is 12 - 1 = 11.
  assert.deepEqual(counts(r), { inPlay: 0, untracked: 0, noCloseCapture: 1, noCommence: 0, unmeasurable: 12, recorded: 0 });
  assert.equal(clvUpserts().length, 0);
});

test('the same twelve with TENNIS_CLOSE_CAPTURE on: tennis counts normally and the alarm fires', async () => {
  // With close-capture enabled a single-batch tennis play IS a coverage
  // failure — the close agent should have written a second batch — so it
  // belongs in the population and twelve is the floor.
  const now = Date.now();
  const w = singleBatchWindow(11, now);
  const t = tennisMatch({ id: 'tn2', p1: 'Pc', p2: 'Pd', ingestAt: now - 20 * 60 * MIN, startsAt: now - 30 * MIN });
  w.snapshots.push(...t.snaps);
  w.plays.push(t.play);

  config.tennisCloseCapture = true;
  let r;
  try { r = await runWith(w); } finally { config.tennisCloseCapture = false; }

  assert.equal(alarms().length, 1, `summary: ${r.summary}; degraded: ${JSON.stringify(degraded)}`);
  assert.deepEqual(counts(r), { inPlay: 0, untracked: 0, noCloseCapture: 0, noCommence: 0, unmeasurable: 12, recorded: 0 });
  assert.match(alarms()[0].d, /^12 pre-game plays/);
});

test('twelve where one has null commence_time: counted as noCommence, no alarm, no fabricated close', async () => {
  const now = Date.now();
  const w = singleBatchWindow(11, now);
  // Dense coverage, pre-game play, in-play batches on file with a collapsed
  // total — exactly the shape the unbounded close query would have scored.
  const kickoff = now - 90 * MIN;
  const g = { gameId: 'nc', home: 'Home NC', away: 'Away NC', kickoff };
  w.snapshots.push(...nflSnapshots({ ...g, until: now - 2 * MIN }).map((s) => ({ ...s, commence_time: null })));
  w.plays.push({ ...livePlays({ ...g, offsetsMin: [-60, 0, 0, 0] })[2], live: false, scored_at: iso(kickoff - 60 * MIN) });
  assert.equal(w.plays.length, 12);

  const r = await runWith(w);

  assert.deepEqual(alarms(), [], `summary: ${r.summary}; degraded: ${JSON.stringify(degraded)}`);
  assert.deepEqual(counts(r), { inPlay: 0, untracked: 0, noCloseCapture: 0, noCommence: 1, unmeasurable: 12, recorded: 0 });
  assert.equal(clvUpserts().length, 0, 'a null-commence play must never produce a clv_records row');
});

test('a TENNIS match that DOES have a distinct close is recorded, close-capture flag or not', async () => {
  // Nothing in the fix may stop a real close from landing: an ingest batch
  // at -150 and a near-start batch at -170 is a measurable moneyline CLV.
  const now = Date.now();
  const startsAt = now - 30 * MIN;
  const t = tennisMatch({ id: 'tc', p1: 'Pe', p2: 'Pf', ingestAt: now - 20 * 60 * MIN, startsAt });
  const closeAt = startsAt - 10 * MIN;
  const close = BOOKS.slice(0, 4).map((book) => ({
    sport: 'TENNIS', game_id: 'tc', commence_time: iso(startsAt), home: 'Pe', away: 'Pf', book,
    market: 'h2h', side: 'Pe', line: null, price: -170, fetched_at: iso(closeAt),
  }));

  const r = await runWith({ snapshots: [...t.snaps, ...close], plays: [t.play] });

  assert.deepEqual(counts(r), { inPlay: 0, untracked: 0, noCloseCapture: 0, noCommence: 0, unmeasurable: 0, recorded: 1 }, r.summary);
  assert.equal(clvUpserts().length, 1);
  const row = clvUpserts()[0].rows[0];
  assert.equal(row.game_id, 'tc');
  assert.equal(row.bet_market, 'ml');
  assert.notEqual(row.entry_at, row.close_at, 'entry and close are distinct batches');
  assert.equal(row.odds_logged, -150);
  assert.equal(row.odds_close, -170);
  assert.equal(row.beat_close, true, 'we took -150 and it closed -170');
  assert.equal(row.suspect, false);
  assert.deepEqual(alarms(), []);
});

test('the clv|unmeasurable key is not refreshed by a run with no alarm, and ages out at the TTL', async () => {
  // The agent never clears the key itself; the store entry is self-expiring
  // (DEGRADED_TTL_MS, 90 min) and stays alive only while runs keep
  // re-reporting it. A fixed population therefore stops feeding it and it
  // ages out — the watchdog's clear semantics.
  const now = Date.now();
  const key = 'clv|unmeasurable';
  await runWith(singleBatchWindow(12, now));
  const first = store.getDegraded().find((d) => d.key === key);
  assert.ok(first, 'the alarm landed in the real store');
  assert.equal(first.count, 1);

  // A second alarm run keeps it alive and counts it.
  degraded.length = 0;
  db.calls.upsert.length = 0;
  await run();
  const second = store.getDegraded().find((d) => d.key === key);
  assert.equal(second.count, 2);

  // A run with no alarm neither clears nor refreshes it.
  degraded.length = 0;
  db.setRows('monitor_scores', singleBatchWindow(11, now).plays);
  await run();
  assert.deepEqual(alarms(), []);
  const after = store.getDegraded().find((d) => d.key === key);
  assert.ok(after, 'a quiet run does not retract the entry early');
  assert.equal(after.count, 2, 'and does not touch it');
  assert.equal(after.at, second.at, 'the last-reported stamp is not refreshed by a quiet run');
  assert.equal(after.since, first.since);

  // ...and at the TTL it is gone, with no agent action required.
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    mock.timers.tick(90 * MIN + 1000);
    assert.equal(store.getDegraded().find((d) => d.key === key), undefined, 'aged out at DEGRADED_TTL_MS');
  } finally { mock.timers.reset(); }
});

test('`live` as the column actually delivers it — boolean or null — classifies correctly', async () => {
  // monitor_scores.live is `boolean default false` (schema.sql) and reaches
  // run() through supabase-js as JSON true/false/null; a string form cannot
  // arrive. The gate is a plain truthiness check, so these three shapes are
  // the contract: only `true` is in-play.
  const now = Date.now();
  const w = singleBatchWindow(0, now);
  const shapes = [true, false, null, undefined];
  shapes.forEach((live, i) => {
    const g = singleBatchPlay({ id: `cx${i}`, kickoff: now - (i + 1) * 60 * MIN, live });
    if (live === undefined) delete g.play.live;
    w.snapshots.push(...g.snaps);
    w.plays.push(g.play);
  });

  const r = await runWith(w);

  assert.deepEqual(counts(r), { inPlay: 1, untracked: 0, noCloseCapture: 0, noCommence: 0, unmeasurable: 3, recorded: 0 }, r.summary);
  assert.equal(clvUpserts().length, 0);
});
