# Edge Tracker — Session Handoff

Last updated: 2026-10-28 — **all six PRs merged, deployed, and the migration is RUN.**
`#129` `#130` `#131` `#132` `#133` `#134` are all on `main`. There are no open PRs.

Nothing is blocked. The next meaningful checkpoint is the **1 November budget reset**, which is
when four separate fixes become observable at once (see *What to check on 1 November*).

## The migration is done

Run by Blake in the Supabase SQL editor on 2026-10-28, in three pastes. Applied:
`public_splits.freeze/pileon/net_move`, `clv_records.clv_odds/close_source`, the three
timestamp indexes that mattered (`line_snapshots`, `injury_updates`, `scan_runs`), and the
`book_move_log` table plus its two indexes.

Measured against production, same endpoint each time:

| | `/data-health` | tables | failing counts |
|---|---|---|---|
| before any of this work | 36–38s | 11 | 2 silently `null` |
| after the code fixes, pre-migration | 8001ms | 44 | 3 timing out |
| **after the migration** | **976ms** | **45** | **0** |

`line_snapshots.total` reads 6,746,119 — the count that used to time out into a `null` nobody
could distinguish from a missing table. The watchdog is down to one issue, the reserve alarm,
which is true. `book_move_log` exists and reads `0/0`: empty and writable.

**Deliberately not applied: 12 further indexes** on small reference tables. They are in
`scripts/schema.sql` and harmless to run, but a sequential scan over a few hundred rows is free
and `/data-health` is already under a second without them. Don't let their absence read as an
unfinished migration.

**Why it had never run before:** `schema.sql` was un-runnable from 2026-07-03. `freeze` is a
reserved keyword in Postgres, so `alter table public_splits add column if not exists freeze
boolean` was a syntax error, and the SQL editor runs a multi-statement script in one transaction
— that one line aborted and rolled back everything after it, for 117 days. Fixed in #130.

## Current state

`main` carries all six merges; production deploys from it. **63 tests pass** against merged
`main` (`cd edge-tracker-agents && npm test`), it boots clean, and 54 agents register.

- **#130** — five silent data-integrity faults fixed, plus the test suite and `reportDegraded`,
  the channel that lets an agent say "I succeeded and produced nothing usable".
- **#131** — the odds budget actually governs; discretionary spend bills into `bySport`.
- **#132** — history closing lines are a consensus across books.
- **#129** — function-first IA phase 1, `tools/smoke.mjs`, CORS for local dev origins.
- **#133** — the `book-move` agent.
- **#134** — one per-sport ceiling formula shared by the core loop and the discretionary gate,
  and a missing usage header no longer reads as zero credits.

### Proven in production

**`grading` was the big one.** `graded 0 (0W-0L-0P)` across 868+ runs became
**`graded 80 (46W-34L-0P)` on its first run after merge** — 46 wins and 34 losses that existed
and were invisible. The cause was a head-of-line block: the pending query had no lower bound and
took `limit: 80` *oldest*-first, so once 80 never-gradeable rows accumulated nothing newer was
ever reached. `opp-grading` was unaffected only because it windows on 30 hours.

The whole loudness chain also ran end-to-end on real data: the watchdog went from one
permanently-firing false alarm to five true ones, including `grading|expired-bulk` correctly
reporting a 166-play cleanup sweep and then correctly ageing out.

### `book-move` — per-book line-movement attribution (#133)

`edge-tracker-agents/src/agents/book-move/index.js`, 15-min cadence, 🧲.

Reads `line_snapshots` history (**not** `line_movements`) and derives, per book: direction,
magnitude, earliness relative to kickoff, whether the move crossed a key number, whether it went
against market-wide public consensus, and whether the book **led or followed** the field to that
level. Scores `100 × Σ(wᵢvᵢ) / Σ(wᵢ)` over only the components that apply — 0.30 magnitude /
0.20 key-number / 0.15 early / 0.20 vs-public / 0.15 lead, `MIN_SCORE=35`, all env-tunable. Book
reputation (`market-maker` / `follower` / `mixed`) is derived from the trailing 14 days of
`book_move_log`, never hardcoded; a `small` flag discloses n < 20.

**Zero Odds API spend**, enforced by a smoke assertion that the source contains no `fetch(`.

A reviewer found 9 confirmed defects, all fixed before merge. Worth knowing: `led` originally
meant "line differs from the batch median", which *rewarded books that disagreed with the
market* — the metric was inverted.

**Known ceilings, inherent to the data:** `public_splits` has no `book` column, so "which books
get hit by the public" is market-wide only. And the book list is 11 licensed US retail books
with no originating book (no Pinnacle, Circa, or exchange), so "led the field" measures which
retail book copies the true market fastest — not who sharps actually bet with.

### October's budget — exhausted, and the lesson is in *why*

**20002/20000 on day 28, `discretionaryActive: false`.** An earlier version of this file
predicted October would land near 18114, reasoning that `capOf()`'s 0.85 factor bounds total
spend near 17000 by construction. That was wrong in two ways worth understanding before setting
November's shares:

- Sports written off as "capped out" on day 14 were simply *between seasons*. NBA went
  35 → 1423 and NCAAB 0 → 6 as their seasons opened, spending headroom the projection assumed
  was dead.
- #131 replaced the ceiling machinery those vars act on, so the 0.85 reasoning stopped
  describing the live system.

The reshape itself worked: **NCAAF went 3324 → 5529**, landing on its new 5525 ceiling, so it
got peak-season coverage. NFL reached 5929. The cost was the rest of the month.

Two diagnoses behind #134, both measured against the live numbers:

- `sum(bySport)` was 17919 against `used` 20002 — a **2083-credit gap** spent by consumers the
  ceilings never saw. Closed by #131, too late for October.
- The core loop and `hasOddsBudget` bounded a sport at **different ceilings** while billing the
  same counter. They cross over at `sumAlloc = POOL`: above it the gate was looser (17.7% with
  every sport in the denominator), below it the core loop was. Closed by #134.

**`paceRatio > 1` is algebraically identical to `projectedMonthly > budget`** —
`pctUsed/monthPct = projectedMonthly/cap`. Do not reintroduce either as an alarm; both fire
through a normal football month. #134's tripwire uses actuals instead.

## In flight / unproven

1. **`public_splits` is not yet proven fixed.** The columns exist and the write will now succeed,
   but the agent needs a slate, and nothing is ingesting while the budget is spent. `today > 0`
   is the confirmation, realistically after 1 November.
2. **`book-move` has still never had a live run** — `dormant — empty slate`. Its table is ready.
3. **The Games view has never been seen on a phone.** Verified at 375×812 against a stubbed
   backend. **Next step: open the deployed PWA, tap GAMES.**
4. **CORS is unverified against a running server.**
   `curl -s -i -H "Origin: http://localhost:4318" <base>/health | grep -i access-control-allow-origin`
   should echo the origin back.
5. **#134's ceiling logic is untestable while the budget is spent** — the gate short-circuits on
   `remaining <= reserve` before reaching the per-sport ceiling. The unit tests prove the
   formula; only a live month proves the wiring.

## What to check on 1 November

In this order. All four were fixed blind and become observable together.

1. **`public_splits.today > 0`** — closes a 117-day silent failure.
2. **`sum(bySport)` tracking `used`** on `/health` — confirms the attribution leak is shut. A
   persistent gap means a consumer is still spending ungoverned.
3. **`pctUsed` plateauing near 85%** rather than reaching 100%, and `budget-skips` appearing
   before exhaustion rather than after.
4. **`clv` records carrying `clv_odds`**, a non-zero `beat close`, and `unknown` counts in the
   report — price-aware CLV is live but has produced nothing yet.
5. **`book_move_log` starting to fill**, then #133's manual check recipe in
   `docs/specs/book-movement-attribution.md`.

## Next steps

1. **Expect ~2 weeks of noisy `role` values** from `book-move`. Reputation is derived, so it
   bootstraps from nothing; the `small` flag (n < 20) discloses it. **Do not tune the weights off
   the first fortnight.**
2. **NCAAB entering season adds 0.06 to `sumAlloc`** and recomputes every ceiling downward —
   NCAAF at 0.26 has more to lose than before. Revisit shares after football season; MLB at 0.04
   will be wrong by spring.
3. **Line-movement phases still owed** (#133 did the attribution layer, not these):
   - **Persist the `lastLines` baseline** — `odds/index.js` holds it in a process-local Map, so
     every redeploy blinds movement detection. Confirmed live: the first odds run after a
     redeploy reported `0 movements`. Would make `book-move` denser.
   - **Point `sharp` / `public-splits` at a history reader** instead of `getIntel('movements')`,
     the in-memory array from only the most recent odds run — which is why `sharp` has reported
     "no recent line movement" across 13,000+ runs.
   - **Generalize open→close movement to all 12 sports** — spec at
     `docs/specs/line-move-all-sports.md`.
4. **Check the Games view on a phone**, then decide Phase 2 of the IA reorg. Stats is the natural
   follow-up but is a real data merge across 5 implementations. Log is the worst risk profile in
   the file (9 localStorage arrays).
5. **Watchdog alerts reach zero recipients.** `digest` reports "sent to 0 recipient(s)";
   `notifyAll` needs `ALERT_NUMBERS` or the `SMTP_*` set. Every "make it loud" path terminates
   here, so the alarms are currently loud into a void. **Deprioritised by Blake on 2026-10-28** —
   noted rather than dropped.
6. **`book_move_log` is not in the watchdog's schema probes.** Those probes exist to surface
   exactly the failure it just demonstrated — an agent shipping with DDL nobody ran. One line,
   worth folding in next time that file is touched.
7. **Tune the alarm floors if wrong.** `CLV_ALARM_MIN` (12) and `GRADE_ZERO_ALARM_MIN` (5) are
   judgement calls, not measurements.
8. **Precondition if anyone sets `NCAAF_HISTORY_FROM` / `NFL_HISTORY_FROM` to 2022:** capture the
   four headline history stats first. The stored 2024-26 population has exactly one non-live book
   per game, so #132 changes nothing today; 2022-23 games carry 14-15 records where the two
   algorithms genuinely diverge, and `nfl-history` re-upserts every row every run — the stats
   would move with nothing recording why.

## Notes for whoever picks this up

- **Decision numbering:** parallel sessions collided repeatedly. #129's entries were renumbered
  to **D42–D51**, #133's to **D52–D59**, #134's to **D60–D67**, and the migration to **D68–D70**.
  `main`'s D15–D19 are unused gaps. **Next free number is D71.**
- **If you are in a long-lived worktree, `grep -rn src/` lies.** A branch cut weeks ago does not
  contain later merges, and reading it produced a confident, entirely wrong diagnosis of the
  budget on 2026-10-27. Use `git show origin/main:<path>`.
- **A recurring bug shape, three instances across two sessions:** `Number(null) === 0` passes
  `Number.isFinite`, so a *missing* value reads as zero. Found in `espn-odds.js`'s `num()`,
  `clv-tracker`'s `batchConsensus`, and `odds`' `recordSpend` — where it made a header-less
  response look like "0 credits remaining" and shut the system down. The shape is always *a guard
  that validates the coercion instead of the input*. Standing grep: `Number.isFinite(+`.
- **The tests are mutation-tested, and that mattered.** The first round of #134's formula tests
  passed against the bug they were meant to guard. If you change behaviour in `clv-tracker`,
  `grading`, `health/data-health.js`, `db`, `store`, `watchdog` or `odds`, reintroduce the old
  behaviour once and confirm the suite fails. A suite that passes against the broken code is
  worse than none.
- `buildDataHealth` lives in `src/health/data-health.js`, extracted from `src/index.js` to make
  counting and error-classification testable.
- **Environment traps that cost real time, twice:** the preview tooling reads Pool Room Pro's
  `launch.json`, not this repo's. A Pool Room Pro Electron process holds ports 4317–4318 and
  Vantyx holds 3000, and `npx serve` silently falls back to a random port when its is taken.
  `lsof -nP -iTCP -sTCP:LISTEN` is the fast diagnosis — run it before debugging anything.
