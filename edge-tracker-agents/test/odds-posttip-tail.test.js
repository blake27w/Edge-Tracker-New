// ══════════════════════════════════════════════════════════════
// The post-tip polling tail (D102).
//
// Before this change a game held its whole league on the STRIKE cadence
// (4 min) for 3.5 hours after kickoff, for every sport, whether or not
// anything was reading those rows. The tail is now TWO windows:
//
//   oddsApi.liveSports  → the full -3.5h (a real in-play consumer)
//   everything else      → -POSTTIP_MIN (default 45 min)
//
// 45 minutes is not "nothing reads post-tip": book-move scores started games
// off a -3h slate and sharp needs three books inside a 35-min window, and both
// want the FRESHEST post-tip rows. What drops is the ~2h45m beyond that, which
// no consumer can use.
//
// What has to be nailed down, because each half fails differently:
//   1. the short window still covers the fresh post-tip rows (STRIKE at -30m)
//   2. the long tail is actually gone for a non-live sport (MID at -50m)
//   3. PRE-tip behaviour is untouched — the regression a careless rewrite of
//      the dt bands would cause, and the one that would cost real plays
//   4. a live sport keeps the whole -3.5h
//   5. the demotion is REPORTED, because a cadence that halved itself
//      silently is indistinguishable from one nobody changed
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeLogger } from './helpers/fake-db.js';
import { setGames } from '../src/store/index.js';

const MIN = 60_000;
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
// A slate is scripted as offsets from the moment of the assertion: negative is
// "tipped N ago", positive is "starts in N".
const slate = (sport, ...offsets) => offsets.map((off, i) => ({
  sport, game_id: `${sport}-${i}`, commence_time: iso(Date.now() + off),
}));

// The real cadence constants — this file is about which TIER a slate earns, so
// the four minute values must be the real distinguishable ones and not the
// 0.000001 the pacing-insensitive odds tests use.
const STRIKE = 4, NEAR = 10, MID = 30, IDLE = 180;

// Mutated per test: sportIntervalMin reads it per call, exactly as the live
// service does (an env change needs no restart).
const oddsApiMock = {
  allocation: { A: 0.5, NFL: 0.25, NCAAB: 0.25 },
  monthlyBudget: 20000, tier: 'starter', key: 'test-key',
  footballSports: [], footballPriority: 'false', footballPriorityOn: () => false,
  liveSports: [],
  postTipMin: 45,
  base: 'https://api.the-odds-api.com/v4',
};

let mod;
let fdb;

before(async () => {
  process.env.ODDS_STRIKE_MIN = String(STRIKE);
  process.env.ODDS_NEAR_MIN = String(NEAR);
  process.env.ODDS_MID_MIN = String(MID);
  process.env.ODDS_IDLE_MIN = String(IDLE);
  delete process.env.ODDS_POSTTIP_MIN;          // the 45-minute default

  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: oddsApiMock,
      SPORTS: { A: { key: 'k_A' } },
      BOOKS: ['draftkings'], BOOK_LABELS: { draftkings: 'DK' },
      rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: false,
    },
  });

  fdb = fakeDb({});
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fdb,
    namedExports: { isMissingRelation: fdb.isMissingRelation },
  });

  const fl = fakeLogger();
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: fl.logger, notifyAll: async () => ({ total: 0 }) },
  });

  mod = await import('../src/agents/odds/index.js');
});
after(() => mock.reset());

beforeEach(() => { oddsApiMock.liveSports = []; oddsApiMock.postTipMin = 45; setGames([]); });

// ── 1. the short window still covers the fresh post-tip rows ────
test('a non-live sport whose last game tipped 30 min ago is still on STRIKE', () => {
  setGames(slate('A', -30 * MIN));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('A', 1, lowered), STRIKE,
    'book-move scores started games and wants the freshest rows — 30 min in is inside the 45-min window');
  assert.deepEqual([...lowered.keys()], [], 'nothing was demoted, so nothing is reported');
});

test('the 45-minute edge: 44 min in is STRIKE, 46 min in is not', () => {
  setGames(slate('A', -44 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), STRIKE);
  setGames(slate('A', -46 * MIN));
  assert.notEqual(mod.sportIntervalMin('A', 1), STRIKE);
});

// ── 2. the long tail is gone ────────────────────────────────────
test('tipped 50 min ago with the next game 8h out drops to MID — the 3.5h tail is gone', () => {
  setGames(slate('A', -50 * MIN, 8 * H));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('A', 1, lowered), MID,
    'the 8h game is inside the 12h MID band, so MID is the floor — STRIKE is what this refuses');
  assert.deepEqual([...lowered.keys()], ['A'],
    'this exact slate was STRIKE before the change, so the demotion is named');
});

test('tipped 50 min ago with nothing else on the board drops all the way to IDLE', () => {
  setGames(slate('A', -50 * MIN));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('A', 1, lowered), IDLE);
  assert.deepEqual([...lowered.keys()], ['A']);
});

test('the dead 3h tail: tipped 3h ago is IDLE, not STRIKE', () => {
  setGames(slate('A', -3 * H));
  assert.equal(mod.sportIntervalMin('A', 1), IDLE,
    'this is the overwhelmingly wasteful case — 3h after the last tip of the night');
});

// ── 3. PRE-tip behaviour is byte-identical ──────────────────────
test('tipped 50 min ago but the NEXT game starts in 20 min is STRIKE — pre-tip is untouched', () => {
  setGames(slate('A', -50 * MIN, 20 * MIN));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('A', 1, lowered), STRIKE);
  assert.deepEqual([...lowered.keys()], [],
    'the old window would have returned STRIKE too, so this run demoted nothing');
});

test('a game 60 min out is NEAR, and 8h out is MID, for a non-live sport', () => {
  setGames(slate('A', 60 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), NEAR);
  setGames(slate('A', 8 * H));
  assert.equal(mod.sportIntervalMin('A', 1), MID);
  setGames(slate('A', 20 * H));
  assert.equal(mod.sportIntervalMin('A', 1), IDLE);
});

test('the governor still stretches MID/IDLE and still never touches STRIKE/NEAR', () => {
  setGames(slate('A', 8 * H));
  assert.equal(mod.sportIntervalMin('A', 2), MID * 2);
  setGames(slate('A', -50 * MIN, 60 * MIN));
  assert.equal(mod.sportIntervalMin('A', 4), NEAR, 'NEAR is protected even after the demotion path ran');
  setGames(slate('A', -30 * MIN));
  assert.equal(mod.sportIntervalMin('A', 4), STRIKE, 'and so is the short post-tip window');
});

test('the freshest game wins: 50 min in AND 20 min in is STRIKE', () => {
  setGames(slate('A', -50 * MIN, -20 * MIN));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('A', 1, lowered), STRIKE);
  assert.deepEqual([...lowered.keys()], [], 'a sport is not "demoted" because one of its games aged out');
});

// ── 4. a live sport keeps the full tail ─────────────────────────
test('NFL tipped 2h ago keeps STRIKE when it is in liveSports', () => {
  oddsApiMock.liveSports = ['NFL'];
  setGames(slate('NFL', -2 * H));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('NFL', 1, lowered), STRIKE,
    'nfl.live reads these rows — this is the tail the change is paying for');
  assert.deepEqual([...lowered.keys()], []);
});

test('the same NFL slate drops to IDLE when liveSports is empty — the consumer is off', () => {
  oddsApiMock.liveSports = [];
  setGames(slate('NFL', -2 * H));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('NFL', 1, lowered), IDLE);
  assert.deepEqual([...lowered.keys()], ['NFL']);
});

test('ODDS_LIVE_SPORTS is not NFL-shaped: NCAAB in the list keeps the full tail', () => {
  oddsApiMock.liveSports = ['NCAAB'];
  setGames([...slate('NCAAB', -2 * H), ...slate('A', -2 * H)]);
  assert.equal(mod.sportIntervalMin('NCAAB', 1), STRIKE);
  assert.equal(mod.sportIntervalMin('A', 1), IDLE, 'and only the listed sport');
});

test('even a live sport ends at -3.5h: NFL tipped 4h ago is IDLE', () => {
  oddsApiMock.liveSports = ['NFL'];
  setGames(slate('NFL', -4 * H));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('NFL', 1, lowered), IDLE);
  assert.deepEqual([...lowered.keys()], [], 'the old window would not have polled this either');
});

test('a config with no liveSports key at all does not throw — the odds tests mock the whole object', () => {
  delete oddsApiMock.liveSports;
  setGames(slate('A', -30 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), STRIKE);
  setGames(slate('A', -2 * H));
  assert.equal(mod.sportIntervalMin('A', 1), IDLE);
  oddsApiMock.liveSports = [];
});

test('an unparseable commence_time is still ignored, not treated as live', () => {
  setGames([{ sport: 'A', game_id: 'x', commence_time: 'soon' },
            { sport: 'A', game_id: 'y', commence_time: null }]);
  assert.equal(mod.sportIntervalMin('A', 1), IDLE);
});

// ── 5. the tail length knob, and 0 as a real setting ────────────
// The VALUE comes from config (`oddsApi.postTipMin`) because the reader that
// can tell '  ' from 0 — intEnv — lives there; env parsing is pinned in
// test/odds-posttip-knob.test.js. What belongs here is what the agent does
// with the number it is handed, read per call exactly as the live service does
// (a config change needs no restart).

test('postTipMin 0 is HONOURED — zero post-tip polling, not the default', () => {
  oddsApiMock.postTipMin = 0;
  setGames(slate('A', -1 * MIN));
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('A', 1, lowered), IDLE,
    '0 means "drop the moment it tips"; Number("") is a finite 0, so `|| 45` could not tell this from unset');
  assert.deepEqual([...lowered.keys()], ['A']);
  setGames(slate('A', 1 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), STRIKE, 'and pre-tip is still pre-tip at 0');
});

test('postTipMin 120 widens the window without touching the live-sport tail', () => {
  oddsApiMock.postTipMin = 120;
  setGames(slate('A', -100 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), STRIKE);
  setGames(slate('A', -3.4 * 60 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), IDLE, '120 < 210, so the full tail is still strictly longer');
});

test('a tail longer than the FULL tail is clamped to it, not honoured', () => {
  // 600 would give a NON-live sport a 10-hour fast tail — longer than the 3.5h
  // this change removed, i.e. a knob that silently spends MORE than the
  // behaviour it replaced. `tier > fullTier` cannot report that either: a tail
  // wider than the full tail lowers nothing, so the demotion segment reads 0
  // while the spend goes up. Clamped at the full tail, where the bound lives.
  oddsApiMock.postTipMin = 300;
  setGames(slate('A', -250 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), IDLE,
    '250 min in is past the 210-min full tail, so an unclamped 300 would have kept STRIKE');
  setGames(slate('A', -200 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), STRIKE, 'and inside the clamp it behaves like the full tail');
  oddsApiMock.postTipMin = 600;
  setGames(slate('A', -3.6 * 60 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), IDLE, 'no setting can poll past the full tail');
});

test('a config with no postTipMin key at all falls back to 45 — the odds tests mock the whole object', () => {
  delete oddsApiMock.postTipMin;
  setGames(slate('A', -30 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), STRIKE);
  setGames(slate('A', -50 * MIN));
  assert.equal(mod.sportIntervalMin('A', 1), IDLE);
  oddsApiMock.postTipMin = 45;
});

// ── 6. the run reports it ───────────────────────────────────────
test('a real run names the demoted sports in the summary and in data', async () => {
  // The slate is pre-seeded the way a long-running process carries it between
  // runs: sportIntervalMin reads the store, not the response.
  setGames(slate('A', -50 * MIN, 8 * H));
  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?') ? [{ key: 'k_A', active: true }] : []),
  });
  const r = await mod.default.run();
  assert.deepEqual(r.data.postTipTail, ['A'], 'names, so "which league stopped being polled" is answerable');
  assert.match(r.summary, /· 1 sports post-tip tail \(MID\) ·/,
    'and in the summary segment, which is where an operator actually reads it');
  assert.deepEqual(r.data.postTipTailTier, { A: 'MID' },
    'the tier it landed at, so "how slow is it now" is not arithmetic the reader has to do');
});

test('the summary says HOW SLOW, governor included — the tier is the number that matters', async () => {
  // A demoted sport lands at MID or IDLE, which are the two tiers the pace
  // governor multiplies, so "3 sports post-tip tail" alone leaves the reader
  // to multiply four cadence knobs by a mult they cannot see. The label
  // carries both.
  setGames([...slate('A', -50 * MIN, 8 * H), ...slate('NCAAB', -50 * MIN)]);
  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?') ? [{ key: 'k_A', active: true }] : []),
  });
  const lowered = new Map();
  assert.equal(mod.sportIntervalMin('A', 4, lowered), MID * 4);
  assert.equal(mod.sportIntervalMin('NCAAB', 4, lowered), IDLE * 4);
  assert.deepEqual(Object.fromEntries(lowered), { A: 'MID×4', NCAAB: 'IDLE×4' },
    'tier AND governor multiplier, because that product is the real cadence');
  const un = new Map();
  assert.equal(mod.sportIntervalMin('A', 1, un), MID);
  assert.deepEqual(Object.fromEntries(un), { A: 'MID' }, 'and no ×1 noise when the governor is idle');
});

test('the segment is present with a zero too — a quiet run and a lowered one must not look alike', async () => {
  setGames(slate('A', 20 * MIN));
  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?') ? [{ key: 'k_A', active: true }] : []),
  });
  const r = await mod.default.run();
  assert.deepEqual(r.data.postTipTail, []);
  assert.deepEqual(r.data.postTipTailTier, {});
  assert.match(r.summary, /· 0 sports post-tip tail ·/, 'no parenthetical when nothing was lowered');
});
