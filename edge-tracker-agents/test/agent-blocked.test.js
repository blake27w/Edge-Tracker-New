// ══════════════════════════════════════════════════════════════
// Blocked agents — a run that COULD NOT do its job is reported.
//
// `public-splits` returned `skipped — no Claude` with error: null,
// consecutiveFailures: 0 and runs: 1 for as long as the deployment was missing
// its key, wrote 0 rows against 671, zeroed the against-public component of
// every book-move score — and read HEALTHY on every surface we have, because a
// skip is not a failure. These tests pin the three properties that fix buys:
// a broken skip is reported, a benign skip never is, and nothing latches.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

let orch, store, realConfig, cfg, warns, infos;

before(async () => {
  // The real config/store first: intEnv and getDegraded's TTL logic are both
  // under test, so neither may be replaced by a fixture (watchdog.test.js
  // pattern).
  realConfig = await import('../src/config/index.js');
  store = await import('../src/store/index.js');

  warns = []; infos = [];
  // config is not mocked either: a namedExports fixture would have to restate
  // unitFor and the sport tables, and the one knob under test is a mutable
  // field on the shipped object. beforeEach restores it to the shipped 1. The
  // env→config wiring cannot be reached this way at all (one module instance
  // per process), which is what the child-process test at the bottom is for.
  cfg = realConfig.default;

  // db IS mocked — it imports @supabase/supabase-js at module scope, and the
  // scan_runs bookkeeping around every run must not need a connection.
  const fakeDb = {
    isConnected: () => false,
    insert: async () => ({ data: [{ id: 1 }] }),
    upsert: async () => ({}),
    update: async () => ({}),
    del: async () => ({}),
    select: async () => [],
    count: async () => 0,
    isMissingRelation: () => false,
  };
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: fakeDb, namedExports: fakeDb,
  });
  // utils has to be mocked — it imports @anthropic-ai/sdk at module scope, and
  // importing the orchestrator pulls in all 50 agent modules behind it. A
  // namedExports fixture replaces the module wholesale, so every export an
  // agent imports on the way in has to be present or the import fails at
  // instantiation.
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: {
        info: (a, m) => infos.push(`${a}: ${m}`),
        warn: (a, m) => warns.push(`${a}: ${m}`),
        error: () => {},
      },
      notifyAll: async () => ({ total: 0 }),
      getFeed: () => [],
      getMetrics: () => ({}),
      getClaudeUsage: async () => ({ projectedMonthly: 0 }),
      hasClaude: () => false,
      detectModel: async () => null,
      parseJson: () => null,
      claude: async () => '',
      claudeJson: async () => null,
      sendSms: async () => ({ total: 0 }),
      sendEmail: async () => ({ total: 0 }),
    },
  });
  // The store is deliberately NOT mocked: getDegraded's TTL sweep is part of
  // what "nothing latches" means, and a namedExports fixture here would have to
  // restate the ~40 getters the agent modules import on the way in.

  orch = await import('../src/orchestrator/index.js');
});
after(() => { try { orch.stop(); } catch (_) { /* ignore */ } mock.reset(); });

beforeEach(() => {
  warns.length = 0; infos.length = 0;
  cfg.rules.blockedRunsMin = 1;      // the shipped default
  for (const d of store.getDegraded()) store.clearDegraded(d.key);
});

// Each test gets its own agent name so the module-level registry cannot leak
// blockedRuns from one case into the next.
let seq = 0;
const stub = (impl) => ({ name: `stub-${++seq}`, run: async () => impl() });
// A run that takes measurable time, so consecutive lastRunAt stamps are
// DISTINGUISHABLE at ISO millisecond precision. Without it three runs land
// inside the same millisecond and every assertion about blockedSince passes
// whether it latches the first run or is overwritten by the last.
const SLOW_MS = 12;
const slowStub = (impl) => ({
  name: `stub-${++seq}`,
  run: async () => { await new Promise((res) => setTimeout(res, SLOW_MS)); return impl(); },
});
const degradedFor = (name) => store.getDegraded().filter((d) => d.key === `${name}|blocked`);
const healthFor = (name) => orch.getHealth().find((h) => h.name === name);

// ── 1. The anti-noise property, above all ───────────────────────
test('a benign skip is never reported, no matter how many times it repeats', async () => {
  // ~60 of the ~70 skip sites in src/agents are this: an empty slate, an
  // offseason, a budget pause. All of them are permanent facts of a season and
  // all of them are the system working. The default is quiet: an agent that
  // does not opt in reproduces today's behaviour exactly.
  const a = stub(() => ({ summary: 'no games on the slate' }));
  for (let i = 0; i < 5; i++) await orch.runAgentOnceForTest(a);

  assert.equal(store.getDegraded().length, 0, 'a benign skip must raise nothing, ever');
  assert.equal(healthFor(a.name).blockedRuns, 0);
  assert.equal(healthFor(a.name).runs, 5, 'and it still counts as five healthy runs');
});

// ── 2. The threshold ────────────────────────────────────────────
test('at the shipped default, the FIRST blocked run is reported', async () => {
  // Default 1, deliberately: an agent returning `blocked` is asserting the
  // condition is real, and for both opt-ins it cannot be transient — a missing
  // env var, with hasClaude() ANDing a client built once at module load with a
  // detectModel() called once and never retried. A confirming run would add
  // 4h of latency (public-splits' cadence) and no information.
  const a = stub(() => ({ summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }));

  await orch.runAgentOnceForTest(a);
  const d = degradedFor(a.name);
  assert.equal(d.length, 1, 'the default must not cost a cadence on the incident this exists to catch');
  assert.match(d[0].detail, /ANTHROPIC_API_KEY is not set/, 'the reason travels with the report');
  assert.match(d[0].detail, /1 consecutive runs/, 'and so does the count, which is the evidence');
  assert.ok(warns.some((w) => w.startsWith(`${a.name}: not doing its job`)), 'reported runs log a warning');
});

test('AGENT_BLOCKED_RUNS_MIN=2 holds the first run back and reports the second', async () => {
  // The threshold logic itself, exercised at a NON-default value — the knob
  // exists for a future agent whose blocked cause really is transient, and
  // `>=` vs `>` is invisible in production because nobody counts the runs
  // before the first alert.
  cfg.rules.blockedRunsMin = 2;
  const a = stub(() => ({ summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }));

  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 0, 'below the threshold, nothing is reported');
  assert.equal(healthFor(a.name).blockedRuns, 1, 'but it is already counted');

  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1, 'the threshold run is the one that REPORTS');
  assert.match(degradedFor(a.name)[0].detail, /2 consecutive runs/);
});

test('at the threshold the agent still looks idle and error-free to everything else', async () => {
  // The whole point: this fault class is invisible to status/error/failures.
  const a = stub(() => ({ summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }));
  await orch.runAgentOnceForTest(a);
  await orch.runAgentOnceForTest(a);

  const h = healthFor(a.name);
  assert.equal(h.status, 'idle');
  assert.equal(h.error, null);
  assert.equal(h.consecutiveFailures, 0);
  assert.equal(h.blockedRuns, 2, 'blockedRuns is the only field that knows');
});

// ── 3/4. Normalising the opt-in field ───────────────────────────
test('blocked: true uses the summary as the reason', async () => {
  const a = stub(() => ({ summary: 'skipped — no ODDS_API_KEY', blocked: true }));
  await orch.runAgentOnceForTest(a);
  await orch.runAgentOnceForTest(a);
  assert.match(degradedFor(a.name)[0].detail, /skipped — no ODDS_API_KEY/);
});

test('a non-string, non-true blocked is ignored rather than guessed at', async () => {
  // `blocked: 1` from a count, or `{}` from a half-written return, must not
  // produce an alert whose reason is "1" or "[object Object]".
  for (const v of [1, 0, {}, [], '', '   ', null, undefined]) {
    const a = stub(() => ({ summary: 'done', blocked: v }));
    await orch.runAgentOnceForTest(a);
    await orch.runAgentOnceForTest(a);
    assert.equal(degradedFor(a.name).length, 0, `blocked: ${JSON.stringify(v)} must not report`);
    assert.equal(healthFor(a.name).blockedRuns, 0);
  }
});

// ── 5. Clearing — three paths, none of which may latch ──────────
test('a normal success clears the report and the counter', async () => {
  // D73: an unretracted reportDegraded latches for the full 90-min TTL and goes
  // on re-alerting an obsolete reason. The clear is on the DEFAULT branch, so
  // nothing has to remember it.
  let blocked = true;
  const a = { name: `stub-${++seq}`, run: async () => (blocked
    ? { summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }
    : { summary: 'wrote 38 split rows' }) };

  for (let i = 0; i < 3; i++) await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1);

  blocked = false;
  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 0, 'the degraded entry is retracted, not left to the TTL');
  assert.equal(healthFor(a.name).blockedRuns, 0);
  assert.equal(healthFor(a.name).blockedReason, null);
  assert.equal(healthFor(a.name).blockedSince, null);
  assert.ok(infos.some((i) => i.includes('No longer blocked')), 'the recovery is logged too');
});

test('a BENIGN SKIP also clears it — the agent is no longer claiming it is broken', async () => {
  // Setting the env var and redeploying clears on the agent's first run even if
  // that run finds an empty slate. The alternative — only a productive run
  // clears — would keep an offseason agent reported as broken all winter.
  let blocked = true;
  const a = { name: `stub-${++seq}`, run: async () => (blocked
    ? { summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }
    : { summary: 'no slate for public splits' }) };

  for (let i = 0; i < 3; i++) await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1);

  blocked = false;
  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 0);
  assert.equal(healthFor(a.name).blockedRuns, 0);
});

test('a THROW clears it too, and still records the failure', async () => {
  // The error path owns the reporting from there; a surviving blocked entry
  // would double-report the same agent with a reason that is no longer the
  // problem.
  let blocked = true;
  const a = { name: `stub-${++seq}`, run: async () => {
    if (blocked) return { summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' };
    throw new Error('splits fetch 503');
  } };

  for (let i = 0; i < 3; i++) await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1);

  blocked = false;
  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 0, 'the blocked entry does not outlive the condition');
  const h = healthFor(a.name);
  assert.equal(h.blockedRuns, 0);
  assert.equal(h.consecutiveFailures, 1, 'and the throw is still a failure in its own right');
  assert.equal(h.error, 'splits fetch 503');
});

test('the counter is consecutive, not cumulative', async () => {
  cfg.rules.blockedRunsMin = 2;      // so "below threshold" is still a state
  let mode = 'blocked';
  const a = { name: `stub-${++seq}`, run: async () => (mode === 'blocked'
    ? { summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }
    : { summary: 'done' }) };

  await orch.runAgentOnceForTest(a);
  mode = 'ok'; await orch.runAgentOnceForTest(a);
  mode = 'blocked'; await orch.runAgentOnceForTest(a);
  assert.equal(healthFor(a.name).blockedRuns, 1, 'the successful run reset the streak');
  assert.equal(degradedFor(a.name).length, 0, 'so one blocked run after a good one is still below threshold');
});

// ── 6. The coercion trap (D79) ──────────────────────────────────
test('AGENT_BLOCKED_RUNS_MIN=0 reports on the very first blocked run', async () => {
  cfg.rules.blockedRunsMin = 0;
  const a = stub(() => ({ summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }));
  await orch.runAgentOnceForTest(a);
  assert.equal(degradedFor(a.name).length, 1, '0 means "tell me immediately", not "never"');
  assert.match(degradedFor(a.name)[0].detail, /1 consecutive runs/);
});

test('intEnv: 0 is a real value, but blank is not a zero', async () => {
  // Number('') and Number('  ') are both a finite 0, so num()/`|| dflt` would
  // read an unset or whitespace variable as "report on the first blocked run"
  // or discard an explicit 0 respectively. This is the D10/D67/D79 family, and
  // the reason this knob does not go through num().
  const { intEnv } = realConfig;
  assert.equal(intEnv('0', 2), 0, 'an explicit 0 must survive');
  assert.equal(intEnv(0, 2), 0);
  assert.equal(intEnv('', 2), 2, "Number('') is a finite 0 — the bug this reader exists to avoid");
  assert.equal(intEnv('  ', 2), 2);
  assert.equal(intEnv(null, 2), 2);
  assert.equal(intEnv(undefined, 2), 2);
  assert.equal(intEnv('"3"', 2), 3, 'dashboard-pasted quotes are stripped, as clean() does elsewhere');
  assert.equal(intEnv('5', 2), 5);
  assert.equal(intEnv('-1', 2), 2, 'a negative threshold would report every run forever');
  assert.equal(intEnv('1.5', 2), 2, 'a fractional run count is a typo, not a setting');
  assert.equal(intEnv('abc', 2), 2);
  assert.equal(intEnv([], 2), 2, 'Number([]) is 0 too');
});

test('the shipped default is 1 — the first blocked run reports', () => {
  // If this ever goes back to 2, the two opted-in agents get a 4h/2h detection
  // delay on a condition that is immutable for the life of the process.
  assert.equal(realConfig.default.rules.blockedRunsMin, 1);
});

test('the env var reaches config through intEnv, and 0 survives the trip', async () => {
  // The ONE hole the in-process tests cannot see: they mutate the field on the
  // already-loaded object, so `blockedRunsMin: intEnv(env.X, 1) || 1` — the
  // exact D79 coercion bug intEnv exists to prevent — would pass every
  // assertion above. A child process is the only way to vary the environment.
  const read = async (value) => {
    const env = { ...process.env };
    if (value === undefined) delete env.AGENT_BLOCKED_RUNS_MIN;
    else env.AGENT_BLOCKED_RUNS_MIN = value;
    const { stdout } = await run(process.execPath, ['-e',
      "import('./src/config/index.js').then((m) => console.log(JSON.stringify(m.default.rules.blockedRunsMin)))"],
    { cwd: new URL('..', import.meta.url), env });
    return JSON.parse(stdout.trim());
  };

  assert.equal(await read('0'), 0,
    'an explicit 0 must arrive as 0 — `intEnv(...) || 1` would turn it into 1');
  assert.equal(await read('3'), 3, 'and a real value must arrive intact');
  assert.equal(await read(''), 1,
    "Number('') is a finite 0, so a blank variable must NOT read as 'report immediately'");
  assert.equal(await read('  '), 1);
  assert.equal(await read(undefined), 1, 'and unset is the default');
});

// ── 7. The durable view ─────────────────────────────────────────
test('getHealth exposes blockedRuns/blockedReason/blockedSince and they persist', async () => {
  // The degraded channel ages out on a 90-min TTL while public-splits runs
  // every 4h, so a standing block flickers out of /health.system.degraded
  // between runs. These three fields never expire and are the number to read.
  //
  // slowStub, not stub: the runs must be SEPARATED IN TIME or all three
  // lastRunAt stamps land in the same millisecond and `blockedSince` reads
  // identically whether it latches the first run or is clobbered by the last.
  const a = slowStub(() => ({ summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }));
  await orch.runAgentOnceForTest(a);
  const first = healthFor(a.name);
  assert.equal(first.blockedRuns, 1);
  assert.equal(first.blockedReason, 'ANTHROPIC_API_KEY is not set');
  assert.ok(first.blockedSince, 'blockedSince is stamped on the first blocked run');
  assert.equal(first.blockedSince, first.lastRunAt, 'and on run 1 the two are the same instant');

  await orch.runAgentOnceForTest(a);
  await orch.runAgentOnceForTest(a);
  const later = healthFor(a.name);
  assert.equal(later.blockedRuns, 3);
  // The discriminating assertion. `blockedSince = r.lastRunAt` without the
  // `if (!r.blockedSince)` guard passes everything above and fails here.
  assert.equal(later.blockedSince, first.blockedSince, 'it marks the START of the streak, not the last run');
  assert.ok(new Date(later.lastRunAt) - new Date(later.blockedSince) >= 2 * SLOW_MS,
    `blockedSince must lag the latest run by the two runs in between (since=${later.blockedSince}, last=${later.lastRunAt})`);
  // And the published detail — the string a human reads to judge how long the
  // agent has been down — carries the streak start, not "now".
  assert.ok(degradedFor(a.name)[0].detail.includes(`since ${first.blockedSince}`),
    'the reported detail names the first blocked run, which is the whole evidentiary value of the field');
});

// ── The streak belongs to ONE reason ────────────────────────────
test('a change of reason restarts the streak and the clock', async () => {
  // Otherwise an agent blocked once by A and once by B reports "not doing its
  // job — B (2 consecutive runs since <A's first run>)": a count and a start
  // time that belong to a fault that is no longer the problem — the exact
  // opposite of what the temporal filter advertises.
  cfg.rules.blockedRunsMin = 2;
  let reason = 'ANTHROPIC_API_KEY is not set';
  const a = { name: `stub-${++seq}`, run: async () => {
    await new Promise((res) => setTimeout(res, SLOW_MS));
    return { summary: 'skipped', blocked: reason };
  } };

  await orch.runAgentOnceForTest(a);
  const afterA = healthFor(a.name);
  assert.equal(afterA.blockedRuns, 1);

  reason = 'ODDS_API_KEY is not set';
  await orch.runAgentOnceForTest(a);
  const afterB = healthFor(a.name);
  assert.equal(afterB.blockedRuns, 1, 'B is its own first run, not A\'s second');
  assert.equal(afterB.blockedReason, 'ODDS_API_KEY is not set');
  assert.notEqual(afterB.blockedSince, afterA.blockedSince, "and the clock starts at B's first run");
  assert.equal(afterB.blockedSince, afterB.lastRunAt);
  assert.equal(degradedFor(a.name).length, 0, 'so one run of B is still below the threshold of 2');

  // Confirming B reports B's count and B's start time — nothing from A.
  await orch.runAgentOnceForTest(a);
  const d = degradedFor(a.name);
  assert.equal(d.length, 1);
  assert.match(d[0].detail, /ODDS_API_KEY is not set \(2 consecutive runs/);
  assert.ok(d[0].detail.includes(`since ${afterB.blockedSince}`), "the start time is B's, not A's");
  assert.ok(!d[0].detail.includes(afterA.blockedSince), "A's timestamp must not survive into B's report");
  assert.equal(d[0].count, 1, "and the store entry's own since/count restarted, so the watchdog does not say \"seen 3x since <A's time>\"");
});

test('every agent carries the three fields, so /health has no missing keys', async () => {
  const a = stub(() => ({ summary: 'done' }));
  await orch.runAgentOnceForTest(a);
  const h = healthFor(a.name);
  for (const k of ['blockedRuns', 'blockedReason', 'blockedSince']) {
    assert.ok(k in h, `${k} must be present even on an agent that never blocks`);
  }
});

// ── 9. No credential can reach a log or a payload ───────────────
// Strip comments before grepping source for a forbidden construct, so prose
// ABOUT the constraint cannot fail the build. Same helper as tools/smoke.mjs.
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the published strings are a closed template over the AUTHORED reason', async () => {
  // The hard constraint of this spec: no key value, and no prefix of one, may
  // ever reach a log or a payload. Asserting that on source text is weak — a
  // credential arriving through an import would pass any `process.env` grep —
  // so assert it on what the feature actually publishes.
  //
  // A sentinel under the real variable's name, in this test process only. If
  // any code path between the agent's return and a /health field, a log line
  // or a degraded detail read the variable, the value appears below.
  const SENTINEL = 'sk-ant-NOT-A-REAL-KEY-test-sentinel';
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = SENTINEL;
  try {
    const a = stub(() => ({ summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }));
    await orch.runAgentOnceForTest(a);
    const h = healthFor(a.name);
    const d = degradedFor(a.name)[0];

    // EXACT equality, not a substring match: the detail is a closed template
    // over the agent-authored reason, the run count and the streak start, so
    // nothing else CAN be in it — a stronger claim than "the sentinel isn't".
    assert.equal(d.detail,
      `not doing its job — ANTHROPIC_API_KEY is not set (1 consecutive runs since ${h.blockedSince})`,
      'the detail is built from the authored reason and two numbers, nothing else');
    assert.equal(d.key, `${a.name}|blocked`, 'and the key is the agent name, which the watchdog splits back out');
    assert.equal(h.blockedReason, 'ANTHROPIC_API_KEY is not set');

    // Everything this feature can surface, in one string.
    const published = [d.key, d.detail, h.blockedReason, h.lastResult, h.error,
      ...warns, ...infos].join('\n');
    assert.ok(!published.includes(SENTINEL),
      'no surface may carry the value of the variable it names');
    assert.ok(!/sk-ant|sk-[A-Za-z0-9]{8}/.test(published),
      'nor any prefix shaped like a key, however it got there');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('the two opted-in agents author their reason as a literal', async () => {
  // The other half: the reason reaching the template above must itself be a
  // single-quoted literal naming the variable, never an interpolation of it.
  const base = new URL('../src/', import.meta.url);
  for (const f of ['agents/public-splits/index.js', 'agents/combat-weighin/index.js']) {
    const code = codeOnly(await readFile(new URL(f, base), 'utf8'));
    assert.match(code, /blocked: 'ANTHROPIC_API_KEY is not set[^']*'/,
      `${f} opts in with an authored literal — no \${} and no concatenation`);
    assert.equal(/process\.env\.ANTHROPIC/.test(code), false,
      `${f} must name the variable in its reason, never interpolate its value`);
  }
});

test('the orchestrator reads no env var and holds no credential', async () => {
  // Belt to the braces above, and narrow on purpose. Comments are stripped
  // first so that writing AGENT_BLOCKED_RUNS_MIN or process.env in a comment
  // cannot fail the build for a non-defect.
  //
  // What this does NOT cover: a credential arriving through an import (e.g.
  // config.anthropic.apiKey) would pass both greps. That case is covered
  // behaviourally by the closed-template test above, which is the assertion
  // that actually constrains what can be published.
  const code = codeOnly(await readFile(new URL('../src/orchestrator/index.js', import.meta.url), 'utf8'));
  assert.equal(/process\.env\b/.test(code), false, 'the orchestrator reads no env var at all');
  assert.equal(/apiKey/i.test(code), false, 'and holds no credential by any name');
});
