# Loud agent skips — a run that *could not* do its job is reported

Branch: `feat/loud-agent-skips`. No DDL, no new dependencies, no API-key handling of any kind.

## Problem

`public-splits` has reported `lastResult: "skipped — no Claude"` with `error: null`,
`consecutiveFailures: 0` and `runs: 1` since the Railway deployment lost `ANTHROPIC_API_KEY`
(`hasClaude()`, `src/utils/index.js:116`). `public_splits` wrote 0 rows today against 671 total,
which zeroed the against-public component of every `book-move` score and removed half of what RLM
detection needs — and nothing noticed, because a skip is not a failure: the watchdog, `/data-health`
and the degraded channel all saw a healthy agent. It surfaced only because a `/plays` payload was
read by hand.

## Approach

**Both axes, with the structural one as the opt-in and the temporal one as the filter.**

The survey of ~70 skip sites in `src/agents/*/index.js` shows the distinction already exists in the
summary strings, in two families: *benign* — `no games on the slate`, `dormant — empty slate`,
`offseason — dormant`, `disabled (set NFL_LIVE=true)`, `skipped — protecting odds budget` (~60
sites, all correct and all permanent facts of a season); and *broken* — `skipped — no Claude`,
`skipped — no ODDS_API_KEY`, `skipped — no DB`, i.e. a run that was prevented by absent
configuration and will be prevented identically on every future run until a human acts. The
distinction is structural and it is **already known at the call site**, so the cheapest honest
encoding is to let the call site say so:

```js
if (!hasClaude()) return { summary: 'skipped — no Claude', blocked: 'ANTHROPIC_API_KEY is not set' };
```

`blocked` is a short authored reason string (or `true`, in which case `summary` is used as the
reason). It is **never interpolated from `process.env`** — it names a variable, never a value.

Temporal filter: the orchestrator counts consecutive blocked runs per agent and only reports once
the count reaches a threshold (default **1** — i.e. the first blocked run reports). An agent author
who returns `blocked` is asserting the condition is real, so a second confirming run adds latency
rather than signal. The original rationale for a default of 2 — "a boot-time `detectModel()` 529 is
a transient block" — is self-refuting: `detectModel()` is called exactly once (`src/index.js:476`,
never retried) and `hasClaude()` ANDs it with an `anthropic` client built once at
`utils/index.js:112` module load, so both are immutable for the process lifetime and run 2 confirms
run 1 by construction. For the two opt-ins a blocked run is never transient, and a default of 2
would buy a 4-8h detection delay (`public-splits` `min: 240`, `combat-weighin` `min: 120`) on
exactly the incident this feature exists to catch. `AGENT_BLOCKED_RUNS_MIN` remains for any future
agent whose blocked cause genuinely is transient, and the threshold logic stays pinned at a
non-default value. Hours are deliberately *not* a second
dimension: per-agent cadence already converts runs into time (`public-splits` at 4h → reported
after ~8h), and an hours threshold would need clock mocking to test and would behave differently on
every agent.

**Generality: the plumbing is general, the policy is not inferred.** Any agent opts in with one
field; the orchestrator, watchdog and `/health` know nothing about Claude. Rejected alternatives:

- *A `hasClaude()`-specific check in the watchdog* — needs a second, hand-maintained list of which
  agents are Claude-gated, which will drift from the code the first time an agent is added.
- *Pattern-matching `lastResult` for `/^skipped — no /`* — fragile against copy-editing, and
  wrong: `skipped — no DB` is expected in local dev and `skipped — protecting odds budget` matches
  the same family while being the system working as designed.
- *"Summary unchanged for N runs"* — this would have caught `sharp`'s 13,000-run "no recent line
  movement", but ~30 agents legitimately return a byte-identical summary every run all offseason.
  That is the noise this design cannot afford: `notifyAll` reaches **zero recipients**
  (`ALERT_NUMBERS`/`SMTP_*` unset, deprioritised 2026-10-28), so the only consumers are a human
  reading `/health` and the shelved dashboard, and both are trained by false positives in one week.

Cost of generality accepted: one optional field on an informal return contract, which a future
agent author can forget. Default is quiet — forgetting it reproduces today's behaviour exactly,
never a false alarm.

**Correction to the brief:** only **two** agents are gated by `hasClaude()` — `public-splits:54`
and `combat-weighin:62`. `prop-engine` is code-only (`src/agents/prop-engine/index.js:2`, "no
Claude"); its `skipped —` returns are `ODDS_API_KEY` and budget, and it is **not** changed.
`nfl-win-totals:29` uses `hasClaude()` inside a helper and falls back to a posted table — a
designed partial degrade, not a skip, and not changed.

## Data model / API changes

No schema, no DDL, no new tables or columns, no `scan_runs` fields.

- **Agent run contract (additive, optional):** `{ summary, data?, gamesMonitored?, blocked? }` where
  `blocked` is a non-empty string reason or `true`.
- **Registry / `/health` per-agent (3 new fields):** `blockedRuns: number`,
  `blockedReason: string|null`, `blockedSince: string|null` (ISO).
- **Degraded channel key:** `` `${agent.name}|blocked` `` — first segment is the source, matching
  `write|line_movements` and `data-health|counts`, so the watchdog's existing
  `d.key.split('|')[0]` yields the agent name.
- **Watchdog issue:** `{ key: 'data|<agent>|blocked', type: 'blocked', agent, label: 'Agent
  blocked (<agent>)', detail }`.
- **Config:** `rules.blockedRunsMin`, env `AGENT_BLOCKED_RUNS_MIN`, default `1`.

### Where it surfaces, and why only these

`reportDegraded` → the watchdog's `issues[]` and `/health.system.degraded` (one call reaches both;
`src/index.js:340`, `src/agents/watchdog/index.js:121`). That channel exists for exactly this fault
class — "an agent that succeeds while producing nothing usable" — and the shelved signal dashboard
will render it. The per-agent `/health` fields are the *durable* view. **No fourth mechanism and no
`/data-health` change.**

Known limitation, stated rather than engineered around: `DEGRADED_TTL_MS` is 90 min and
`public-splits` runs every 4h, so a standing blocked condition flickers out of
`/health.system.degraded` between runs. The watchdog's per-day dedup means the alert still fires
once; `blockedRuns` on `/health` never expires and is the number to read. Raising the global TTL is
out of scope.

### Thresholds, and the coercion trap

`config.rules.maxConsecutiveFailures` is a bare literal and the existing `num()`
(`src/config/index.js:18`) is **unsafe for this knob**: `num('', 2) === 0` and `num('  ', 2) === 0`,
because `Number('')` is a finite `0` — the D10/D67/D79 family, and `0` here is a *valid* value
meaning "report on the first blocked run". So add a dedicated reader next to `num`:

```js
// 0 is valid (report on the first blocked run), so '' / '  ' / null must be
// rejected BEFORE coercion — Number('') is a finite 0 (D79 house rule).
function intEnv(v, dflt) {
  const s = clean(v);                 // '' for null/undefined/whitespace/quotes
  if (s === '') return dflt;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : dflt;
}
```

Do **not** change `num` itself (40+ call sites). `WATCHDOG_FAIL_MIN` and `DEGRADED_TTL_MS` carry
the same `Number(env) || default` trap; left alone, noted under Risks.

### Clearing — and why it cannot latch

Three independent clears, in order of how fast they fire:

1. **Any non-blocked successful run** resets `blockedRuns`/`blockedReason`/`blockedSince` and calls
   `clearDegraded()` *unconditionally* (a `delete`, idempotent, safe when nothing is set). Setting
   the env var and redeploying therefore clears on the agent's first run — including when that run
   is a benign skip, which is correct: the agent is no longer asserting that it is broken.
2. **A thrown run** does the same, because the error path owns the reporting and a stale blocked
   entry would double-report with an obsolete reason (this is the D73 lesson: an unretracted
   `reportDegraded` latches for the full TTL).
3. **The 90-min TTL** expires anything that stops being re-reported.

Nothing is required to remember to clear: the clear is on the *default* branch of the success path.

### Is "monitored table at zero today" a second signal? No — redundant, dropped.

`public_splits: {today: 0}` is equally true on an offseason morning, before the day's first run, and
during a budget pause. Separating those from "broken" requires exactly the per-agent knowledge
`blocked` already carries, plus a hand-maintained table→agent→expectation map. `/data-health`
already prints the counts for a human; that number belongs in the *diagnosis* step after an alert,
not in detection. **Not built.**

## File-by-file plan

1. **`edge-tracker-agents/src/config/index.js`** — add `intEnv` beside `num` (line ~18) with the
   comment above; add `blockedRunsMin: intEnv(env.AGENT_BLOCKED_RUNS_MIN, 1)` inside `rules` beside
   `maxConsecutiveFailures` (line ~350), commented as "consecutive runs an agent may report itself
   blocked before it is reported; 0 = report the first one".
2. **`edge-tracker-agents/src/orchestrator/index.js`** —
   - import `reportDegraded, clearDegraded` from `../store/index.js` (line 9).
   - `initRegistry` (line ~138): add `consecutiveBlocked: 0, blockedReason: null, blockedSince: null`.
   - `getHealth` (line ~154): add `blockedRuns: r.consecutiveBlocked, blockedReason: r.blockedReason,
     blockedSince: r.blockedSince`.
   - success path, after `r.runs++` (line 183) and **after** `r.lastRunAt` is set: normalise
     `const blocked = out.blocked === true ? summary : (typeof out.blocked === 'string' && out.blocked.trim() ? out.blocked.trim() : null);`
     then increment-and-report or reset-and-`clearDegraded(`${agent.name}|blocked`)` as specified in
     *Clearing*. Report with
     `reportDegraded(`${agent.name}|blocked`, `not doing its job — ${blocked} (${r.consecutiveBlocked} consecutive runs since ${r.blockedSince})`)`
     and one `logger.warn(agent.name, ...)` per reported run. Log the transition back with
     `logger.info` when `consecutiveBlocked > 0` and the run is not blocked.
   - catch path (line ~210): reset the three fields and `clearDegraded` the same key.
   - Carry a short comment saying the reason string is authored at the call site and never read from
     `process.env`, so no credential can reach a log or a payload.
3. **`edge-tracker-agents/src/agents/public-splits/index.js`** — line 54 only, add
   `blocked: 'ANTHROPIC_API_KEY is not set in this deployment'`. No other change.
4. **`edge-tracker-agents/src/agents/combat-weighin/index.js`** — line 62, identical change. No
   other change.
5. **`edge-tracker-agents/src/agents/watchdog/index.js`** — in the `getDegraded()` loop (line 121),
   branch on `d.key.endsWith('|blocked')` for `type: 'blocked'` and `label: `Agent blocked
   (${agent})``; keep the `key: `data|${d.key}`` prefix so the per-day dedup set is unchanged.
6. **`edge-tracker-agents/test/agent-blocked.test.js`** (new) — see Test plan; follow
   `test/watchdog.test.js`'s `mock.module` + real-store pattern, no new harness.
7. **`tools/smoke.mjs`** — new section "13. Blocked-agent reporting" after section 12 (line ~420),
   reading `orchSrc`, `cfgSrc`, `storeSrc` (all three are already loaded at lines 218/226/227) plus
   `splitsSrc` (line 351) and a new read of `combat-weighin/index.js`. Assertions listed below.
8. **`DECISIONS.md`** — append `D80` dated 2026-11-04: the structural-plus-temporal choice, the
   two rejected generalisations, the table-level verdict, and `intEnv` vs `num`.
9. **`HANDOFF.md`** — rewrite at `/wrap`; the live condition is still open until Blake sets the env
   var, and that must be the top next step.

## Risks & open questions

1. **For Blake, the only action that fixes production:** set `ANTHROPIC_API_KEY` in the Railway
   deployment. This spec deliberately contains no key, no prefix and no code path that reads or logs
   one; the implementation must not add one.
2. **Threshold 1, not 2** (changed in review). There is no transient class for the two opt-ins —
   `detectModel()` is never retried and the Claude client is built once at module load — so a
   confirming run is pure latency. `AGENT_BLOCKED_RUNS_MIN=2` restores the old behaviour if a
   future agent's blocked cause really is transient.
3. **TTL vs cadence** (above): the degraded entry flickers for agents slower than 90 min. Accepted;
   `blockedRuns` is the durable number. Open question: bump `DEGRADED_TTL_MS` globally to ~6h?
4. **Three more agents could opt in cheaply** — `odds:719`, `clv-tracker:251`/`book-move:368`
   (`no DB`) and the `no ODDS_API_KEY` family. Deliberately **not** done: `no DB` is normal locally
   and the budget gates are the system working. Left as a judgement call per agent.
5. **`WATCHDOG_FAIL_MIN` / `DEGRADED_TTL_MS` keep the `Number(env) || default` trap.** Not touched
   here; worth a standing grep (D67).
6. **The alert still reaches nobody.** Everything above lands in `issues[]` and `/health`; the SMS/
   email path has zero recipients. This fix makes the condition *readable*, not *pushed*.

## Test plan

**`edge-tracker-agents/test/agent-blocked.test.js`** (mock `config`, `db`, `utils`; use the real
store so `getDegraded`'s TTL logic is exercised, as `watchdog.test.js` does):

1. A benign skip (`{ summary: 'no games on the slate' }`) reports nothing, ever — run it 5× and
   assert `getDegraded()` is empty. *The anti-noise assertion; keep this one above all.*
2. At the shipped default the *first* blocked run reports exactly one entry keyed
   `<agent>|blocked`, whose detail contains the reason and the run count; with `blockedRunsMin = 2`
   the first run is held back and the second reports (the threshold logic at a non-default value).
3. `blocked: true` uses `summary` as the reason.
4. A non-string, non-`true` `blocked` (e.g. `1`, `{}`) is ignored — no report.
5. **Clearing:** blocked ×3, then a normal success → `getDegraded()` empty and `blockedRuns === 0`.
   Then blocked ×3, then a *benign skip* → also empty. Then blocked ×3, then a **throw** → empty,
   and the error path still sets `consecutiveFailures`.
6. `AGENT_BLOCKED_RUNS_MIN=0` reports on the first blocked run; `''` and `'  '` fall back to the
   default (direct `intEnv` unit assertions — the D79 regression). Plus one **child-process** test
   that sets the variable in the child's `env` and reads `config.rules.blockedRunsMin` back: the
   in-process tests mutate the field on the loaded object and so cannot tell `intEnv(env.X, 1)`
   from a re-introduced `intEnv(env.X, 1) || 1`.
7. `getHealth()` exposes `blockedRuns`/`blockedReason` and they survive across runs.
8. Watchdog: a `foo|blocked` degraded entry produces an issue with `type: 'blocked'`, `agent: 'foo'`
   — add to `test/watchdog.test.js` rather than duplicating its fixture.
9. No reason string anywhere in the suite contains an env *value*. Asserted **behaviourally**:
   with a sentinel under the real variable's name in `process.env`, the published `detail` must
   *equal* a closed template over the authored reason plus the count and the streak start, so
   nothing else can be in it — a source grep would miss a credential arriving via an import. The
   remaining source checks (here and in smoke) run over **comment-stripped** code, so prose about
   the constraint cannot fail the build.
10. `blockedSince` latches the first run of a streak — asserted with the runs **separated in time**,
   since three runs inside one millisecond make the assertion vacuous. A change of reason restarts
   the count, `blockedSince` and the store entry.

**`tools/smoke.mjs`** section 13 (static assertions, each with a `detail` saying what breaks):

- `public-splits` and `combat-weighin` both mark their Claude gate `blocked:` — the two opt-ins.
- the orchestrator resets and `clearDegraded`s on the non-blocked branch — "an unretracted
  reportDegraded latches for the full TTL (D73)".
- the orchestrator also clears in the catch path.
- the default is `1`, and the threshold is read with `intEnv(` and not `num(`/`||` — "`Number('')
  || 1` is 1, so `AGENT_BLOCKED_RUNS_MIN=0` would be silently ignored (D79)".
- `blockedSince` is guarded by `if (!r.blockedSince)`, and a reason change resets the streak.
- the degraded key is `` `${agent.name}|blocked` `` — "the watchdog derives the agent from
  `key.split('|')[0]`; a `blocked|<agent>` key reports an agent called 'blocked'".
- neither the orchestrator nor the two agents reference `ANTHROPIC_API_KEY` via `process.env`, and
  `src/orchestrator/index.js` contains no `apiKey` — "the reason is authored, never read". Over
  **comment-stripped** source, and backed by the behavioural closed-template assertion above,
  because a source grep cannot see a credential that arrives through an import.
- `/data-health` is unchanged (no new table-level probe) — pins the explicit decision above.

Verifier: `cd edge-tracker-agents && npm test` → 132 tests, 129 passing, with the same 3
pre-existing environmental `degradation-channel` failures; `node tools/smoke.mjs` → 127 passed,
0 failed.

## Manual check recipe

1. `lsof -nP -iTCP -sTCP:LISTEN` — a Pool Room Pro Electron process holds 4317-4318 and Vantyx holds
   3000. Pick a free port for step 2 and use it explicitly; `npx serve` silently falls back to a
   random one. *Proves nothing about this feature — it stops you reading a stale server.*
2. From `edge-tracker-agents/`, with **no `ANTHROPIC_API_KEY` in the environment** (`env | grep -c
   ANTHROPIC` → `0`; do not print the variable) and no `AGENT_BLOCKED_RUNS_MIN` set, so the shipped
   default of 1 reports on the first blocked run: `PORT=<free> node src/index.js`. Startup logs `No ANTHROPIC_API_KEY — Claude-backed
   agents will be skipped.` *That line is pre-existing: it proves the gate is closed, not that the
   condition is reported.*
3. **DECISIVE.** After `public-splits` has run once (watch for `skipped — no Claude` in the log),
   `curl -s localhost:<free>/health | jq '.system.degraded, (.agents[]|select(.name=="public-splits")|{lastResult,blockedRuns,blockedReason})'`.
   Expect one `public-splits|blocked` entry and `blockedRuns: 1`. *This is the whole feature: the
   exact live state that read healthy now reads broken.*
4. Wait for the watchdog's pass (or restart with a short watchdog cadence) and
   `curl -s localhost:<free>/plays | jq '.watchdog.issues[]|select(.type=="blocked")'`. *Proves the
   alertable terminus, i.e. the dashboard-facing surface — not the detection logic, which step 3
   already settled.*
5. **Clearing, without a key:** leave the key unset and instead stop the process, restart and
   confirm step 3 again; then set `AGENT_BLOCKED_RUNS_MIN=99`,
   restart, and confirm `.system.degraded` is empty while `blockedRuns` still climbs. *Proves the
   threshold governs. It does **not** prove the self-clear on recovery* — that needs a working key
   and is covered only by test 5, which is why that test is mandatory.
6. `curl -s localhost:<free>/data-health | jq '.tables[]|select(.table=="public_splits")'` — still
   `today: 0`. *Confirms the symptom is real and that we deliberately did not build a check on it.*

## Follow-up phases

**`sharp` history reader** (`docs/specs/sharp-history-reader.md`, shelved). `sharp` has returned "no
recent line movement" across 13,000+ runs because it reads only the newest odds run's array. It is
the same invisibility class but the opposite encoding: a *benign-looking* summary that is in fact
broken, which `blocked` cannot express without `sharp` knowing it is wrong. Fix the reader; do not
stretch this mechanism to cover it.

**Signal dashboard** (`docs/specs/signal-dashboard.md`, shelved). It will render
`watchdog.issues[]`, so `type: 'blocked'` and the `Agent blocked (<name>)` label are the fields it
filters on — the reason they are specified here rather than left to the detail string.

**`applyAgentsBag` in `index.html`** swallows failed reads with `.catch(() => ({}))` and then guards
with `if (bag.X)`, so a 500 renders identically to an empty section. That is the front-end instance
of the same pattern and the third one found this session; it needs its own fix, not this one.

**Watchdog alerts still reach zero recipients.** `notifyAll` needs `ALERT_NUMBERS` or `SMTP_*`
(deprioritised 2026-10-28). Until that is set, everything here is loud only to someone who opens
`/health` — which caps the value of this work, and is the single highest-leverage item left.
