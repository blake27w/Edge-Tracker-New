// ══════════════════════════════════════════════════════════════
// The degradation channel and the db-layer write reporting.
//
// This is the machinery the other four fixes report through, and the answer to
// the question all five faults raised: an agent only looks unhealthy to the
// orchestrator if it THROWS, so "succeeded while producing nothing usable" had
// no way to be expressed at all.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Channel semantics ───────────────────────────────────────────
test('degradation channel: dedupes by key, counts repeats, keeps first-seen', async () => {
  const store = await import('../src/store/index.js');
  store.clearDegraded('t|a'); store.clearDegraded('t|b');

  store.reportDegraded('t|a', 'first');
  const firstSeen = store.getDegraded().find((d) => d.key === 't|a').since;

  await new Promise((r) => setTimeout(r, 5));
  store.reportDegraded('t|a', 'second');
  store.reportDegraded('t|b', 'other');

  const all = store.getDegraded();
  const a = all.find((d) => d.key === 't|a');
  assert.equal(a.detail, 'second', 'latest detail wins');
  assert.equal(a.count, 2, 'but the repeat count is kept, so "how long" is visible');
  assert.equal(a.since, firstSeen, 'first-seen is preserved across repeats');
  assert.notEqual(a.at, firstSeen, 'while `at` tracks the most recent sighting');
  assert.ok(all.some((d) => d.key === 't|b'), 'separate keys stay separate issues');

  store.clearDegraded('t|a'); store.clearDegraded('t|b');
  assert.equal(store.getDegraded().filter((d) => ['t|a', 't|b'].includes(d.key)).length, 0);
});

test('degradation channel: entries self-expire, so a fix clears the alert', async () => {
  // Nothing has to remember to clear these — an agent that stops reporting a
  // problem stops having the issue, and it ages out on its own.
  process.env.DEGRADED_TTL_MS = '50';
  const store = await import(`../src/store/index.js?ttl=${Date.now()}`);
  store.reportDegraded('t|expiring', 'transient');
  assert.ok(store.getDegraded().some((d) => d.key === 't|expiring'));
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(store.getDegraded().some((d) => d.key === 't|expiring'), false, 'aged out');
  delete process.env.DEGRADED_TTL_MS;
});

// ── Error classification ────────────────────────────────────────
test('isMissingRelation separates "schema out of date" from "query failed"', async () => {
  const { isMissingRelation } = await import('../src/db/index.js');
  // A migration to run…
  assert.equal(isMissingRelation({ code: '42P01', message: 'relation "x" does not exist' }), true);
  assert.equal(isMissingRelation({ code: '42703', message: 'column "y" does not exist' }), true);
  assert.equal(isMissingRelation({ code: 'PGRST204', message: "Could not find the 'freeze' column of 'public_splits' in the schema cache" }), true);
  // …versus a performance or connectivity problem. Conflating these is how a
  // timing-out count got reported as an absent table.
  assert.equal(isMissingRelation({ code: '57014', message: 'canceling statement due to statement timeout' }), false);
  assert.equal(isMissingRelation({ code: '08006', message: 'connection failure' }), false);
  assert.equal(isMissingRelation(null), false);
});

// ── Write failures surface from the db layer ────────────────────
test('a failed write reports itself and still rethrows unchanged', async () => {
  // 92 agent call sites wrap writes in `catch (e) { logger.warn(...) }`, which
  // does not fail the run. Reporting here covers all of them at once, and the
  // rethrow keeps every caller's control flow identical.
  const reported = [];
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: { reportDegraded: (k, d) => reported.push({ k, d }) },
  });
  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: { supabase: { url: 'https://x.supabase.co', key: 'k' }, dryRun: false },
  });
  const pgrst = { code: 'PGRST204', message: "Could not find the 'freeze' column of 'public_splits' in the schema cache" };
  mock.module('@supabase/supabase-js', {
    namedExports: {
      createClient: () => ({
        from: () => ({
          insert: () => ({ select: async () => ({ data: null, error: pgrst }) }),
        }),
      }),
    },
  });

  const db = (await import(`../src/db/index.js?write=${Date.now()}`)).default;

  await assert.rejects(() => db.insert('public_splits', [{ freeze: true }]), /insert public_splits/,
    'the error must still propagate — this is observability, not a behaviour change');

  assert.equal(reported.length, 1, 'and it is reported exactly once');
  assert.equal(reported[0].k, 'write|public_splits', 'keyed per table, so the watchdog shows one issue');
  assert.match(reported[0].d, /schema out of date/, 'and names the actual cause');
  assert.match(reported[0].d, /schema\.sql/, 'with the fix');
  mock.reset();
});
