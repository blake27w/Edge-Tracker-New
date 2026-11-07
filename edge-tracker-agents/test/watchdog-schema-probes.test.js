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

let watchdog, published, probed, probedPairs;
let missing = new Set();
// `table.column` pairs where the TABLE is there but the column is not — the
// 2026-11-07 shape: two `alter table` lines nobody ran in Supabase (D103).
let missingCols = new Set();

before(async () => {
  published = []; probed = []; probedPairs = [];
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
        probedPairs.push(`${table}.${cols}`);
        if (missing.has(table)) throw new Error(`select ${table}: relation "public.${table}" does not exist`);
        // PostgREST's own 42703 wording. The table resolves; the column does
        // not, which is what a skipped `alter table` looks like from a reader.
        if (missingCols.has(`${table}.${cols}`)) {
          throw new Error(`select ${table}: column ${table}.${cols} does not exist`);
        }
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

const schemaIssues = () => published[published.length - 1].issues.filter((i) => i.type === 'schema');
const schemaIssue = () => schemaIssues()[0];
const columnIssue = () => schemaIssues().find((i) => i.key === 'schema|column');

test('a missing book_move_log is reported by the schema probe', async () => {
  missing = new Set(['book_move_log']); missingCols = new Set();
  await watchdog.run();
  assert.ok(probed.includes('book_move_log'), 'the table must be in the probe list at all');
  const i = schemaIssue();
  assert.ok(i, 'a missing table is a schema issue');
  assert.match(i.detail, /book_move_log\.\w+/, 'named, so the human knows which DDL to run');
  assert.match(i.detail, /scripts\/schema\.sql/);
});

test('a present schema raises no schema issue', async () => {
  missing = new Set(); missingCols = new Set();
  await watchdog.run();
  assert.equal(schemaIssue(), undefined);
});

// ── the 2026-11-07 failure, which the pre-D103 probe list could not see ──
// `line_movements` exists and has existed for months; `gap_min` (#136, two
// hand-run `alter table` lines) never landed in Supabase. The odds agent's
// strip-and-retry (D73) kept writing rows without it, so the first tell was a
// reader selecting the column — 229 steam runs later.
test('a present table with a missing hand-run column is reported by name', async () => {
  missing = new Set();
  missingCols = new Set(['line_movements.gap_min']);
  await watchdog.run();
  assert.ok(probedPairs.includes('line_movements.gap_min'),
    'the column must be in the probe list at all — this is the bit that was absent');
  const i = columnIssue();
  assert.ok(i, 'a missing hand-run column is a schema issue');
  assert.match(i.detail, /line_movements\.gap_min/, 'named table.column, so the human knows which line to paste');
  assert.match(i.detail, /run the matching alter table in scripts\/schema\.sql/);
});

// A missing table and a missing column are different repairs, so they are
// different issues on different dedup keys — one must not hide the other for
// the rest of the day.
test('a missing table and a missing column are separate issues with distinct wording', async () => {
  missing = new Set(['book_move_log']);
  missingCols = new Set(['line_movements.gap_min', 'public_splits.pileon']);
  await watchdog.run();
  const [table, column] = [schemaIssues().find((i) => i.key === 'schema'), columnIssue()];
  assert.ok(table && column, 'both channels fire');
  assert.notEqual(table.key, column.key, 'distinct dedup keys');
  assert.match(table.detail, /run scripts\/schema\.sql in Supabase/);
  assert.doesNotMatch(table.detail, /line_movements\.gap_min/, 'a skipped alter table is not a missing table');
  assert.match(column.detail, /missing hand-run columns: /, 'plural when there are two');
  assert.match(column.detail, /public_splits\.pileon/);
});
