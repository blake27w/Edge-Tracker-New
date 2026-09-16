# Edge Tracker

Sports betting edge tracker. Static PWA (`index.html`, `sw.js`, `manifest.webmanifest`) deployed via Vercel (`vercel.json`), with an iOS app in `ios-app/`, research/automation agents in `edge-tracker-agents/`, and docs in `docs/`. GitHub remote: `origin/main` (PRs merged, e.g. #120).

**This is the canonical Edge Tracker repo.** Stale copies exist at `~/edge-tracker/` (old May-era tree, incl. a nested `Edge-Tracker-New`) and in `~/Desktop/Projects/Edge Tracker/_archive/` — never edit those.

Desktop launchpad: `~/Desktop/Projects/Edge Tracker/code` symlinks here.

## Session continuity

- **Start every session by reading `HANDOFF.md`** — current state and next steps.
- **End every session by rewriting `HANDOFF.md`** (replace, don't append) with current state, in-flight work, and next steps.
- **Log every significant decision in `DECISIONS.md`** — append-only, dated, with the why.

## Run & test commands
- Static PWA: serve root with `npx serve .` (or open via vercel dev); verify in Chrome.
- No test suite yet — tester agent should bootstrap one if asked.
- GitHub flow: work on branches, PR to `origin/main`.

## Agentic workflow

- **/kickoff** at session start; **/wrap** at session end. One task per session; never ride into auto-compaction.
- **/feature <desc>** — architect spec → your one approval → builder → reviewer (≤2 fix rounds) → tester → verifier → /wrap.
- **/fix <bug>** — tester reproduces → builder patches root cause → tester+verifier confirm → /wrap.
- Agents in `.claude/agents/`; specs in `docs/specs/`; long content goes in `docs/inbox/` (never pasted into chat).
