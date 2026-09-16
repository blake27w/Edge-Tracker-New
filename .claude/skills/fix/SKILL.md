---
name: fix
description: Short-path bug pipeline — tester reproduces and diagnoses, builder patches the root cause, verifier confirms in the real app, then /wrap. Use for bug reports; use /feature for new functionality.
---

Run the bug-fix pipeline for: $ARGUMENTS

You are the orchestrator — delegate, don't dig in yourself. No approval gate: bugs get fixed.

1. **Diagnose** — spawn `tester` with the bug report (read any `docs/inbox/` file the user referenced and pass its content). It must reproduce the bug (ideally as a failing test) and identify root cause. If it can't reproduce, stop and report what it tried.
2. **Patch** — spawn `builder` with the diagnosis. Root-cause fix only, no drive-by refactors.
3. **Confirm** — spawn `tester` to run the suite (failing test now green, nothing else broken), then `verifier` to exercise the fixed flow in the real app.
4. **Wrap** — run the /wrap skill.

Final report: root cause in one sentence, the fix, test + verifier results, commit hash.
