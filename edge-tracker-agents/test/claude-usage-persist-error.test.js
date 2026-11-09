// ══════════════════════════════════════════════════════════════
// D112: recordClaudeUsage (src/utils/index.js) must not fail silently.
//
// The api_usage.used/budget integer→numeric fix (schema.sql) stops the
// upsert from failing going forward, but a stale production DB, a future
// regression, or any other upsert failure must still be visible: once at
// error level (Claude is called often — a broken column must not spam the
// log forever) and on /budget.claude, so the dashboard can say the cost is
// not durable instead of trusting a number that only lives in process memory.
//
// Covers: the log fires exactly once across repeated failures (sticky, not
// per-call); getClaudeUsage() reports persisted:false + persist_error while
// broken; a later successful upsert clears persisted back to true and drops
// persist_error, but does NOT re-arm the one-time log guard.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'sk-test-key';

let upsertShouldFail = true;
const upserts = [];
const errorLogs = [];

before(async () => {
  mock.module('@anthropic-ai/sdk', {
    defaultExport: class FakeAnthropic {
      constructor() {}
      get messages() {
        return {
          create: async () => ({
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 15000, output_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          }),
        };
      }
    },
  });
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      async select() { return []; },
      async upsert(table, row) {
        upserts.push({ table, row });
        if (upsertShouldFail) throw new Error('invalid input syntax for type integer: "1.5845"');
        return { data: [row], count: 1 };
      },
      async insert() { return { data: [], count: 0 }; },
    },
  });
});
after(() => mock.reset());

test('a failed api_usage upsert logs at error level exactly once, not once per call', async () => {
  const configMod = await import('../src/config/index.js');
  configMod.default.anthropic.model = 'claude-haiku-4-5';
  const { claude, logger } = await import('../src/utils/index.js');
  const origError = logger.error;
  logger.error = (...args) => { errorLogs.push(args); return origError.apply(logger, args); };

  upsertShouldFail = true;
  await claude('hello');
  await claude('hello again');
  await claude('and again');

  assert.equal(upserts.filter((u) => u.table === 'api_usage').length, 3, 'all three calls must attempt the upsert');
  assert.equal(errorLogs.length, 1, 'three straight failures must log at error level exactly once, not three times');
  assert.match(String(errorLogs[0][1]), /api_usage upsert failed/, 'the one log must name the failure');
});

test('/budget.claude reports persisted:false and persist_error while the upsert is failing', async () => {
  const { getClaudeUsage } = await import('../src/utils/index.js');
  const u = await getClaudeUsage();
  assert.equal(u.persisted, false, 'a failing upsert must be visible on /budget.claude');
  assert.match(u.persist_error, /invalid input syntax for type integer/, 'persist_error must carry the DB message');
});

test('a later successful upsert clears persisted/persist_error but does not re-arm the log', async () => {
  const { claude, getClaudeUsage, logger } = await import('../src/utils/index.js');

  upsertShouldFail = false;
  await claude('this one should land');
  let u = await getClaudeUsage();
  assert.equal(u.persisted, true, 'a successful upsert must clear the stale failure');
  assert.equal(u.persist_error, undefined, 'persist_error must not be reported once persisted');

  // Fail again — the log guard is sticky for the life of the process, so this
  // must NOT produce a second error log entry.
  upsertShouldFail = true;
  const before_ = errorLogs.length;
  await claude('broken again');
  assert.equal(errorLogs.length, before_, 'the once-per-process guard must stay tripped even after an intervening success');

  u = await getClaudeUsage();
  assert.equal(u.persisted, false, 'the renewed failure must still surface on /budget.claude');
  assert.match(u.persist_error, /invalid input syntax for type integer/);
});
