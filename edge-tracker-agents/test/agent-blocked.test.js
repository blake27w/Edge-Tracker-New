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
// Toggled by the two end-to-end tests at the bottom, which drive the REAL
// public-splits and combat-weighin modules on both sides of their gate. Every
// other test in this file wants the production-incident value, false.
let claudeAvailable = false;

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
      hasClaude: () => claudeAvailable,
      claudeBlockReason: () => 'ANTHROPIC_API_KEY is not set in this deployment',
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
  //
  // process.env ALONE IS NOT ENOUGH, and that is the whole point of this
  // block. config.anthropic.apiKey is `clean(env.ANTHROPIC_API_KEY)` evaluated
  // ONCE at module load (src/config/index.js:267), and before() has already
  // imported config by the time this test runs — so a sentinel written only to
  // process.env arrives too late to appear on the config object, and a leak
  // through `config.anthropic.apiKey` (the most likely import path in this
  // codebase, and the one the source greps below explicitly cannot see)
  // interpolates the empty string and is INVISIBLE. Verified by mutation: with
  // the sentinel in process.env only, a detail built as
  // `${config.anthropic['api'+'Key']}...` passes this test, the greps, and
  // smoke. So seed the loaded config too, on every credential field, and the
  // behavioural claim becomes the real one it is advertised as.
  const SENTINEL = 'sk-ant-NOT-A-REAL-KEY-test-sentinel';
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = SENTINEL;
  // Every clean(env.*KEY|TOKEN) field config exposes, so the sweep does not
  // depend on guessing which one a future edit would reach for.
  const slots = [[cfg.anthropic, 'apiKey'], [cfg.supabase, 'key'],
    [cfg.oddsApi, 'key'], [cfg.research, 'token']];
  const savedSlots = slots.map(([o, k]) => (o ? o[k] : undefined));
  for (const [o, k] of slots) if (o) o[k] = SENTINEL;
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

    // The same sweep over the two remaining sinks the reason string reaches,
    // so "no credential in any sink" is asserted on the sinks rather than
    // inferred from the detail: the watchdog issue the dashboard renders, and
    // the whole /health payload the operator curls.
    const { default: watchdog } = await import('../src/agents/watchdog/index.js');
    await watchdog.run();
    const wdIssues = JSON.stringify((store.getWatchdog() || {}).issues || []);
    assert.ok(!wdIssues.includes(SENTINEL), 'no credential may reach a watchdog issue');
    const blockedIssue = JSON.parse(wdIssues).find((i) => i.key === `data|${a.name}|blocked`);
    assert.ok(blockedIssue, 'and the blocked entry does become an issue');
    assert.equal(blockedIssue.type, 'blocked');
    assert.equal(blockedIssue.agent, a.name, 'the agent is split back out of the key');
    assert.equal(blockedIssue.label, `Agent blocked (${a.name})`);
    assert.ok(!JSON.stringify(orch.getHealth()).includes(SENTINEL),
      'nor any field of the /health payload');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    slots.forEach(([o, k], i) => { if (o) o[k] = savedSlots[i]; });
  }
});

test('the two opted-in agents source their reason from the audited helper', async () => {
  // The other half: the reason reaching the template above must never be an
  // interpolation of the value. The literals moved into claudeBlockReason() so
  // there is ONE place to audit instead of one per opt-in agent, and so a key
  // that is SET but unusable is not reported as missing — hasClaude() ANDs a
  // client against a detected model and those fail for different reasons.
  const base = new URL('../src/', import.meta.url);
  for (const f of ['agents/public-splits/index.js', 'agents/combat-weighin/index.js']) {
    const code = codeOnly(await readFile(new URL(f, base), 'utf8'));
    assert.match(code, /blocked: claudeBlockReason\(\)/,
      `${f} opts in via the shared helper, not an inline string`);
    assert.equal(/process\.env\.ANTHROPIC/.test(code), false,
      `${f} must never interpolate the value`);
  }
  // And the helper itself is the single place a credential could enter: exactly
  // two constant literals, no template, no concatenation, no env or config read.
  const utils = codeOnly(await readFile(new URL('utils/index.js', base), 'utf8'));
  const body = (utils.match(/export const claudeBlockReason[\s\S]*?;\n/) || [''])[0];
  assert.ok(body.length > 0, 'claudeBlockReason is exported from utils');
  assert.match(body, /is not set/, 'it covers the missing-key case');
  assert.match(body, /no model was detected/, 'and the set-but-unusable case, distinctly');
  for (const bad of [/\$\{/, /\+/, /process\.env/, /apiKey/i]) {
    assert.equal(bad.test(body), false, `the helper cannot carry a value (${bad})`);
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

// ══════════════════════════════════════════════════════════════
// VERIFICATION PASS — state-machine exhaustiveness.
//
// The registry now carries four coupled pieces of state (consecutiveBlocked,
// blockedReason, blockedSince, and a store entry with its own TTL and count),
// and the published detail interpolates three of them. The failure mode this
// section exists to catch is a detail string whose count, reason or timestamp
// belongs to a DIFFERENT fault than the one it names — one such bug (the
// reason change) was already found and fixed, so the question is whether it
// has siblings. Rather than assert field-by-field per transition, assert one
// invariant after EVERY transition: the four fields agree with each other and
// with what was published.
// ══════════════════════════════════════════════════════════════

// The whole consistency contract in one function. `expect` is what the caller
// believes the state should be; the invariant is what must hold regardless.
function assertSelfConsistent(name, label) {
  const h = healthFor(name);
  const entries = degradedFor(name);

  if (h.blockedRuns === 0) {
    assert.equal(h.blockedReason, null, `${label}: no streak, so no reason may linger`);
    assert.equal(h.blockedSince, null, `${label}: no streak, so no start time may linger`);
    assert.equal(entries.length, 0,
      `${label}: nothing is blocked, so no degraded entry may outlive the condition (D73)`);
    return h;
  }

  assert.ok(h.blockedReason, `${label}: a live streak must name its reason`);
  assert.ok(h.blockedSince, `${label}: a live streak must carry its start time`);
  assert.ok(new Date(h.blockedSince).getTime() <= new Date(h.lastRunAt).getTime(),
    `${label}: the streak cannot have started after the run that extended it`);

  if (h.blockedRuns >= cfg.rules.blockedRunsMin) {
    assert.equal(entries.length, 1, `${label}: at or above the threshold, exactly one entry`);
    // The closed template, rebuilt from the registry. If the count, the reason
    // or the timestamp in the published string belonged to a different fault,
    // this equality is what fails.
    assert.equal(entries[0].detail,
      `not doing its job — ${h.blockedReason} (${h.blockedRuns} consecutive runs since ${h.blockedSince})`,
      `${label}: the published detail must agree with the registry on all three`);
  } else {
    assert.equal(entries.length, 0, `${label}: below the threshold, nothing is published`);
  }
  return h;
}

// A programmable agent, so a test can walk it through an arbitrary sequence of
// outcomes. `slow` keeps consecutive lastRunAt stamps distinguishable at ISO
// millisecond precision — three runs inside one millisecond make every
// blockedSince assertion vacuous.
function scripted() {
  const a = {
    name: `stub-${++seq}`,
    next: null,
    run: async () => {
      await new Promise((res) => setTimeout(res, SLOW_MS));
      const n = a.next;
      if (n.throws) throw new Error(n.throws);
      return n.out;
    },
  };
  a.step = async (next) => { a.next = next; await orch.runAgentOnceForTest(a); };
  return a;
}
const BLOCKED_A = { out: { summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' } };
const BLOCKED_B = { out: { summary: 'skipped — no DB', blocked: 'DATABASE_URL is not set' } };
const SUCCESS = { out: { summary: 'wrote 38 split rows' } };
const BENIGN = { out: { summary: 'no games on the slate' } };
const THROWS = { throws: 'splits fetch 503' };

test('every transition out of blocked lands in a self-consistent state', async () => {
  // The eight transitions, each asserted with the invariant above rather than
  // with hand-written per-case expectations — the point is that no combination
  // can produce a detail carrying another fault's count, reason or timestamp.
  const paths = [
    ['blocked → blocked', [BLOCKED_A, BLOCKED_A], { runs: 2, reported: true }],
    ['blocked → success', [BLOCKED_A, SUCCESS], { runs: 0, reported: false }],
    ['blocked → throw', [BLOCKED_A, THROWS], { runs: 0, reported: false }],
    ['blocked → benign skip', [BLOCKED_A, BENIGN], { runs: 0, reported: false }],
    ['blocked → reason change → blocked', [BLOCKED_A, BLOCKED_B, BLOCKED_B], { runs: 2, reported: true }],
    ['success → blocked', [SUCCESS, BLOCKED_A], { runs: 1, reported: true }],
    ['throw → blocked', [THROWS, BLOCKED_A], { runs: 1, reported: true }],
    ['benign → blocked → benign', [BENIGN, BLOCKED_A, BENIGN], { runs: 0, reported: false }],
    ['blocked → throw → blocked', [BLOCKED_A, THROWS, BLOCKED_A], { runs: 1, reported: true }],
    ['reason A → B → A again', [BLOCKED_A, BLOCKED_B, BLOCKED_A], { runs: 1, reported: true }],
  ];

  for (const [label, steps, expect] of paths) {
    const a = scripted();
    // The invariant must hold after EVERY step, not only at the end — a
    // transient inconsistency is still a state /health can be polled in.
    for (const s of steps) { await a.step(s); assertSelfConsistent(a.name, label); }

    const h = healthFor(a.name);
    assert.equal(h.blockedRuns, expect.runs, `${label}: streak length`);
    assert.equal(degradedFor(a.name).length, expect.reported ? 1 : 0, `${label}: published or not`);
  }
});

test('a reason change never leaves the previous fault\'s count or clock in the report', async () => {
  // The sibling-hunt, at a threshold where the count is observable: walk A up
  // to a reported streak, switch to B, and assert nothing of A survives into
  // B's published string — not its count, not its start time, not its text.
  cfg.rules.blockedRunsMin = 2;
  const a = scripted();
  await a.step(BLOCKED_A); await a.step(BLOCKED_A); await a.step(BLOCKED_A);
  const atA = healthFor(a.name);
  assert.equal(atA.blockedRuns, 3);
  const dA = degradedFor(a.name)[0];
  assert.equal(dA.count, 2, 'A was published twice (runs 2 and 3)');

  await a.step(BLOCKED_B);
  const atB = healthFor(a.name);
  assert.equal(atB.blockedRuns, 1, "B's first run is not A's fourth");
  assert.equal(degradedFor(a.name).length, 0, 'and one run of B is below the threshold of 2');
  assert.notEqual(atB.blockedSince, atA.blockedSince, "B's clock starts at B's first run");

  await a.step(BLOCKED_B);
  const dB = degradedFor(a.name)[0];
  assertSelfConsistent(a.name, 'after switching to B');
  assert.match(dB.detail, /DATABASE_URL is not set \(2 consecutive runs/);
  assert.ok(!dB.detail.includes('ANTHROPIC'), "A's reason must not survive");
  assert.ok(!dB.detail.includes(atA.blockedSince), "nor A's timestamp");
  assert.equal(dB.count, 1, "and the store's own count restarted, so the watchdog cannot say \"seen 3× since <A's time>\"");
  assert.equal(dB.since, dB.at, 'the store entry is genuinely new, not a revived one');
});

test('a throw between two blocked runs does not let the old clock back in', async () => {
  // The three fields are cleared on the error path, so the blocked run AFTER a
  // throw must start a fresh streak. If the catch block cleared only two of
  // the three, blockedSince would survive and the next report would claim a
  // streak reaching back before the failure.
  cfg.rules.blockedRunsMin = 1;
  const a = scripted();
  await a.step(BLOCKED_A);
  const first = healthFor(a.name).blockedSince;
  await a.step(THROWS);
  assertSelfConsistent(a.name, 'after the throw');
  await a.step(BLOCKED_A);
  const after = healthFor(a.name);
  assert.equal(after.blockedRuns, 1, 'the throw reset the streak');
  assert.notEqual(after.blockedSince, first, 'and the clock restarted with it');
  assert.ok(degradedFor(a.name)[0].detail.includes(`since ${after.blockedSince}`),
    'the report names the post-throw start, not the pre-throw one');
  assert.ok(!degradedFor(a.name)[0].detail.includes(first));
});

test('a varying summary under blocked: true resets the streak every run', async () => {
  // NOT a defect — a consequence of "a different reason is a different fault"
  // meeting "blocked: true means the summary IS the reason". Pinned because it
  // is a live trap for a future opt-in: an agent whose summary carries a count
  // or a timestamp can never accumulate a streak, so AGENT_BLOCKED_RUNS_MIN > 1
  // would silence it permanently. Both of today's opt-ins return a constant
  // literal summary, so neither is affected.
  cfg.rules.blockedRunsMin = 2;
  let n = 0;
  const a = { name: `stub-${++seq}`, run: async () => ({ summary: `skipped — no Claude (${++n})`, blocked: true }) };
  for (let i = 0; i < 4; i++) await orch.runAgentOnceForTest(a);
  assert.equal(healthFor(a.name).blockedRuns, 1,
    'each run reads as a new fault, so the streak never grows');
  assert.equal(degradedFor(a.name).length, 0,
    'and with a threshold above 1 such an agent is never reported — the trap this pins');
  assertSelfConsistent(a.name, 'varying summary');

  // A CONSTANT summary under blocked: true accumulates normally, which is the
  // contrast that shows the cause is the variation, not blocked: true itself.
  const b = { name: `stub-${++seq}`, run: async () => ({ summary: 'skipped — no Claude', blocked: true }) };
  await orch.runAgentOnceForTest(b); await orch.runAgentOnceForTest(b);
  assert.equal(healthFor(b.name).blockedRuns, 2);
  assert.equal(degradedFor(b.name).length, 1);
});

test('intEnv rejects every non-integer shape and honours a real zero', async () => {
  // The probe battery, beyond the cases the build already pinned. A threshold
  // is a run COUNT: anything that is not a non-negative integer must fall back
  // rather than be coerced into one.
  const { intEnv } = realConfig;
  const D = 7;
  for (const [label, v, want] of [
    ['empty string', '', D], ['whitespace', '  ', D], ['string zero', '0', 0], ['number zero', 0, 0],
    ['negative', '-1', D], ['fractional', '2.7', D], ['padded integer', ' 2 ', 2],
    ['exponent', '1e3', 1000], ['hex', '0x10', 16],
    ['null', null, D], ['undefined', undefined, D],
    ['true', true, D], ['false', false, D],
    ['empty array', [], D], ['single-element array', ['3'], 3], ['object', {}, D],
    ['NaN', NaN, D], ['Infinity', Infinity, D], ['-Infinity', -Infinity, D],
    ['letters', 'abc', D], ['quoted zero', '"0"', 0], ['leading plus', '+3', 3],
    ['above MAX_SAFE_INTEGER', '9007199254740993', 9007199254740992],
  ]) {
    assert.equal(intEnv(v, D), want, `intEnv(${label}) must be ${want}`);
  }
  // The two properties the knob actually depends on, stated as properties.
  assert.notEqual(intEnv('', D), 0, "a blank variable must never read as an explicit 0 (D79)");
  assert.equal(intEnv('0', D), 0, 'while an explicit 0 must survive coercion');
});

test('a threshold of 0 and the shipped 1 are deliberately identical, and both report run 1', async () => {
  // Honest note on an assertion that could look stronger than it is: the
  // streak starts at 1, so `1 >= 0` and `1 >= 1` are both true and NO
  // behavioural test can separate blockedRunsMin 0 from 1. The 0 path is
  // pinned at the config layer instead (the child-process test above), where
  // `intEnv(...) || 1` would be caught. This test states the equivalence so
  // that raising the default re-opens the question rather than silently
  // making the 0 branch dead.
  for (const min of [0, 1]) {
    cfg.rules.blockedRunsMin = min;
    const a = stub(() => ({ summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' }));
    await orch.runAgentOnceForTest(a);
    assert.equal(degradedFor(a.name).length, 1, `min=${min} reports the first blocked run`);
    assert.match(degradedFor(a.name)[0].detail, /1 consecutive runs/,
      `min=${min} counts the first run as 1, never 0`);
  }
});

// ══════════════════════════════════════════════════════════════
// The two opted-in agents, driven for real on BOTH sides of the gate.
//
// Everything above tests the orchestrator against stub agents, and the only
// coverage of the two real opt-ins is a source grep for the literal. A grep
// cannot tell whether the field is on the returned object, whether it is
// reachable, or whether it DISAPPEARS when the key is present — so drive the
// shipped modules through the shipped orchestrator with hasClaude() toggled.
// ══════════════════════════════════════════════════════════════

const OPTED_IN = ['public-splits', 'combat-weighin'];

test('with no key, both opted-in agents produce the blocked condition end to end', async () => {
  // The production incident, reproduced: hasClaude() false is exactly what an
  // unset ANTHROPIC_API_KEY causes (the client is built once at module load and
  // detectModel() resolves the model once; both are falsy without a key).
  claudeAvailable = false;
  for (const name of OPTED_IN) {
    const mod = (await import(`../src/agents/${name}/index.js`)).default;
    assert.equal(mod.name, name, 'the module under test is the one named');

    // First the raw contract, so a failure localises to the agent or the
    // orchestrator rather than somewhere between them.
    const out = await mod.run();
    assert.equal(out.summary, 'skipped — no Claude', `${name} still reports the same summary`);
    assert.equal(typeof out.blocked, 'string', `${name} opts in with a string reason`);
    assert.ok(out.blocked.includes('ANTHROPIC_API_KEY'), `${name} names the variable`);
    assert.ok(!/sk-|key=|Bearer/i.test(out.blocked), `${name}'s reason carries no credential shape`);

    // Then the whole path, through the real orchestrator.
    await orch.runAgentOnceForTest(mod);
    const h = healthFor(name);
    assert.equal(h.blockedRuns, 1, `${name} is counted as blocked`);
    assert.equal(h.lastResult, 'skipped — no Claude',
      `${name} still reports the benign-looking summary — which is the whole problem`);
    assert.equal(h.error, null, 'and still has no error');
    assert.equal(h.consecutiveFailures, 0, 'and no failures');
    assert.equal(degradedFor(name).length, 1,
      `${name} now raises a degraded entry, where before it raised nothing`);
    assertSelfConsistent(name, `${name} with no key`);
  }
});

test('with the key present, both agents stop reporting and the entry is retracted', async () => {
  // The other half, and the one the manual recipe explicitly cannot cover
  // without a working key. A LABELLED FAKE is never constructed here: the gate
  // is hasClaude(), so flipping that is both sufficient and the only honest way
  // to simulate a usable key without one.
  //
  // Each agent is left blocked first, so this also proves the recovery
  // RETRACTS rather than merely stops adding.
  claudeAvailable = false;
  for (const name of OPTED_IN) {
    const mod = (await import(`../src/agents/${name}/index.js`)).default;
    await orch.runAgentOnceForTest(mod);
    assert.equal(degradedFor(name).length, 1, `${name} starts blocked`);
  }

  claudeAvailable = true;
  try {
    for (const name of OPTED_IN) {
      const mod = (await import(`../src/agents/${name}/index.js`)).default;

      // Past the gate there is no slate and no weigh-in window in this
      // fixture, so each agent returns one of its BENIGN skips — which is the
      // realistic post-fix state and must clear just the same.
      const out = await mod.run();
      assert.equal(out.blocked, undefined,
        `${name} must not mark itself blocked once Claude is available`);

      await orch.runAgentOnceForTest(mod);
      const h = healthFor(name);
      assert.equal(h.blockedRuns, 0, `${name}'s streak is reset`);
      assert.equal(h.blockedReason, null);
      assert.equal(h.blockedSince, null);
      assert.equal(degradedFor(name).length, 0,
        `${name}'s degraded entry is retracted on the first unblocked run, not left to the TTL`);
      assertSelfConsistent(name, `${name} with a key`);
    }
  } finally {
    claudeAvailable = false;
  }
});

test('no OTHER agent opts in by accident, so the alert surface is exactly two', async () => {
  // The anti-noise property at the level of the whole fleet. ~60 of the ~70
  // skip sites are benign and must stay silent; if a future edit adds `blocked`
  // to one of them (a budget pause, an offseason, `no DB` in local dev) this is
  // what says so, because a third alert source is a policy change.
  //
  // Scoped to the agents the orchestrator actually IMPORTS, which is the list
  // that can reach runAgent — src/agents/ also holds `shared/` helpers and a
  // staged-but-unwired `nfl.live/`, neither of which runs.
  //
  // Over source rather than by executing the fleet: most agents reach for the
  // network or a DB on the way to their gate, so running all ~50 in a unit
  // test hangs (tried; it does). Comments are stripped first, so prose
  // mentioning the field cannot fail the build.
  const orchSrc = codeOnly(await readFile(new URL('../src/orchestrator/index.js', import.meta.url), 'utf8'));
  const wired = [...orchSrc.matchAll(/^import \w+ from '\.\.\/agents\/([\w.-]+)\/index\.js';$/gm)]
    .map((m) => m[1]);
  assert.ok(wired.length > 40, `expected the whole wired fleet, found ${wired.length}`);
  for (const n of OPTED_IN) {
    assert.ok(wired.includes(n), `${n} must actually be wired into the orchestrator`);
  }

  const optedIn = [];
  for (const name of wired) {
    const code = codeOnly(await readFile(new URL(`../src/agents/${name}/index.js`, import.meta.url), 'utf8'));
    if (/(^|[^\w.])blocked:/.test(code)) optedIn.push(name);
  }
  assert.deepEqual(optedIn.sort(), [...OPTED_IN].sort(),
    'exactly the two agents the spec opted in — a third would be a new alert source');
});
