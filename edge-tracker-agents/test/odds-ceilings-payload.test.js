// ══════════════════════════════════════════════════════════════
// getOddsCeilings() — the /budget payload the Signal dashboard reads.
//
// getOddsBudget() publishes what each sport has SPENT; nothing published what
// it is ALLOWED to spend, so "3 budget-skips" in the odds run summary had no
// reachable explanation. This pins the payload's two load-bearing properties:
//
//   1. one ceiling per allocation sport, every one a finite non-negative
//      integer — a `null` or a float here renders as `undefined`/`—` in the
//      panel's "% of ceiling" column and the number quietly stops meaning
//      anything;
//   2. the ceilings are priced against the POOL fraction, not the raw
//      allocation share. D61's crossover is the live hazard: `sportCap()` is
//      `budget × share`, which over the full (sum = 1.0) table hands out the
//      ENTIRE month with no pool fraction and no reserve.
//
// On (2), note which bound actually discriminates. The spec asked for
// "sum ≤ monthlyBudget", but with sumAlloc = 1.0 `sportCap` sums to exactly
// monthlyBudget and so passes that bound — it is true of the bug too. The
// assertion that bites is sum ≤ monthlyBudget × POOL (17000 vs 20000), so
// both are asserted and the mutation note names the tighter one.
//
// Mutation-verified per D21: replacing `currentCeiling(s)` with `sportCap(s)`
// in getOddsCeilings fails 'the ceiling table respects the POOL fraction'.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ALLOC = { NFL: 0.32, NCAAF: 0.16, MLB: 0.14, NBA: 0.10, NCAAB: 0.06, NHL: 0.06,
  SOCCER: 0.03, UFC: 0.04, BOXING: 0.02, WNBA: 0.02, TENNIS: 0.03, GOLF: 0.02 };
const BUDGET = 20000;
const POOL = 0.85;   // mirrors agents/odds/index.js; asserted against the payload below

let getOddsCeilings;

before(async () => {
  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: { allocation: ALLOC, monthlyBudget: BUDGET, tier: 'starter', key: '',
        seasonGraceDays: 14,
        footballSports: ['NFL', 'NCAAF'], footballPriority: 'auto', footballPriorityOn: () => true,
        base: 'https://api.the-odds-api.com/v4' },
      SPORTS: Object.fromEntries(Object.keys(ALLOC).map((s) => [s, { key: s.toLowerCase() }])),
      BOOKS: [], BOOK_LABELS: {}, rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: true,
    },
  });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: { isConnected: () => false, select: async () => [], upsert: async () => ({}), insert: async () => ({}) },
    namedExports: { isMissingRelation: () => false },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: { info() {}, warn() {}, error() {} }, notifyAll: async () => ({ total: 0 }) },
  });
  ({ getOddsCeilings } = await import('../src/agents/odds/index.js'));
});
after(() => mock.reset());

test('there is one ceiling per allocation sport, and no extras', () => {
  const p = getOddsCeilings();
  assert.deepEqual(Object.keys(p.ceilings).sort(), Object.keys(ALLOC).sort());
  assert.deepEqual(p.allocation, ALLOC);
});

test('the allocation table is a copy, so a client cannot mutate config through it', () => {
  const p = getOddsCeilings();
  p.allocation.NFL = 999;
  assert.equal(getOddsCeilings().allocation.NFL, 0.32);
});

test('every ceiling is a finite non-negative integer', () => {
  const { ceilings } = getOddsCeilings();
  for (const [sport, c] of Object.entries(ceilings)) {
    assert.equal(Number.isInteger(c), true, `${sport} ceiling is not an integer: ${c}`);
    assert.equal(c >= 0, true, `${sport} ceiling is negative: ${c}`);
  }
});

// `denom: null` is a distinct claim from "every sport" (D65) and the dashboard
// renders it as such. Nothing has run in this process, so it must be null here
// — not an empty array, and not the allocation key list.
test('denom is null before anything publishes a denominator', () => {
  assert.equal(getOddsCeilings().denom, null);
});

test('the payload reports the pool fraction it priced against', () => {
  assert.equal(getOddsCeilings().pool, POOL);
});

// The spec's bound. True, but — with sumAlloc = 1.0 — equally true of the
// sportCap() formula this is meant to exclude, so it cannot stand alone.
test('the ceiling table never exceeds the monthly budget', () => {
  const total = Object.values(getOddsCeilings().ceilings).reduce((a, b) => a + b, 0);
  assert.equal(total <= BUDGET, true, `ceilings sum to ${total}, over budget ${BUDGET}`);
});

// The bound that discriminates. sportCap() sums to 20000 here and fails this.
test('the ceiling table respects the POOL fraction', () => {
  const total = Object.values(getOddsCeilings().ceilings).reduce((a, b) => a + b, 0);
  const bound = Math.floor(BUDGET * POOL);
  assert.equal(total <= bound, true,
    `ceilings sum to ${total}, over the pool bound ${bound} — the 15% month-end margin is being handed out`);
  // And not vacuously small: the pool should be substantially allocated, or a
  // formula that returned 0 for everything would also "respect" the bound.
  assert.equal(total > bound * 0.9, true, `ceilings sum to only ${total} of a ${bound} pool`);
});

// Normalisation, stated as a ratio so it holds whatever the budget is: NFL's
// 0.32 share must be 16x BOXING's 0.02, not merely larger.
test('ceilings are proportional to allocation share', () => {
  const { ceilings } = getOddsCeilings();
  assert.equal(Math.round(ceilings.NFL / ceilings.BOXING), 16);
  assert.equal(Math.round(ceilings.NCAAF / ceilings.NFL * 100) / 100, 0.5);
});

// ── The season block: who is in the denominator, and WHY ────────
// The denominator was previously unknowable from /budget — only its membership
// was published, and only once a run had published one — so November's budget
// analysis had to be MODELLED rather than read (D86/D88). These three fields are
// what make the decision legible, including before the first run.
const REASON_OK = (r) => r === 'active-now' || r === 'football-backstop' || r === 'feed-unreadable'
  || r === 'billed (event-only sport)' || r === 'skip (ODDS_SKIP_SPORTS)'
  || /^grace \(\d+d ago\)$/.test(r) || /^seeding \(\d+d left\)$/.test(r)
  || /^released \(\d+d idle\)$/.test(r);

test('there is one season entry per allocation sport', () => {
  const { season } = getOddsCeilings();
  assert.deepEqual(Object.keys(season).sort(), Object.keys(ALLOC).sort());
});

test('every sport carries a membership and a reason, in as well as out', () => {
  const { season } = getOddsCeilings();
  for (const [sport, v] of Object.entries(season)) {
    assert.equal(typeof v.in, 'boolean', `${sport} publishes no membership`);
    assert.equal(REASON_OK(v.reason), true, `${sport}: ${v.reason} is not in the closed set`);
  }
});

// Before any run, there is no feed reading to report — and the fail-safe
// direction is to hold everything in, which is the same claim the ceilings above
// are priced against (the full table). An un-run process reporting sports as
// RELEASED would be the dangerous direction: it would read as a denominator
// nothing has measured.
test('nothing is released before a run has read the feed', () => {
  const { season } = getOddsCeilings();
  for (const [sport, v] of Object.entries(season)) {
    if (sport === 'TENNIS' || sport === 'GOLF') continue;   // oddsSkip: in only via spend
    assert.equal(v.in, true, `${sport} must not be released before anything has been measured`);
    assert.equal(v.reason, 'feed-unreadable');
  }
});

test('sumAlloc is the sum over the set the ceilings were priced against', () => {
  // With no published denominator that set is the full table — currentCeiling's
  // own fallback, and the tightest reading available (D65). Published so a
  // reader can check the ceiling arithmetic instead of reconstructing it.
  const p = getOddsCeilings();
  const priced = (p.denom && p.denom.length) ? p.denom : Object.keys(ALLOC);
  const want = Math.round(priced.reduce((t, s) => t + ALLOC[s], 0) * 1000) / 1000;
  assert.equal(p.sumAlloc, want);
  assert.equal(p.sumAlloc, 1, 'the full table sums to 1.0 — the denominator is what makes it smaller');
});

test('graceDays is published as an integer', () => {
  // A float or a string here is how a "14-day grace" quietly becomes something
  // else; the knob is read through intEnv so 0 survives as 0.
  const { graceDays } = getOddsCeilings();
  assert.equal(Number.isInteger(graceDays), true, `graceDays is ${graceDays}`);
  assert.equal(graceDays >= 0, true);
});
