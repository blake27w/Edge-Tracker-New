// ══════════════════════════════════════════════════════════════
// api_usage.used must hold an integer. Live symptom (2026-11-08 02:13Z):
//   upsert api_usage failing — invalid input syntax for type integer: "1.5845"
//
// 1.5845 is not a ratio/paceRatio/sumAlloc/perDay from the odds budget — those
// are all Math.round()-ed to whole credits before they ever reach budget.used
// (src/agents/odds/index.js:646, recordSpend). It is a Claude dollar COST:
// recordClaudeUsage (src/utils/index.js) rounds to 4 decimal places
// (Math.round(costOf(...) * 10000) / 10000) and writes it straight into
// api_usage.used for the `provider: 'claude'` row — a column declared
// `integer` (scripts/schema.sql:29). Any nonzero token spend produces a
// fractional dollar cost, so this upsert has essentially never succeeded.
//
// This is a THIRD api_usage row shape, distinct from the month row
// (`provider: 'odds'`, used = whole credits) and the season sentinel
// (`provider: 'odds-season'`, used: 0 — a fixed literal). Both of those are
// written by persistBudget() in src/agents/odds/index.js, in their own
// try/catch, on a completely different call path from recordClaudeUsage —
// so this failure does NOT touch the odds credit counter persistBudget
// writes. It only means Claude's own dollar-cost tracking has no durable
// record: claudeUsage lives in a module-local variable, so a restart resets
// /budget.claude.cost, perDay and projectedMonthly to 0, silently.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readSchema, declaredColumns, assertDeclared, integerColumns, integerViolations } from './helpers/schema-ddl.js';

process.env.ANTHROPIC_API_KEY = 'sk-test-key';

const upserts = [];

before(async () => {
  mock.module('@anthropic-ai/sdk', {
    defaultExport: class FakeAnthropic {
      constructor() {}
      get messages() {
        return {
          create: async () => ({
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            // A realistic token bill: enough input/output to price out to a
            // fractional dollar amount under the haiku-4-5 pricing table.
            usage: { input_tokens: 15000, output_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          }),
        };
      }
    },
  });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      async select() { return []; },
      async upsert(table, rows) {
        const arr = Array.isArray(rows) ? rows : [rows];
        upserts.push({ table, rows: arr });
        return { data: arr, count: arr.length };
      },
      async insert() { return { data: [], count: 0 }; },
    },
  });
});
after(() => mock.reset());

test('a Claude call writes api_usage.used as a fractional dollar cost', async () => {
  const configMod = await import('../src/config/index.js');
  configMod.default.anthropic.model = 'claude-haiku-4-5'; // normally set by detectModel() at boot
  const { claude } = await import('../src/utils/index.js');
  await claude('hello');

  const claudeUpserts = upserts.filter((c) => c.table === 'api_usage');
  assert.equal(claudeUpserts.length, 1, 'recordClaudeUsage must upsert exactly one api_usage row per call');
  const row = claudeUpserts[0].rows[0];
  assert.equal(row.provider, 'claude');
  assert.ok(!Number.isInteger(row.used), `expected a fractional cost, got ${row.used} — tighten the mock usage numbers`);

  const cols = declaredColumns(readSchema(), 'api_usage');
  assertDeclared(cols, 'api_usage', ['used', 'budget']);
  // D112: used/budget are now `numeric`, not `integer` — so api_usage
  // legitimately has zero integer columns (same shape as D104's
  // pred_market_edges; see the vacuity note in helpers/schema-ddl.js).
  // ints.length > 0 is therefore not the guard; assertDeclared() above is —
  // it pins the parse so a reformatted block or a reverted column type fails
  // loudly instead of this test passing on an accidentally-empty `cols`.
  assert.ok(/^numeric\b/.test(cols.used), `used must be numeric — a Claude dollar cost is never a whole credit, got ${cols.used}`);
  assert.ok(/^numeric\b/.test(cols.budget), `budget must be numeric for the same reason, even though the claude row writes it null, got ${cols.budget}`);
  const ints = integerColumns(cols);
  const bad = integerViolations(cols, ints, row);
  assert.deepEqual(bad, [],
    `Postgres rejects the whole upsert for these: ${bad.join('; ')} — a Claude dollar cost is never a whole credit, so the column must be numeric`);
});
