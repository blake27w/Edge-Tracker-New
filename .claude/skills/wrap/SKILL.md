---
name: wrap
description: End a session — commit the work, rewrite HANDOFF.md with current state, append decisions to DECISIONS.md, then confirm it's safe to close. Use before ending every working session.
---

Session end procedure:

1. `git status` — if there is uncommitted work that belongs to this session's task, commit it with a clear message (branch first if on a default branch with unrelated changes). List anything deliberately left uncommitted.
2. Rewrite `HANDOFF.md` completely (replace, don't append):
   - Last updated: <date> + one-line session summary
   - Current state — what works now, what's deployed/committed
   - In flight — anything half-done, with the exact next step
   - Next steps — ordered, concrete
3. Append any decisions made this session to `DECISIONS.md` (format: `D<n> (YYYY-MM-DD) — decision — why`). Skip if none.
4. If a spec in `docs/specs/` was fully shipped, mark it `[SHIPPED <date>]` in its title line.

Then output: commit hash(es), the new HANDOFF "Next steps" verbatim, and "Safe to close."
