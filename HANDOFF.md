# Edge Tracker — Session Handoff

Last updated: 2026-11-06 — **#140–#145 merged (`main` at `5b92d70`); one PR open: the 📊 Splits tab (`feat/splits-report`). 388 tests / 287 smoke on that branch, zero failures.** Three things remain on Blake's side: credits + one redeploy, the five-line DDL for #145, and the first-day watch list.

## The Splits tab (PR open)

Blake asked for "a place to view the public splits on lines, like the reports Ewing gives us" (BetMGM's Sportsbook Data Insights sheet), then "just a tab where I can see this info", then "click between books and see their splits". **Per-book ticket/money splits do not exist in this system** (D53 — `public_splits` has no book column; the percentages are Claude-read and market-wide), so the book switcher changes **lines and movement only** and the card says so. Decisions in D101. Two characterised, non-blocking behaviours to carry forward:

- The Plays → Splits chip repaints through `renderAgentsContent`, which has no `splitsDomSave/Restore`, so the per-book `<details>` snaps shut on each 30-s poll **there** (not on the Splits tab).
- The per-game opener memo keeps a book whose first rows were in a lost tail chunk (D99) at `—` until kickoff+6h or a restart; a per-book re-read is the follow-up.

**Before credits exist the tab shows live lines with `—` percentages** under a banner quoting the real `blockedReason` from `/health` — never a blank table, never `0%`. Credits + one redeploy is what lights it up.

## DO THIS, IN THIS ORDER

1. **Review + commit + PR** `feat/splits-report` → `main`. Commit message should name D101. `DECISIONS.md` is append-only — D101 is the last entry.
2. **Add Anthropic credits, redeploy once** (D81: the model probe runs only at boot). Then the decisive check from the spec's manual recipe step 7: wait for a `public-splits` run, open 📊 Splits — both-side percentages, the ≥5-point side in mint, flags, `no line data` where `rlm`/`freeze` are null; switch books — percentages do not move. `curl /splits | jq .splits_meta` → `source: "memory"`; restart Railway, curl within 10 min → `source: "db"`.
3. **Watch after deploy:** `/plays | jq '.bookMoves.openers_meta'` → `selects` ≤ 72 on the first run, then ~0 (memo); `failures` 0. `/splits | jq '.games[0].open'` non-null once `nfl-line-move` has run (90-min cadence — a new game shows `open —` for up to one run).
4. The unchanged items from the previous handoff still stand: hand-run DDL for `nfl_line_moves` (see git history of this file / D95), watchdog recipients, Odds API tier question.

## Known follow-ups (none blocking)

1. **Per-book splits are a sourcing decision, not a build** (spec Follow-up 1): the switcher honestly changes lines only; a per-book count needs N insight pages read by Claude every 4 h — ToS + cost per book, Blake's call.
2. Launcher is a 2-column grid; nine tiles leaves one orphan cell (spec Risk 1 — accepted as-is; `.launch-btn:last-child:nth-child(odd){grid-column:1/-1}` is the one-line alternative).
3. Per-book coverage is `book-move`'s 24-game window; the chip's `<small>` count discloses the gap. Raising `BOOK_MOVE_MAX_GAMES` is an env + `line_snapshots` load decision.
4. `.claude/launch.json` serves on 3000, which another node process holds on this machine — the manual check was done with `npx serve . -l 8787`.
5. Earlier follow-ups: `tennis-ingest`/`tennis-close` unchunked snapshot writes (D99 idiom); `book-move:127` reads `bets_pct` with `Number()`; steam breaker probe pinned to the soonest game; watchdog alerts reach zero recipients.

## House rules (unchanged, still earned)

- `Number('')`, `Number(null)`, `Number(false)` are a finite `0`, and `0` is never neutral here. **Type-check before coercing.** A missing percentage or opener is `null`/absent and renders `—`.
- **"Nothing happened" and "I cannot see it" must never look the same.** `off` is read from the agent's own `blockedReason`, never inferred from an empty array.
- **A `blocked` reason is a constant literal** (D80).
- **Baseline is zero failing tests** (D82). No expected-failure allowance.
- **Read live config from the running service, not the repo** (D92).
