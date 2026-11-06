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

let db, degraded, run;

before(async () => {
  // The tennis category below depends on close-capture being OFF, which is the
  // production default; pin it so a developer's shell env can't flip the test.
  delete process.env.TENNIS_CLOSE_CAPTURE;
  db = fakeDb();
  degraded = [];
  const { logger } = fakeLogger();
  mock.module(import.meta.resolve('../src/db/index.js'), { defaultExport: db, namedExports: { isConnected: db.isConnected, isMissingRelation: db.isMissingRelation } });
  mock.module(import.meta.resolve('../src/utils/index.js'), { namedExports: { logger } });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: { setClvReport: () => {}, reportDegraded: (k, d) => degraded.push({ k, d }) },
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

  const r = await run();

  assert.deepEqual(alarms(), [],
    `no coverage defect exists — every game has a batch every 3 minutes — yet got: ${JSON.stringify(alarms())} (summary: ${r.summary})`);
  assert.equal(r.data.unmeasurable, 8,
    `only the eight single-batch tennis plays lack a close; a live bet is out of scope, not unmeasurable (summary: ${r.summary})`);
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
