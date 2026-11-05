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
