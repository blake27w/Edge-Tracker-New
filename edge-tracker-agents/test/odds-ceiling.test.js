// ══════════════════════════════════════════════════════════════
// The per-sport ceiling formula — one definition, both callers.
//
// The core loop and hasOddsBudget() used to bound a sport at different
// numbers while billing the same `bySport` counter, so discretionary spend
// (props, tennis, derivatives) could carry a sport past the ceiling the core
// loop had already stopped at. These pin them together.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ALLOC = { NFL: 0.32, NCAAF: 0.16, MLB: 0.14, NBA: 0.10, NCAAB: 0.06, NHL: 0.06,
  SOCCER: 0.03, UFC: 0.04, BOXING: 0.02, WNBA: 0.02, TENNIS: 0.03, GOLF: 0.02 };
const BUDGET = 20000;

let nominalCap;

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
  ({ nominalCap } = await import('../src/agents/odds/index.js'));
});
after(() => mock.reset());

test('the allocation table sums to 1.0 — the premise the normalisation relies on', () => {
  assert.equal(Math.round(Object.values(ALLOC).reduce((a, b) => a + b, 0) * 100) / 100, 1);
});

test('ceilings sum to the pool, never the whole budget', () => {
  // The bug this replaces: summed over every sport, the discretionary ceiling
  // (budget x share) came to 20000 — the entire month — so the pool bound
  // constrained the core loop alone.
  const all = Object.keys(ALLOC);
  const sum = all.reduce((t, s) => t + nominalCap(s, all), 0);
  assert.ok(sum <= BUDGET * 0.85, `sum ${sum} must stay inside the 85% pool`);
  assert.ok(sum > BUDGET * 0.84, `sum ${sum} should use nearly all of it`);
  assert.ok(sum < BUDGET, 'and must never reach the whole budget');
});

test('a sport never gets the raw unnormalised share, which was 17.7% looser', () => {
  const all = Object.keys(ALLOC);
  const raw = Math.floor(BUDGET * ALLOC.NFL);          // the old sportCap
  const cap = nominalCap('NFL', all);
  assert.ok(cap < raw, `${cap} must be tighter than the old ${raw}`);
  assert.ok(Math.abs(100 * (raw - cap) / cap - 17.7) < 0.2, 'the old ceiling was ~17.7% looser');
  // 5439, not 5440: 20000 * 0.85 * 0.32 lands at 5439.999... and Math.floor
  // takes it down. Conservative by a credit — not worth "fixing".
  assert.equal(cap, 5439);
});

test('a smaller denominator concentrates the pool, not expands it', () => {
  // Fewer sports in season → each gets more, but the total is still the pool.
  const few = ['NFL', 'NCAAF', 'MLB'];
  assert.ok(nominalCap('NFL', few) > nominalCap('NFL', Object.keys(ALLOC)));
  const sum = few.reduce((t, s) => t + nominalCap(s, few), 0);
  assert.ok(sum <= BUDGET * 0.85, `sum ${sum} still inside the pool`);
});

test('NCAAB entering in November tightens football rather than adding budget', () => {
  // The case that would have widened the old gap: sumAlloc rises, core caps
  // fall, and the discretionary ceiling used to stay put.
  const before = ['NFL', 'NCAAF', 'MLB', 'NBA', 'NHL', 'UFC'];
  const after = [...before, 'NCAAB'];
  assert.ok(nominalCap('NFL', after) < nominalCap('NFL', before));
  assert.ok(after.reduce((t, s) => t + nominalCap(s, after), 0) <= BUDGET * 0.85);
});

test('an unlisted sport falls back to the default share, not to zero', () => {
  const d = ['NFL', 'CRICKET'];
  assert.ok(nominalCap('CRICKET', d) > 0, 'unknown sports get the 0.05 default');
});

test('the two old ceilings crossed over at sumAlloc = POOL, in both directions', () => {
  // Recording the actual shape of the bug: it was not "discretionary is always
  // looser". Above the crossover the core ceiling binds tighter; below it the
  // raw share does. Either way the two consumers of one counter disagreed.
  const raw = (s) => Math.floor(BUDGET * ALLOC[s]);
  const wide = Object.keys(ALLOC);                                  // sumAlloc 1.00
  const narrow = ['NFL', 'NCAAF', 'MLB', 'NBA', 'NHL', 'UFC'];      // sumAlloc 0.82
  assert.ok(nominalCap('NFL', wide) < raw('NFL'), 'above POOL: core is tighter');
  assert.ok(nominalCap('NFL', narrow) > raw('NFL'), 'below POOL: core is looser');
});

// ── The no-denominator branch ───────────────────────────────────
// Nothing in this file calls run(), so the core loop has published no
// denominator — the state every discretionary consumer is in on the first call
// after a restart.
test('with no published denominator, the ceiling is the tightest reading, not the loosest', async () => {
  const { currentCeiling, nominalCap } = await import('../src/agents/odds/index.js');

  // The two traps, quantified:
  //   sportCap(TENNIS)               = 600    unnormalised share
  //   nominalCap(TENNIS, ['TENNIS'])  = 17000  sumAlloc is its own share
  const raw = Math.floor(BUDGET * ALLOC.TENNIS);
  const degenerate = nominalCap('TENNIS', ['TENNIS']);
  assert.equal(degenerate, 17000, 'the single-element denominator really is the whole pool');

  const c = currentCeiling('TENNIS');
  assert.equal(c, nominalCap('TENNIS', Object.keys(ALLOC)), 'falls back to the full table');
  assert.ok(c < raw, `${c} tighter than the raw share ${raw}`);
  assert.ok(c < degenerate / 30, 'and nowhere near the degenerate case');
});
