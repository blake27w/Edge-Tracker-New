---
name: feature
description: Full agentic feature pipeline — architect designs a spec, user approves it once, then builder → reviewer (max 2 fix rounds) → tester run unattended, ending with a 2-minute manual check recipe and /wrap. Use for any feature or change bigger than a one-file tweak.
---

Run the feature pipeline for: $ARGUMENTS

You are the orchestrator. Stay thin: delegate all heavy reading and writing to the agents below (spawn each via the Agent tool with the matching subagent type), and carry only their conclusions forward. Do not read source files yourself.

1. **Design** — spawn `architect` with the feature request (and any `docs/inbox/` file the user referenced). It returns a spec path + summary.
2. **APPROVAL GATE (the only one)** — show the user the spec summary and path. Wait for explicit approval. If they request changes, re-run architect with the feedback. Do not proceed without approval.
3. **Build** — spawn `builder` with the spec path. Relay its file list + status.
4. **Review loop (max 2 rounds)** — spawn `reviewer`. If it reports CONFIRMED findings, spawn `builder` to fix exactly those findings, then re-run `reviewer` once. After round 2, remaining findings go in the final report — do not loop again.
5. **Test** — spawn `tester` with the spec path. This repo has no test suite; if the spec did not call for bootstrapping one, have the tester verify by eye against the live endpoints instead and say so. If it reports unfixable reds, stop and report.
6. **Manual check recipe** — do NOT spawn `verifier` (retired — see `.claude/agents/verifier.md`) unless the user explicitly asks for it this session. Instead, write a 2-minute manual check recipe: exact commands to launch, what to click/tap, and the expected result — the user is the verifier of record.
7. **Wrap** — run the /wrap skill.

Final report to the user: what shipped, review findings (fixed and open), test result, the manual check recipe, commit hash. Keep it under 20 lines.
