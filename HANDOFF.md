# Edge Tracker — Session Handoff

Last updated: 2026-11-04 — **movement-baseline rehydration built and tested on `feat/persist-movement-baseline`; PR open, two `alter table` statements owed.**

## Current state

`main` is at `50b4fbb`. `#129` `#130` `#131` `#132` `#133` `#134` `#135` are all merged and the
Supabase migration is run. One branch in flight: `feat/persist-movement-baseline` (`f259b95`).

**What this branch does.** `lastLines` in `odds/index.js` was a process-local Map, so every redeploy
wiped the line-movement detection baseline and the first run after a restart reported `0 movements`
— confirmed live. It now rehydrates lazily from `line_snapshots`: one bounded `select` per
game × market on `line_snapshots_game_idx` (verified applied, not merely present in `schema.sql` —
see D70), **240 queries once per process, 48 in steady state**. Zero new Odds API spend; no
`fetch(` in the hydration path, pinned by smoke. A persisted `line_baseline` table was rejected —
~4,000 upserts every run to save a once-per-process read (D71).

Guards, each added because a review found the previous fix's failure mode (D72, D76–D79):

- **360-min staleness bound** — beyond it the entry reseeds and counts `stale-baseline` rather than
  emitting a fictional single hop.
- **Failed reads are not recorded as hydrated** — one transient timeout at boot used to disable
  rehydration for the life of the process, silently.
- **Circuit breaker at 3 consecutive all-failed runs** — the fix for the above had the opposite
  failure: 240 timing-out selects every run, before any `normalize()`, while the orchestrator
  awaits `odds` ahead of every other agent.
- **Two movement feeds** — `getIntel('movements')` is gap-filtered for `sharp` (which reads
  co-directional rows as *steam*, i.e. simultaneity; a 5-hour drift is not steam), and
  `getIntel('movementsAll')` is complete for `public-splits` (which asks whether the number moved,
  and read a withheld row as a *freeze*). `line_movements` still gets every row.
- **Eviction at kickoff + 6h** — the Map was never pruned before.

## Verified vs unverified

- **Verified:** `npm test` from `edge-tracker-agents/` → **111 tests, 108 pass, 3 fail**; the 3 are
  the pre-existing environmental `degradation-channel` trio (`node_modules` absent in the worktree),
  byte-identical on untouched `main`. `node tools/smoke.mjs` → **106 passed, 0 failed, 0 skipped**.
  Non-flaky: full suite 8× sequential and 6× concurrent, identical every time. Mutation-tested
  throughout — including the one that matters most, routing `sharp` at the unfiltered feed, which
  fails loudly.
- **Unverified:** no live run. The two `alter table` statements below are not applied, and the
  decisive behavior (movement detected on the *first* run after a restart) cannot be shown without
  credits and a slate.

## OWED NOW — hand-run DDL

```sql
alter table line_movements add column if not exists gap_min         numeric;
alter table line_movements add column if not exists baseline_source text;
```

Idempotent. There is a missing-column strip-and-retry guard so **nothing breaks before this runs** —
rows simply land without the two fields, which the reader rule then classifies as pre-fix. Per
D69/D70 this repo has a real history of DDL shipping unapplied, which is why the guard exists.

## Review and test history

Two review rounds and four builder passes. Round 1 found 4 confirmed defects; round 2 found 3 more,
**all introduced by round 1's fixes** — including the steam-corruption bug, where rehydration made it
possible for the first time to report an afternoon-long drift as coordinated money. I deliberately
exceeded the pipeline's 2-round cap for that one rather than ship it. The tester then found 2 more
(an empty-slate run burning the cold allowance; `steamSafeMovements` trusting gaps that coerce to
zero) and surfaced the two design calls Blake decided: the two-feed split and 30 → 35.

## Open items for Blake

1. **The 360-min bound discards IDLE-tier movement at governor ×2.5/×4.** Only the 450 and 720-minute
   idle intervals exceed it, and IDLE means that league has no game inside 12 hours. By pair count
   that is ~1–4%; by **row** count plausibly **5–25% of movement rows in a hot month**, because a
   7.5–12h gap moves most of a game's ~44 keys while a 4-minute gap moves a handful. **That is a
   model, not a measurement** — `staleBaseline` in the run summary is the instrument, and it should be
   watched on the first governed week. If it reads higher than expected, the bound is the dial.
2. **Manual check step 4 is the ONLY check that tests rehydration.** Step 6 proves the staleness bound
   governs — nothing more. Its baselines come from the previous run of the *same* process, and
   `lastLines` already survived run-to-run within a process before this fix; the bug was strictly
   **cross-process** loss. Hydration could be wholly broken and step 6 would still pass exactly as
   described. An earlier draft of the recipe overclaimed this and was corrected (D73 amended).
3. **1 November has passed** — the budget reset that four separate fixes became observable at is now
   history. Nobody has read the result yet. Worth doing before the next allocation change.

## Next steps

1. **Run the two `alter table` statements above** in the Supabase SQL editor.
2. **Run the manual check recipe** in `docs/specs/persist-movement-baseline.md`. Start with
   `lsof -nP -iTCP -sTCP:LISTEN` — a Pool Room Pro Electron process holds 4317-4318, Vantyx holds
   3000, and `npx serve` silently falls back to a random port. **Step 4 is the one that matters**;
   steps 4–6 need credits and a slate.
3. **Merge the PR**, then watch `staleBaseline` and the `baseline <hydrated>/<attempted>` segment on
   the first redeploy — that segment is always printed now, precisely so a silent no-op is visible.
4. **Read the 1 November budget reset** (open item 3). Four fixes became observable at once and
   nobody has looked.
5. **Phase: point `sharp` at a history reader** instead of `getIntel('movements')`, the array from
   only the most recent odds run — why `sharp` has reported "no recent line movement" across 13,000+
   runs. Related follow-up now named in the code: `sharp` should also check `gap_min` itself rather
   than relying on `odds` to pre-filter for it.
6. **Phase: generalize open→close movement to all 12 sports** — spec already written at
   `docs/specs/line-move-all-sports.md`, with the store-shape and rename decisions made.
7. **Teach `public-splits` absent-vs-zero** (optional). The two-feed split fixed the symptom; the
   underlying trap is that `?? 0` cannot tell "no row" from "no movement", so any future consumer
   inherits it.
8. **`book_move_log` is still not in the watchdog's schema probes** — one line, and those probes exist
   to catch exactly the failure this repo keeps having: an agent shipping with DDL nobody ran.
9. **Watchdog alerts still reach zero recipients** (`notifyAll` needs `ALERT_NUMBERS` or `SMTP_*`).
   Deprioritised by Blake 2026-10-28; every "make it loud" path still terminates here.

## House rule earned this session

`Number('')`, `Number(null)`, `Number('  ')`, `Number([])` and `Number(false)` are all a finite `0`,
and in this codebase `0` is never a neutral value — it is a real pick-em, or the most simultaneous
gap there is. This exact coercion trap has now produced three separate shipped bugs (D10, D67, the
`crossedKey(null)` bug in #133, and D79). **Type-check before coercing; never let `Number.isFinite`
stand in for a presence check.**
