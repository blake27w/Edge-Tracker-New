---
name: kickoff
description: Start a session — read HANDOFF.md and recent decisions, state where the project stands in one paragraph, then ask for the single task. Use at the start of every working session.
---

Session start procedure — do exactly this, nothing more:

1. Read `HANDOFF.md`.
2. Read the last ~10 entries of `DECISIONS.md`.
3. Run `git status -sb` and `git log --oneline -5`.
4. Do NOT read source files, specs, or anything else yet.

Then output:
- One short paragraph: where the project stands and what HANDOFF says is next.
- One line flagging any surprise (uncommitted changes, HANDOFF stale vs. git log).
- Ask: "What's the single task for this session?" — then wait.

Context discipline for the rest of the session: one task per session; anything longer than a paragraph the user wants to share goes in `docs/inbox/` and gets read from there; delegate broad exploration to subagents; when the task is done, run /wrap.
