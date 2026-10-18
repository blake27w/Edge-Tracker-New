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

- **Verified:** `node tools/smoke.mjs` → **61 passed / 12 failed**, and the 12 are confirmed pre-existing on untouched HEAD (proved by `git archive HEAD` into a temp dir and running HEAD's own harness — byte-identical failure list). Root cause (confirmed by the session on PR #131, which authored that harness's branch): `tools/smoke.mjs` was cherry-picked **from #129**, so it asserts #129's `index.html` — the Games tile, `renderHomeGames`, `gamesCache`, `spOverride`, etc. — which is not on `main` yet. The view doesn't exist *yet*; it is not a view that was removed. **These are not ours to fix: they should clear on their own once #129 merges and this branch is rebased on `main`.** Separately, 97 behavioral assertions passed against the real agent source loaded with only its import block stubbed (`node_modules` is absent in the worktree). `node --check` clean on every changed file.
- **Unverified:** no live run. `book_move_log` DDL has not been applied in Supabase, so the agent cannot persist anything yet — that is step 1 below.

## Review and test history

A reviewer found **9 confirmed defects**, all fixed. The serious ones, for the record: `led` meant "line differs from the batch median" (so it rewarded books that *disagreed* with the market — the metric was inverted); every move was emitted twice, once per side; the 14-day scorecard double-counted the current window, clearing the n≥20 gate on half the evidence; key-number crossing was dead code on totals (`KEYS` are 3-17, totals are 30-60); and a missing public-data input was scored identically to an adverse one, which systematically filtered out every sport outside NHL/NBA/MLB/NFL. The tester then found one more: `crossedKey(null, 3.5)` returned `3`, because `Number(null)` is a finite `0` and the guard meant to reject junk let a missing line through as a pick-em.

## In flight

Nothing half-done in the code. Two loose ends:

1. **`63ef58e` and the `origin` upstream are explained — resolved, no action.** The session on PR #131 was asked to clean up this branch, which from outside looked redundant (its only commit was byte-identical to #129's smoke-harness commit). It tried to delete the branch; git refused because this worktree held it, which is the only reason the uncommitted feature survived. It then committed the tree as a WIP checkpoint and pushed, deliberately opening no PR. Nothing was rebased, squashed or discarded.
2. **No PR opened yet.** Project norm is branch + PR to `origin/main`, never direct.

## Resolved this session

`rankLevels` now groups arrivals by **line level + direction**, not level alone. Two books converging
on the same number from opposite sides (one drifting -3 → -3.5, one -4 → -3.5) are no longer ranked
against each other — they are not the same market move, and ranking them together credited whichever
arrived first with a lead it never earned, inflating `led_pct` on choppy markets. Blake's call,
2026-10-17. Verified behaviorally (both converging books come back `lead_rank 1, led false`, one
episode per direction) and guarded by a smoke assertion proven to fail when the grouping key is
reverted. The 97-case behavioral suite still passes, so the genuine-lead, tie, lone-book and
revisited-level cases are unaffected.

## Known ceilings (inherent to the data — see D22)

- `public_splits` has **no `book` column**, so "which books get hit by the public" is market-wide only. A true per-book public split is not derivable from what we collect.
- The book list is **11 licensed US retail books with no originating book** (no Pinnacle, Circa, or exchange), so "led the field" measures which retail book copies the true market fastest — not who sharps actually bet with. Closing this means adding an originating book to the odds feed, which costs API spend.

## Next steps

1. **Apply the `book_move_log` DDL in Supabase** — SQL Editor → paste the new block from `edge-tracker-agents/scripts/schema.sql` (idempotent, `if not exists`) → Run. The agent cannot persist episodes until this exists.
2. **Run the manual check recipe** in `docs/specs/book-movement-attribution.md`. Before debugging anything, run `lsof -nP -iTCP -sTCP:LISTEN` — a Pool Room Pro Electron process holds 4317-4318, Vantyx holds 3000, and `npx serve` silently falls back to a random port, which has cost real time twice now.
3. **Open the PR to `origin/main`** — the `rankLevels` direction question is resolved (see above); nothing else is blocking it.
4. **Expect ~2 weeks of noisy `role` values.** Book reputation is derived, so it bootstraps from nothing; the `small` flag (n < 20) discloses it. Do not tune the weights off the first fortnight.
5. **Phase (b): persist the `lastLines` baseline** (`odds/index.js:162` is a process-local Map, so every redeploy blinds movement detection and leaves `line_movements` sparse). Makes this feature's data denser.
6. **Phase (c): point `sharp`/`public-splits` steam detection at a history reader** instead of `getIntel('movements')`, the in-memory array from only the most recent odds run — which is why `sharp` has reported "no recent line movement" across 13,028 runs.
7. **Phase (a), now deferred: generalize open→close movement to all 12 sports** — spec already written at `docs/specs/line-move-all-sports.md` (store shape and agent-rename decisions already made in it).
8. **After #129 merges, rebase this branch on `main` and re-run smoke** — the 12 baseline failures should clear by themselves, because they are #129's own assertions running without #129's `index.html`. Do **not** rewrite those assertions; that would delete #129's coverage.
9. Still owed from the September session: the `migrate-research.sql` Supabase migration, and Railway vars `NCAAF_MODEL=true` / `NFL_LIVE=true` / `ODDS_SKIP_SPORTS=SOCCER,WNBA,BOXING`.

## Do not touch

- **PRs #129, #130 and #131 are all open and unmerged**, and `main` is still at `59b94bd` — so anything rebased onto `main` today includes none of them.
- **PR #129** (`feat/function-first-games`) — unmerged PWA navigation reorg. Carries `D8`-`D16` and the original `tools/smoke.mjs`. This session's decisions were renumbered to **D17-D22** to avoid colliding with it; `DECISIONS.md` will need one reconciliation pass when #129 and `fix/silent-data-integrity-faults` (which ends at D14) both land.
- `~/edge-tracker/` and `~/Desktop/Projects/Edge Tracker/_archive/` — stale copies.
