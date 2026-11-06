// ══════════════════════════════════════════════════════════════
// The watchdog's schema probes exist for exactly one failure this repo keeps
// having: an agent ships with DDL nobody ran (D69/D70). `book_move_log` (#133,
// hand-run 2026-10-28) was not in the probe list, so the probe built to
// surface a missing table would not have surfaced THAT one. This pins that a
// missing `book_move_log` is reported — and, because the probe loop is
// generic, that it is reported by name.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

let watchdog, published, probed;
let missing = new Set();

before(async () => {
  published = []; probed = [];
  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: { rules: { unitDollars: 100 } },
  });
  // PostgREST's wording for a relation that is not there, so the real
  // `isMissingRelation` test in the watchdog is what classifies it.
  const isMissingRelation = (e) => /does not exist|could not find/i.test(e?.message || '');
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      isConnected: () => true,
      insert: async () => ({ count: 1 }),
      select: async (table, cols) => {
        probed.push(table);
        if (missing.has(table)) throw new Error(`select ${table}: relation "public.${table}" does not exist`);
        return [];
      },
      isMissingRelation,
    },
    namedExports: { isMissingRelation },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      notifyAll: async () => ({ total: 0 }),
      getClaudeUsage: async () => ({ projectedMonthly: 0 }),
    },
  });
  mock.module(import.meta.resolve('../src/agents/odds/index.js'), {
    namedExports: { getOddsBudget: () => ({ budget: 0 }) },
  });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: {
      getHealth: () => [], getGames: () => [], getDegraded: () => [],
      setWatchdog: (w) => published.push(w),
    },
  });
  watchdog = (await import('../src/agents/watchdog/index.js')).default;
});
after(() => mock.reset());

const schemaIssue = () => published[published.length - 1].issues.find((i) => i.type === 'schema');

test('a missing book_move_log is reported by the schema probe', async () => {
  missing = new Set(['book_move_log']);
  await watchdog.run();
  assert.ok(probed.includes('book_move_log'), 'the table must be in the probe list at all');
  const i = schemaIssue();
  assert.ok(i, 'a missing table is a schema issue');
  assert.match(i.detail, /book_move_log\.\w+/, 'named, so the human knows which DDL to run');
  assert.match(i.detail, /scripts\/schema\.sql/);
});

test('a present schema raises no schema issue', async () => {
  missing = new Set();
  await watchdog.run();
  assert.equal(schemaIssue(), undefined);
});
