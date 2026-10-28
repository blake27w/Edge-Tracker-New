// ══════════════════════════════════════════════════════════════
// hasOddsBudget's per-sport gate — the WIRING, not the formula.
//
// Its own file because it needs different config/db mocks than the formula
// tests, and node:test cannot re-mock a module inside one file. It also needs
// its own process: this drives the real odds agent far enough to publish its
// denominator, which is the only way the gate's ceiling becomes reachable.
//
// Why it exists: mutation-testing the formula tests showed they did NOT catch
// reverting this gate to the loose sportCap ceiling. They covered nominalCap
// and nothing that used it.
// ══════════════════════════════════════════════════════════════
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const ALLOC = { NFL: 0.32, NCAAF: 0.16, MLB: 0.14, NBA: 0.10, NCAAB: 0.06, NHL: 0.06,
  SOCCER: 0.03, UFC: 0.04, BOXING: 0.02, WNBA: 0.02, TENNIS: 0.03, GOLF: 0.02 };
const BUDGET = 20000;

// ── The wiring, not just the formula ────────────────────────────
// Mutation-testing the formula tests showed they did NOT catch reverting
// hasOddsBudget to the loose sportCap ceiling — they only covered nominalCap.
// This drives the real agent far enough to set its denominator, then asks
// hasOddsBudget about a sport parked BETWEEN the two ceilings. Tight ceiling
// -> refused; loose ceiling -> allowed. Nothing else discriminates them.
test('hasOddsBudget refuses a sport past the CORE ceiling, not the looser raw share', async (t) => {
  // sumAlloc 0.91 > POOL 0.85, so the core ceiling is the tighter of the two.
  // Below the crossover the inequality flips — see nominalCap's comment.
  const DENOM = ['NFL', 'NCAAF', 'MLB', 'NBA', 'NHL', 'UFC', 'NCAAB', 'SOCCER'];
  const sumAlloc = DENOM.reduce((a, s) => a + ALLOC[s], 0);
  const tight = Math.floor(BUDGET * 0.85 * (ALLOC.NFL / sumAlloc));   // core loop
  const loose = Math.floor(BUDGET * ALLOC.NFL);                        // the old gate
  assert.ok(tight < loose, 'fixture only means something if the two differ');
  const parked = tight + Math.floor((loose - tight) / 2);              // between them

  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: {
      oddsApi: { allocation: ALLOC, monthlyBudget: BUDGET, tier: 'starter', key: 'test-key',
        footballSports: ['NFL', 'NCAAF'], footballPriority: 'false', footballPriorityOn: () => false,
        base: 'https://api.the-odds-api.com/v4' },
      SPORTS: Object.fromEntries(DENOM.map((s) => [s, { key: `k_${s}`, markets: ['h2h'] }])),
      BOOKS: ['draftkings'], BOOK_LABELS: { draftkings: 'DK' },
      rules: { oddsReserve: 1000, unitDollars: 100 }, dryRun: true,
    },
  });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      isConnected: () => true,
      // Seed the month with NFL parked between the two ceilings.
      select: async (tbl) => (tbl === 'api_usage'
        ? [{ used: parked, by_sport: { NFL: parked } }] : []),
      upsert: async () => ({ count: 1 }), insert: async () => ({ count: 1 }),
    },
    namedExports: { isMissingRelation: () => false },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: { logger: { info() {}, warn() {}, error() {} }, notifyAll: async () => ({ total: 0 }) },
  });

  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => (String(url).includes('/sports?')
      ? DENOM.map((s) => ({ key: `k_${s}`, active: true }))
      : []),            // no games — we only need the denominator published
  });
  t.after(() => { global.fetch = realFetch; });

  const mod = await import('../src/agents/odds/index.js');
  await mod.default.run();                       // publishes the denominator

  assert.equal(mod.hasOddsBudget(0, 'NFL'), false,
    `NFL at ${parked} is past the core ceiling ${tight} and must be refused ` +
    `(the old gate allowed anything under ${loose})`);
  assert.equal(mod.hasOddsBudget(0, 'NCAAF'), true, 'a sport with room is still allowed');
  assert.equal(mod.hasOddsBudget(999999, 'NCAAF'), false, 'the global reserve still applies');
});


test('a response with no usage headers must not read as zero credits left', async (t) => {
  // The trap: Headers.get() returns null for an absent header and +null is 0,
  // which IS finite — so a missing x-requests-remaining was accepted as
  // "0 remaining". That stops every discretionary consumer and makes the core
  // loop report "budget exhausted" next run. No caller checks res.ok before
  // recording, so any 4xx/5xx or header-stripped response triggered it.
  const mod = await import('../src/agents/odds/index.js');
  const before = mod.getOddsBudget();
  assert.ok(before.remaining > 0, 'fixture starts with credits left');

  // A response shaped exactly like a non-200 from the provider: real headers
  // object, no usage headers on it.
  mod.recordOddsSpend('NCAAF', { headers: { get: () => null } });

  const after = mod.getOddsBudget();
  assert.ok(after.remaining > 0,
    `remaining must stay derived from the budget, got ${after.remaining}`);
  assert.equal(after.remaining, Math.max(0, 20000 - after.used),
    'with no header it falls back to budget - used');
});
