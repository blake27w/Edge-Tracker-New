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
// table -> a non-relation error message, i.e. the transient that must NOT read
// as a schema verdict.
let thrown = new Map();

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
        if (thrown.has(table)) throw new Error(thrown.get(table));
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

// `probed`/`probedPairs` are per-run: the suppression tests have to see what
// THIS run asked the database, not what an earlier test left behind.
const runProbes = async () => { probed.length = 0; probedPairs.length = 0; await watchdog.run(); };

const schemaIssues = () => published[published.length - 1].issues.filter((i) => i.type === 'schema');
const schemaIssue = () => schemaIssues()[0];
const columnIssue = () => schemaIssues().find((i) => i.key === 'schema|column');

test('a missing book_move_log is reported by the schema probe', async () => {
  missing = new Set(['book_move_log']); missingCols = new Set();
  await runProbes();
  assert.ok(probed.includes('book_move_log'), 'the table must be in the probe list at all');
  const i = schemaIssue();
  assert.ok(i, 'a missing table is a schema issue');
  assert.match(i.detail, /book_move_log\.\w+/, 'named, so the human knows which DDL to run');
  assert.match(i.detail, /create table block individually/);
});

test('a present schema raises no schema issue', async () => {
  missing = new Set(); missingCols = new Set();
  await runProbes();
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
  await runProbes();
  assert.ok(probedPairs.includes('line_movements.gap_min'),
    'the column must be in the probe list at all — this is the bit that was absent');
  const i = columnIssue();
  assert.ok(i, 'a missing hand-run column is a schema issue');
  assert.match(i.detail, /line_movements\.gap_min/, 'named table.column, so the human knows which line to paste');
  assert.match(i.detail, /alter table line individually/);
});

// A missing table and a missing column are different repairs, so they are
// different issues on different dedup keys — one must not hide the other for
// the rest of the day.
test('a missing table and a missing column are separate issues with distinct wording', async () => {
  missing = new Set(['book_move_log']);
  missingCols = new Set(['line_movements.gap_min', 'public_splits.pileon']);
  await runProbes();
  const [table, column] = [schemaIssues().find((i) => i.key === 'schema'), columnIssue()];
  assert.ok(table && column, 'both channels fire');
  assert.notEqual(table.key, column.key, 'distinct dedup keys');
  assert.match(table.detail, /create table block individually/);
  assert.doesNotMatch(table.detail, /line_movements\.gap_min/, 'a skipped alter table is not a missing table');
  assert.match(column.detail, /missing hand-run columns: /, 'plural when there are two');
  assert.match(column.detail, /public_splits\.pileon/);
});

// ── the repair text has to be runnable ──
// Pasting the whole of scripts/schema.sql into the Supabase SQL editor cannot
// work: the editor runs a paste as ONE transaction and the file carries a
// placeholder timestamp that deliberately does not cast (schema.sql:728), so
// the paste aborts there and rolls back every statement with it. The old text
// told a human to do exactly that.
test('neither repair sentence says to run the whole schema file', async () => {
  missing = new Set(['book_move_log']);
  missingCols = new Set(['line_movements.gap_min']);
  await runProbes();
  for (const i of schemaIssues()) {
    assert.doesNotMatch(i.detail, /run scripts\/schema\.sql/,
      'that paste aborts on the uncastable placeholder and rolls back everything');
  }
});

// ── one missing table is one issue ──
// `clv_records` carries five hand-run column probes as well as its table probe.
// When the table is gone all six probes fail with the same 42P01, and five of
// them would print "run the alter table" — the wrong repair, five times over,
// for a table that needs a `create table`.
test('a missing table suppresses its own column issues', async () => {
  missing = new Set(['clv_records']); missingCols = new Set();
  await runProbes();
  const forTable = schemaIssues().filter((i) => /clv_records/.test(i.detail));
  assert.equal(forTable.length, 1, `one issue for one missing table, got ${forTable.length}`);
  assert.equal(forTable[0].key, 'schema', 'and it is the table one, carrying the create-table repair');
  assert.match(forTable[0].detail, /create table block individually/);
  assert.equal(schemaIssues().filter((i) => i.key === 'schema|column').length, 0,
    'no schema|column line for a table that is not there');
  // The suppression is also a cost saving: the columns are not probed at all.
  assert.ok(!probedPairs.includes('clv_records.entry_at'),
    'probing a column on a table known to be absent asks a question already answered');
});

// The same shape on the two tables the reviewer caught double-firing:
// `ev_opportunities` has a table probe AND three column probes, so an absent
// table published four lines.
test('a missing ev_opportunities is exactly one issue', async () => {
  missing = new Set(['ev_opportunities']); missingCols = new Set();
  await runProbes();
  const forTable = schemaIssues().filter((i) => /ev_opportunities/.test(i.detail));
  assert.equal(forTable.length, 1, `got ${forTable.length}: ${forTable.map((i) => i.detail).join(' | ')}`);
  assert.equal(forTable[0].key, 'schema');
});

// Rule 1: a table that lost its table probe reports a dropped table as N
// missing columns and never prints the create-table repair. These three lost
// theirs when their old table probe was retagged `'column'`.
test('every table carrying column probes also has a table probe', async () => {
  for (const t of ['monitor_scores', 'clv_records', 'line_snapshots', 'ev_opportunities', 'opp_results',
    'subscribers', 'game_weather', 'nfl_line_moves', 'public_splits', 'line_movements',
    'research_notes', 'nfl_closing_lines', 'ncaaf_closing_lines']) {
    missing = new Set([t]); missingCols = new Set();
    await runProbes();
    const i = schemaIssues().find((x) => x.key === 'schema');
    assert.ok(i && new RegExp(t).test(i.detail),
      `${t} must have a table probe of its own, or a dropped table reads as N missing columns`);
    assert.equal(schemaIssues().length, 1, `${t}: one missing table is one issue`);
  }
});

// migrate-research.sql was outside every guard until 2026-11-07, and
// `research_notes.signals` is the blind-forever shape: backtest/index.js:254
// selects it inside `catch (_) { report.research = finalize(blank()) }`, so an
// unapplied column publishes an empty research scorecard indefinitely.
test('the migrate-research columns are probed and reported', async () => {
  missing = new Set();
  missingCols = new Set(['research_notes.signals', 'nfl_closing_lines.over_odds']);
  await runProbes();
  assert.ok(probedPairs.includes('research_notes.signals'));
  assert.ok(probedPairs.includes('ncaaf_closing_lines.away_spread_odds'));
  const i = columnIssue();
  assert.ok(i, 'a column declared only in migrate-research.sql is still a schema issue');
  assert.match(i.detail, /research_notes\.signals/);
  assert.match(i.detail, /nfl_closing_lines\.over_odds/);
});

// A statement timeout is not a verdict on the schema. Reporting DDL as
// unapplied on the strength of a transient is the false alarm that teaches a
// human to ignore this channel.
test('a non-relation error is not reported as missing DDL', async () => {
  missing = new Set(); missingCols = new Set();
  thrown = new Map([['line_snapshots', 'canceling statement due to statement timeout']]);
  await runProbes();
  thrown = new Map();
  assert.equal(schemaIssues().length, 0, 'a timeout is silence, not a schema issue');
});
