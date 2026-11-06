// ══════════════════════════════════════════════════════════════
// The db.insert contract the chunked snapshot write depends on.
//
//  1. The thrown error carries `.code`. `insert` used to rethrow
//     `insert <table>: <msg>` and drop it, so the only way to tell a statement
//     timeout (57014 — retry the chunk) from anything else was a regex over
//     the message — the same message-sniffing D73 had to resort to. `count`
//     already preserved it; `insert` now does too, message shape unchanged.
//
//  2. `returning: 'minimal'` must NOT call `.select()`. In supabase-js 2.108
//     `.select()` is the only thing that adds `Prefer: return=representation`
//     to an insert, so omitting it is what stops the server aggregating every
//     inserted row inside the same timed statement. The default keeps the
//     select: research, book-edge and the orchestrator read `data[0]`.
// ══════════════════════════════════════════════════════════════
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// A fake supabase client whose insert builder records whether `.select()` was
// chained, and resolves to `result` either way.
function fakeClient(result, log) {
  return {
    from: (table) => ({
      insert: (rows) => {
        const call = { table, rows, selected: false };
        log.push(call);
        const builder = {
          select: () => { call.selected = true; return Promise.resolve(result); },
          then: (res, rej) => Promise.resolve(result).then(res, rej),
        };
        return builder;
      },
    }),
  };
}

async function loadDb(result, log, tag) {
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: { reportDegraded: () => {} },
  });
  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: { supabase: { url: 'https://x.supabase.co', key: 'k' }, dryRun: false },
  });
  mock.module('@supabase/supabase-js', {
    namedExports: { createClient: () => fakeClient(result, log) },
  });
  return (await import(`../src/db/index.js?${tag}=${Date.now()}`)).default;
}

test('db.insert preserves .code on the rethrown error (57014 survives)', async () => {
  const log = [];
  const timeout = { code: '57014', message: 'canceling statement due to statement timeout' };
  const db = await loadDb({ data: null, error: timeout }, log, 'code');

  let caught = null;
  try { await db.insert('line_snapshots', [{ a: 1 }]); } catch (e) { caught = e; }
  assert.ok(caught, 'the insert must still throw');
  assert.equal(caught.code, '57014', 'the SQLSTATE must survive the rethrow so a caller can retry honestly');
  assert.equal(caught.missing, false, 'a timeout is not a missing relation');
  assert.equal(caught.message, 'insert line_snapshots: canceling statement due to statement timeout',
    'the message shape existing callers match on is unchanged');
  mock.reset();
});

test('db.insert with returning: minimal does not request the rows back', async () => {
  const log = [];
  const db = await loadDb({ data: null, error: null }, log, 'minimal');

  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const res = await db.insert('line_snapshots', rows, { returning: 'minimal' });
  assert.equal(log.length, 1);
  assert.equal(log[0].selected, false, '.select() must not be chained — that is what adds return=representation');
  assert.equal(res.count, rows.length, 'count is the rows sent: a batch insert is one all-or-nothing statement');
  assert.equal(res.data, null, 'and there is no representation to hand back');
  mock.reset();
});

test('db.insert default still returns the representation (callers read data[0])', async () => {
  const log = [];
  const returned = [{ id: 'r1', a: 1 }];
  const db = await loadDb({ data: returned, error: null }, log, 'default');

  const res = await db.insert('scan_runs', { a: 1 });
  assert.equal(log[0].selected, true, 'the default chains .select() so research/book-edge/orchestrator keep their ids');
  assert.deepEqual(res.data, returned);
  assert.equal(res.count, 1);
  mock.reset();
});
