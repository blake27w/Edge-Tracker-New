// ══════════════════════════════════════════════════════════════
// Blocked agents × the degraded channel's TTL.
//
// `blocked` reporting rides the EXISTING reportDegraded channel, which has its
// own 90-minute expiry and its own repeat count — state the orchestrator does
// not own. The spec names the resulting mismatch as a known limitation
// (public-splits runs every 240 min, so a standing block flickers out of
// /health.system.degraded between runs) but the suite never exercised it, and
// a latched reportDegraded has bitten this repo before (D73). The two
// questions worth answering are the two directions of wrongness:
//
//   1. can a stale `blocked` entry OUTLIVE the condition?           (false alarm)
//   2. can a live condition DISAPPEAR while the agent is still blocked?  (silence)
//
// This file lives apart from agent-blocked.test.js for one reason:
// DEGRADED_TTL_MS is read once, at store module load (src/store/index.js:135),
// so the only way to get a short TTL is to set it before the first import of
// the store — which would make every timing-insensitive test in that file run
// against a 120ms expiry. node:test gives each file its own process, so a
// separate file is the isolation. Static imports are hoisted above top-level
// code, so the env var is set here and the modules come in dynamically below —
// exactly the pattern degradation-channel.test.js uses for the same reason.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Short enough to expire inside a test, long enough that a run (SLOW_MS) and
// the bookkeeping around it cannot expire an entry by accident. Every wait
// below is >= 2x the TTL, so no assertion sits near the boundary.
const TTL_MS = 120;
process.env.DEGRADED_TTL_MS = String(TTL_MS);

let orch, store, cfg;
const warns = [], infos = [];

before(async () => {
  store = await import('../src/store/index.js');
  cfg = (await import('../src/config/index.js')).default;

  const fakeDb = {
    isConnected: () => false,
    insert: async () => ({ data: [{ id: 1 }] }),
    upsert: async () => ({}), update: async () => ({}), del: async () => ({}),
    select: async () => [], count: async () => 0, isMissingRelation: () => false,
  };
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fakeDb, namedExports: fakeDb,
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: {
        info: (a, m) => infos.push(`${a}: ${m}`),
        warn: (a, m) => warns.push(`${a}: ${m}`),
        error: () => {},
      },
      notifyAll: async () => ({ total: 0 }),
      getFeed: () => [], getMetrics: () => ({}),
      getClaudeUsage: async () => ({ projectedMonthly: 0 }),
      hasClaude: () => false, detectModel: async () => null,
      claudeBlockReason: () => 'ANTHROPIC_API_KEY is not set in this deployment',
      parseJson: () => null, claude: async () => '', claudeJson: async () => null,
      sendSms: async () => ({ total: 0 }), sendEmail: async () => ({ total: 0 }),
    },
  });
  orch = await import('../src/orchestrator/index.js');
});
after(() => {
  try { orch.stop(); } catch (_) { /* ignore */ }
  mock.reset();
  delete process.env.DEGRADED_TTL_MS;
});
beforeEach(() => {
  warns.length = 0; infos.length = 0;
  cfg.rules.blockedRunsMin = 1;
  for (const d of store.getDegraded()) store.clearDegraded(d.key);
});

let seq = 0;
const BLOCKED = { summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' };
const agentThat = (impl) => ({ name: `ttl-${++seq}`, run: async () => impl() });
// NOTE: calling this performs the TTL sweep, because getDegraded() is what
// deletes expired entries. The last two tests depend on that, so read the
// channel deliberately rather than incidentally.
const degradedFor = (n) => store.getDegraded().filter((d) => d.key === `${n}|blocked`);
const healthFor = (n) => orch.getHealth().find((h) => h.name === n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the TTL expires a standing block, and /health keeps the durable count', async () => {
  // Question 2, and the limitation the spec accepted rather than engineered
  // around: an agent slower than the TTL goes quiet on
  // /health.system.degraded between runs even though nothing has recovered.
  // Pinned so that the day someone raises DEGRADED_TTL_MS, this test says what
  // changed; and so the DURABLE fields are shown to be unaffected, because
  // they are what an operator is told to read instead.
  const a = agentThat(() => BLOCKED);
  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1, 'reported on the first blocked run');

  await wait(TTL_MS * 2);
  assert.equal(degradedFor(a.name).length, 0,
    'the entry ages out mid-streak, with the agent still blocked — the accepted flicker');

  const h = healthFor(a.name);
  assert.equal(h.blockedRuns, 1, 'but blockedRuns does not expire');
  assert.equal(h.blockedReason, 'ANTHROPIC_API_KEY is not set', 'nor the reason');
  assert.ok(h.blockedSince, 'nor the start of the streak');
});

test('the next blocked run re-publishes, so the silence is a gap and never permanent', async () => {
  // The flicker is only acceptable if it is self-healing. If expiry left the
  // orchestrator believing it had already reported — e.g. if reporting were
  // gated on "not already present" — a condition that aged out once would
  // never be published again and the watchdog would never see it.
  const a = agentThat(() => BLOCKED);
  await orch.runAgentOnceForTest(a);
  const since = healthFor(a.name).blockedSince;

  await wait(TTL_MS * 2);
  assert.equal(degradedFor(a.name).length, 0, 'gone');

  await orch.runAgentOnceForTest(a);
  const d = degradedFor(a.name);
  assert.equal(d.length, 1, 'and back on the very next run — the report is unconditional');
  // The re-published detail must carry the orchestrator's DURABLE streak, not
  // a count restarted by the expiry: the agent has been blocked for 2 runs.
  assert.equal(d[0].detail,
    `not doing its job — ANTHROPIC_API_KEY is not set (2 consecutive runs since ${since})`,
    'the re-published detail keeps the true streak length and the ORIGINAL start time');
  assert.equal(healthFor(a.name).blockedSince, since,
    'an expiry in the store must not reset the clock the orchestrator owns');
});

test('a recovery after the TTL has expired leaves nothing behind', async () => {
  // Question 1 at its most awkward moment: the entry is already gone when the
  // clear arrives. clearDegraded is a delete, so this must be a no-op rather
  // than a resurrection or a throw — and the durable fields must still reset.
  const a = { name: `ttl-${++seq}`, blocked: true,
    run: async () => (a.blocked ? BLOCKED : { summary: 'wrote 38 split rows' }) };
  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1);

  await wait(TTL_MS * 2);
  a.blocked = false;
  await orch.runAgentOnceForTest(a);

  assert.equal(degradedFor(a.name).length, 0, 'still nothing published');
  const h = healthFor(a.name);
  assert.equal(h.blockedRuns, 0, 'and the durable fields reset on an already-expired entry');
  assert.equal(h.blockedReason, null);
  assert.equal(h.blockedSince, null);
  assert.ok(infos.some((i) => i.includes('No longer blocked')),
    'the recovery is still logged, so the transition is not swallowed by the expiry');
});

test('a recovery BEFORE the TTL retracts the entry instead of waiting it out', async () => {
  // The D73 property, and the one that actually protects an operator: a fixed
  // condition must vanish from /health at once, not linger for the rest of the
  // 90 minutes re-alerting a reason that is no longer true. Asserted by
  // clearing and then NOT waiting — if the clear were absent, the entry would
  // still be inside its TTL and visible here.
  const a = { name: `ttl-${++seq}`, blocked: true,
    run: async () => (a.blocked ? BLOCKED : { summary: 'wrote 38 split rows' }) };
  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1);

  // A CANARY on an unrelated key, stamped now. With a TTL this short, a
  // starved machine (a loaded CI runner, a parallel suite) could let more than
  // one TTL elapse between the two runs below — and then the blocked entry
  // would be gone because it EXPIRED, not because it was retracted, and this
  // test would pass for the wrong reason. The canary is the discriminator: if
  // it is still alive, less than one TTL has passed, so the blocked entry's
  // disappearance can only be the clear.
  const canary = `ttl-canary-${seq}|x`;
  store.reportDegraded(canary, 'proves less than one TTL elapsed');

  a.blocked = false;
  await orch.runAgentOnceForTest(a);

  assert.ok(store.getDegraded().some((d) => d.key === canary),
    'the canary must still be live, or this test proves nothing about the clear');
  assert.equal(degradedFor(a.name).length, 0,
    'retracted immediately — not left to age out, which is the whole D73 lesson');
  assert.equal(healthFor(a.name).blockedRuns, 0);
  store.clearDegraded(canary);
});

test('a blocked condition cannot outlive itself past one TTL, even unobserved', async () => {
  // The bound on a false alarm. Nothing in this feature re-reports on a timer
  // — only a run does — so the worst case is: last blocked run, then the fix
  // lands, then the agent does not run again for hours. The entry must be gone
  // one TTL after that last run regardless of whether anyone polled, because
  // the sweep is driven by getDegraded() and the watchdog calls it every 5 min
  // in production but a test can simply not look.
  const a = agentThat(() => BLOCKED);
  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1);

  // No polling at all during the wait — the sweep is lazy, so this proves the
  // expiry is a function of elapsed time and not of observation.
  await wait(TTL_MS * 3);
  assert.equal(degradedFor(a.name).length, 0,
    'one TTL after the last blocked run the alarm is gone, whatever happened in between');
  assert.equal(healthFor(a.name).blockedRuns, 1,
    'while the durable count still says the agent was blocked — the asymmetry is deliberate');
});

// ── The TTL sweep is LAZY, and that is observable ───────────────
// getDegraded() is what deletes expired entries (src/store/index.js:150), so
// "expired" and "removed" are not the same moment: an entry whose TTL has
// passed is still in the map until something reads the channel. Which means
// the store's own count/since after an expiry depend on WHETHER ANYONE
// POLLED /health or ran the watchdog during the gap.
//
// Found while writing these tests, and worth two tests rather than one
// because the first version of this file asserted the swept outcome and got
// the unswept one. It is not a defect: the `detail` a human reads is built
// entirely from the registry, so it is identical down both branches; only the
// store's bookkeeping differs, and the watchdog's "— seen N× since <d.since>"
// suffix is the single place that difference can surface. Both branches are
// pinned so that neither can change unnoticed.

test('an expiry that nobody observed revives the entry, keeping the original first-seen', async () => {
  const a = agentThat(() => BLOCKED);
  await orch.runAgentOnceForTest(a);
  await orch.runAgentOnceForTest(a);
  const twice = degradedFor(a.name)[0];
  assert.equal(twice.count, 2, 'two runs, two publications, one entry');
  const firstSeen = twice.since;

  // Deliberately NO read of the channel during the wait, so no sweep runs.
  await wait(TTL_MS * 2);
  await orch.runAgentOnceForTest(a);

  const after = degradedFor(a.name)[0];
  assert.equal(after.count, 3, 'the stale entry was still in the map, so the count carried on');
  assert.equal(after.since, firstSeen,
    'and its first-seen survives — which happens to be the TRUER streak start of the two');
  assert.match(after.detail, /3 consecutive runs/, 'the detail reports the real streak either way');
});

test('an expiry that WAS observed starts a fresh entry, and the detail is unchanged by it', async () => {
  const a = agentThat(() => BLOCKED);
  await orch.runAgentOnceForTest(a);
  await orch.runAgentOnceForTest(a);
  const firstSeen = degradedFor(a.name)[0].since;

  await wait(TTL_MS * 2);
  // One read — a /health curl, or any of the watchdog's 5-minute passes — and
  // the sweep actually deletes.
  assert.equal(degradedFor(a.name).length, 0, 'observed, therefore swept');

  await orch.runAgentOnceForTest(a);
  const after = degradedFor(a.name)[0];
  assert.equal(after.count, 1, "the store's repeat count restarted with the new entry");
  assert.notEqual(after.since, firstSeen, 'and so did its first-seen');
  assert.equal(after.since, after.at, 'the entry is genuinely new');

  // THE POINT: the operator-facing string is byte-identical to the unswept
  // branch above, because it is built from the registry and not from the
  // store. The laziness cannot mislead anyone about the length of the outage.
  assert.match(after.detail, /3 consecutive runs/,
    'the authoritative streak comes from the registry, so polling cannot change it');
  assert.ok(after.count <= healthFor(a.name).blockedRuns,
    'and the store can only ever under-count publications, never invent a longer outage');
});
