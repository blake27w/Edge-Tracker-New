# Edge Tracker — Session Handoff

Last updated: 2026-10-17 — shipped `book-move`: per-book line-movement attribution (which books move, which way, how early, and whether against the public).

## Current state

Branch `feat/line-move-all-sports`, not yet PR'd to `origin/main`. Based on `main` (`59b94bd`) plus a cherry-pick of `tools/smoke.mjs` (`1abee02`, originally `630d22c` on `feat/function-first-games`).

**What shipped — the `book-move` agent** (`edge-tracker-agents/src/agents/book-move/index.js`, 15-min cadence, 🧲):

- Reads `line_snapshots` history (NOT `line_movements` — see D17) and derives, per book: direction, magnitude, how early relative to kickoff, whether the move crossed a key number, whether it moved against market-wide public consensus, and whether the book **led or followed** the field to that line level.
- Scores each episode `100 × Σ(wᵢvᵢ) / Σ(wᵢ)` over only the components that apply — 0.30 magnitude / 0.20 key-number / 0.15 early / 0.20 vs-public / 0.15 lead, `MIN_SCORE=35`, all in one env-tunable `W` object.
- Derives book reputation (`market-maker` / `follower` / `mixed`) from the trailing 14 days of `book_move_log`; never hardcoded. `small` flag discloses n < 20.
- **Zero Odds API spend**, enforced by a smoke assertion that the agent source contains no `fetch(`. All inputs are the in-memory slate plus bounded Supabase reads (≤48 snapshot queries + 2, per run).
- Surfaces as a 🧲 BOOK MOVEMENT section on the **Agents** tab in `index.html`, plus top-level `/plays.bookMoves`. `book_move_log` added to `/data-health`'s monitored tables; `line_movements` deliberately NOT added (its count is the slow kind already timing out that endpoint).

Supporting changes: `agents/shared/key-numbers.js` (extracted from `key-number/index.js` so the two cannot drift), `book_move_log` DDL + two indexes in `scripts/schema.sql`, store slot, orchestrator/config registration, `scripts/migrate.js`.

## Verified vs unverified

- **Verified:** `node tools/smoke.mjs` → **60 passed / 12 failed**, and the 12 are confirmed pre-existing on untouched HEAD (proved by `git archive HEAD` into a temp dir and running HEAD's own harness — byte-identical failure list). They are stale assertions about a Games view that no longer exists in `index.html` and a renamed server const (`isLocalDev` → `okOrigin`). **The smoke harness is stale, not broken by this change — worth a cleanup session.** Separately, 97 behavioral assertions passed against the real agent source loaded with only its import block stubbed (`node_modules` is absent in the worktree). `node --check` clean on every changed file.
- **Unverified:** no live run. `book_move_log` DDL has not been applied in Supabase, so the agent cannot persist anything yet — that is step 1 below.

## Review and test history

A reviewer found **9 confirmed defects**, all fixed. The serious ones, for the record: `led` meant "line differs from the batch median" (so it rewarded books that *disagreed* with the market — the metric was inverted); every move was emitted twice, once per side; the 14-day scorecard double-counted the current window, clearing the n≥20 gate on half the evidence; key-number crossing was dead code on totals (`KEYS` are 3-17, totals are 30-60); and a missing public-data input was scored identically to an adverse one, which systematically filtered out every sport outside NHL/NBA/MLB/NFL. The tester then found one more: `crossedKey(null, 3.5)` returned `3`, because `Number(null)` is a finite `0` and the guard meant to reject junk let a missing line through as a pick-em.

## In flight

Nothing half-done in the code. Two loose ends:

1. **A WIP checkpoint commit (`63ef58e`) landed on this branch from outside this session**, and the branch has an `origin` upstream it did not start with. The content is this session's work and `node --check`/smoke are green on it, but **nobody in this session pushed it** — worth confirming it was the harness's auto-checkpoint and not a stray push before opening the PR.
2. **No PR opened yet.** Project norm is branch + PR to `origin/main`, never direct.

## Open design question for Blake

`rankLevels` clusters arrivals by **line level + time** (6h gap rule) but **not by direction**. Two books converging on `-3.5` from opposite sides — one drifting `3→3.5`, one `4→3.5` — get ranked against each other, and the earlier is credited `led:true` even though they are not the same market move. This inflates `led_pct` on choppy markets. Left unfixed deliberately: the spec defines `led` purely as arrival order at a level, so adding a direction predicate changes the metric rather than correcting a defect. **Your call.**

## Known ceilings (inherent to the data — see D22)

- `public_splits` has **no `book` column**, so "which books get hit by the public" is market-wide only. A true per-book public split is not derivable from what we collect.
- The book list is **11 licensed US retail books with no originating book** (no Pinnacle, Circa, or exchange), so "led the field" measures which retail book copies the true market fastest — not who sharps actually bet with. Closing this means adding an originating book to the odds feed, which costs API spend.

## Next steps

1. **Apply the `book_move_log` DDL in Supabase** — SQL Editor → paste the new block from `edge-tracker-agents/scripts/schema.sql` (idempotent, `if not exists`) → Run. The agent cannot persist episodes until this exists.
2. **Run the manual check recipe** in `docs/specs/book-movement-attribution.md`. Before debugging anything, run `lsof -nP -iTCP -sTCP:LISTEN` — a Pool Room Pro Electron process holds 4317-4318, Vantyx holds 3000, and `npx serve` silently falls back to a random port, which has cost real time twice now.
3. **Answer the `rankLevels` direction question above**, then open the PR to `origin/main`.
4. **Expect ~2 weeks of noisy `role` values.** Book reputation is derived, so it bootstraps from nothing; the `small` flag (n < 20) discloses it. Do not tune the weights off the first fortnight.
5. **Phase (b): persist the `lastLines` baseline** (`odds/index.js:162` is a process-local Map, so every redeploy blinds movement detection and leaves `line_movements` sparse). Makes this feature's data denser.
6. **Phase (c): point `sharp`/`public-splits` steam detection at a history reader** instead of `getIntel('movements')`, the in-memory array from only the most recent odds run — which is why `sharp` has reported "no recent line movement" across 13,028 runs.
7. **Phase (a), now deferred: generalize open→close movement to all 12 sports** — spec already written at `docs/specs/line-move-all-sports.md` (store shape and agent-rename decisions already made in it).
8. **Clean up the stale smoke assertions** (the 12 baseline failures above) so the harness goes green and future regressions are visible.
9. Still owed from the September session: the `migrate-research.sql` Supabase migration, and Railway vars `NCAAF_MODEL=true` / `NFL_LIVE=true` / `ODDS_SKIP_SPORTS=SOCCER,WNBA,BOXING`.

## Do not touch

- **PR #129** (`feat/function-first-games`) — unmerged PWA navigation reorg. Carries `D8`-`D16` and the original `tools/smoke.mjs`. This session's decisions were renumbered to **D17-D22** to avoid colliding with it; `DECISIONS.md` will need one reconciliation pass when #129 and `fix/silent-data-integrity-faults` (which ends at D14) both land.
- `~/edge-tracker/` and `~/Desktop/Projects/Edge Tracker/_archive/` — stale copies.
