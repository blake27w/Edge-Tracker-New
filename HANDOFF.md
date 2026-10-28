# Edge Tracker — Session Handoff

Last updated: 2026-10-27 — **PRs #129, #130, #131, #132 and #133 are all merged to `main`.**
Five parallel sessions' work now sits in one place: data-integrity fixes + a real test suite
(#130), odds-budget governance (#131), history consensus lines (#132), function-first IA phase 1
+ smoke harness + CORS (#129), and per-book line-movement attribution (#133). The odds
allocation reshape is applied and live on Railway.

## ⚠️ The one blocker: the migration still has not been run

Everything else degrades gracefully without it, but it is a prerequisite for several fixes to
take effect — **and it now also carries the `book_move_log` DDL that #133's agent needs before
it can persist anything.** Run the concurrent index script FIRST, then `schema.sql`. Order
matters: a plain `create index` takes a SHARE lock that blocks inserts for the whole build,
which on `line_snapshots` means the odds agent silently drops snapshots and corrupts the CLV
data #130 just fixed. The concurrent script avoids that; `schema.sql`'s `if not exists` then
finds the indexes present and never takes the blocking path.

Connection string: Supabase dashboard → Project Settings → Database → Connection string →
**URI**, **direct connection on port 5432, not the pooler on 6543** — pgbouncer in transaction
mode cannot run `concurrently`. `PGOPTIONS` clears the statement timeout and is **not
optional**: Supabase caps statement duration and the `line_snapshots` / `injury_updates` index
builds run for minutes.

```
export SUPABASE_DB_URL='<direct URI>'
cd /Users/blakewallace/Edge-Tracker-New/edge-tracker-agents    # now on main — no worktree needed

# 1. indexes — minutes on the big tables, does NOT block writes
PGOPTIONS="-c statement_timeout=0" psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f scripts/migrate-data-health-indexes.sql

# 2. schema — fast; carries the `freeze` fix that unsticks public_splits,
#    and the book_move_log table + indexes that #133 needs
PGOPTIONS="-c statement_timeout=0" psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f scripts/schema.sql
```

Both idempotent. Many `NOTICE: ... already exists, skipping` lines are expected — any `ERROR`
is not. If step 1 finishes suspiciously fast on `line_snapshots`, an index build may have been
left INVALID (the planner ignores those, so the seq scans silently persist); the check query is
at the bottom of that file. Without psql: the SQL editor can take `schema.sql` whole, but the
concurrent file must go **one `create index concurrently` line at a time**.

**Why it never ran before:** `schema.sql` had been un-runnable since 2026-07-03. `freeze` is a
*reserved* keyword in Postgres, so `alter table public_splits add column if not exists freeze
boolean` was a syntax error, and the SQL editor runs a multi-statement script in one
transaction — that one line aborted and rolled back everything after it. Fixed in #130. It also
caused a fifth silent fault: `public-splits` reported `3 splits · 2 freeze` with 0 failures for
103 days while writing nothing.

**Do NOT re-run `migrate-research.sql`** — it was run on 2026-09-26 including the eight odds
columns from `59b94bd`, and has been re-confirmed since. Any older note listing it as owed,
or listing Railway vars `NCAAF_MODEL` / `NFL_LIVE` / `ODDS_SKIP_SPORTS` as owed, is stale —
those were all done.

## Current state

`main` carries all five merges. Production deploys from it.

- **#130** — four silent data-integrity faults fixed (clv all-suspect, grading 0, the null
  `line_snapshots` count, the 36s `/data-health`), plus the fifth above. Agents can now say
  "I succeeded and produced nothing usable" via `reportDegraded`. `/data-health` now counts 44
  tables, up from 11.
- **#131** — the odds budget actually governs: discretionary spend capped, ceilings
  remainder-based. Closes the ~1107 ungoverned credits.
- **#132** — history closing lines are a consensus across books.
- **#129** — function-first IA phase 1, `tools/smoke.mjs`, CORS for local dev origins.
- **#133** — the `book-move` agent.

**There IS a test suite now** (`edge-tracker-agents/test/`, `npm test` — `node:test`, zero new
dependencies, mutation-tested) plus `tools/smoke.mjs` for the PWA. Any note saying otherwise is
stale.

### `book-move` — per-book line-movement attribution (#133)

`edge-tracker-agents/src/agents/book-move/index.js`, 15-min cadence, 🧲.

Reads `line_snapshots` history (**not** `line_movements`) and derives, per book: direction,
magnitude, how early relative to kickoff, whether the move crossed a key number, whether it moved
against market-wide public consensus, and whether the book **led or followed** the field to that
line level. Scores each episode `100 × Σ(wᵢvᵢ) / Σ(wᵢ)` over only the components that apply —
0.30 magnitude / 0.20 key-number / 0.15 early / 0.20 vs-public / 0.15 lead, `MIN_SCORE=35`, all
env-tunable. Book reputation (`market-maker` / `follower` / `mixed`) is derived from the trailing
14 days of `book_move_log`, never hardcoded; a `small` flag discloses n < 20.

**Zero Odds API spend**, enforced by a smoke assertion that the agent source contains no
`fetch(`. Surfaces as a 🧲 BOOK MOVEMENT section on the Agents tab plus `/plays.bookMoves`.
`book_move_log` is in `/data-health`'s monitored tables (added during this merge — #133 put it
in the old inline `buildDataHealth`, which #130 had moved to `src/health/data-health.js`).

A reviewer found 9 confirmed defects, all fixed before merge. Worth knowing: `led` originally
meant "line differs from the batch median", which *rewarded books that disagreed with the market*
— the metric was inverted.

**Known ceilings, inherent to the data:** `public_splits` has no `book` column, so "which books
get hit by the public" is market-wide only. And the book list is 11 licensed US retail books with
no originating book (no Pinnacle, Circa, or exchange), so "led the field" measures which retail
book copies the true market fastest — not who sharps actually bet with. Closing that costs API
spend.

### Odds allocation — reshaped, applied, live

Set on Railway (project **cozy-friendship**, service **Edge-Tracker-New**, production):

```
ODDS_ALLOC_NCAAF=0.26   ODDS_ALLOC_MLB=0.04   ODDS_ALLOC_NFL=0.30
```

NCAAF's ceiling went 3317 → 5525 against 3324 spent — from zero headroom to ~2200 credits for
the rest of October. Confirmed live: budget-skips 4 → 1, snapshots per run 0 → 1072. MLB stays
capped at 850 against 2906 spent, by design — postseason-only, and that is where NCAAF's credits
came from.

**CORRECTION (2026-10-28): the month fully exhausted — 20002/20000 on day 28,
`discretionaryActive: false`.** An earlier version of this file predicted October would land
near 18114, reasoning that `capOf()`'s 0.85 factor caps total spend near 17000 by construction.
**That was wrong**, in two ways worth understanding before touching these vars again:

- The sports written off as "capped out" on day 14 were simply *between seasons*. NBA went
  35 → 1423 and NCAAB 0 → 6 as their seasons opened, spending headroom the projection assumed
  was dead.
- #131 replaced the ceiling machinery these vars act on with remainder-based ceilings, so the
  0.85 reasoning no longer describes the live system at all.

The reshape itself did its job: **NCAAF went 3324 → 5529**, landing on its new 5525 ceiling, so
it got its peak-season coverage. NFL reached 5929. The cost was the rest of the month.

`projectedMonthly` still over-reads (it linearly extrapolates `perDay`), but "it can be ignored"
was too strong — it was directionally right here and the ceiling argument against it was not.
**PR #134 ("one ceiling formula, and stop reading a missing header as zero credits") is open and
unmerged, and touches exactly this.** Read it before setting November's shares.

### The Oct 1 reset verified the September work

`nfl-history` went from 124 of 588 games to 634 with closing lines; `ncaaf-history` to
2214/2257 (98.1%). Football went from 1064 of ~7450 credits to 51.6% of all spend. **The floor
half of D6 is still unexercised** — `N held for football (floor N)` only prints when football has
an unspent remainder to protect, and it is now spending its share. Correctly idle, not broken.

## In flight / unproven

1. **The Games view has never been seen on a phone.** Verified at a 375×812 viewport against a
   stubbed backend (4 rapid taps → 1 request; a 500 latches an error without caching; a healthy
   sport renders over a failed one; a cached payload beats a stale error; refresh triggers
   exactly one refetch). **Next step: open the deployed PWA, tap GAMES.**
2. **The CORS fix is unverified against a running server.** After deploy:
   `curl -s -i -H "Origin: http://localhost:4318" <base>/health | grep -i access-control-allow-origin`
   should echo the origin back. `CORS_ORIGINS` on Railway is still `https://blake27w.github.io`;
   the deployed PWA reaches the API via the `*.vercel.app` rule.
3. **#130's fixes are unverified against production Supabase**; **#133 has had no live run at
   all** and cannot persist until the DDL lands.

## Next steps

1. **Run the migration** (top of this file). Then check in this order: `public_splits.today`
   non-zero within 4h — fastest confirmation it applied; then `/data-health` response time and
   that `line_snapshots.total` is a real integer; then `clv` for `N measurable` and a non-zero
   `beat close`; then `grading`'s `queued / no final / expired` counters; then `book_move_log`
   starting to fill.
2. **Run #133's manual check recipe** in `docs/specs/book-movement-attribution.md`.
3. **Expect ~2 weeks of noisy `role` values** from `book-move`. Reputation is derived, so it
   bootstraps from nothing; the `small` flag (n < 20) discloses it. **Do not tune the weights off
   the first fortnight.**
4. **Watch for the first `expired` sweep.** `grading` retires up to 200 rows per run on its first
   passes and logs a warning each time. Large once, then zero; continued churn means
   `GRADE_LOOKBACK_DAYS` is wrong for the volume.
5. **Check the Games view on a phone**, then decide Phase 2 of the IA reorg. Stats is the natural
   follow-up but is a real data merge across 5 implementations, not a wrapper. Log is the worst
   risk profile in the file (9 localStorage arrays). Dashboard needs `state.modelResults` /
   `propModelResults` / `slateData` keyed by sport first.
6. **Line-movement phases still owed** (#133 did the attribution layer, not these):
   - **Persist the `lastLines` baseline** — `odds/index.js:162` is a process-local Map, so every
     redeploy blinds movement detection and leaves `line_movements` sparse. Confirmed live: the
     first odds run after the allocation redeploy reported `0 movements`. Makes `book-move` denser.
   - **Point `sharp` / `public-splits` at a history reader** instead of `getIntel('movements')`,
     the in-memory array from only the most recent odds run — which is why `sharp` has reported
     "no recent line movement" across 13,028 runs.
   - **Generalize open→close movement to all 12 sports** — spec already written at
     `docs/specs/line-move-all-sports.md`, with the store-shape and agent-rename decisions made.
     `nfl-line-move` self-gates to NFL while `opening_lines` is written sport-agnostically.
7. **Watch early November.** NCAAB entering season adds 0.06 to `sumAlloc` and silently recomputes
   every ceiling downward mid-season — NCAAF at 0.26 has more to lose from that than before.
   Revisit these shares after football season; MLB at 0.04 will be wrong by spring.
8. **Open finding, needs a person: watchdog alerts reach zero recipients.** `digest` reports
   "digest sent to 0 recipient(s)"; `notifyAll` needs `ALERT_NUMBERS` (SMS) or equivalent. Every
   "make it loud" path in #130 terminates here, so the alarms are currently loud into a void.
9. **Tune the alarm floors if wrong.** `CLV_ALARM_MIN` (12) and `GRADE_ZERO_ALARM_MIN` (5) are
   judgement calls, not measurements.
10. **Precondition if anyone sets `NCAAF_HISTORY_FROM` / `NFL_HISTORY_FROM` to 2022:** capture the
    four headline history stats first. The stored 2024-26 population has exactly one non-live book
    per game, so #132 changes nothing today; 2022-23 games carry 14-15 records where the two
    algorithms genuinely diverge, and `nfl-history` re-upserts every row every run — the stats
    would move with nothing recording why.

## Notes for whoever picks this up

- **Decision numbering:** parallel sessions collided twice. #129's entries were renumbered to
  **D42–D51** and #133's to **D52–D59**; content unchanged, internal cross-references moved with
  them. `main`'s D15–D19 are unused gaps. **Next free number is D60.**
- `buildDataHealth` lives in `src/health/data-health.js`, extracted from `src/index.js` to make
  counting and error-classification testable.
- `tools/smoke.mjs` had 17 assertions skipped on #133's branch because they tested features #129
  adds; with both merged they re-enable by themselves.
- **Environment traps that cost real time, twice:** the preview tooling reads Pool Room Pro's
  `launch.json`, not this repo's. A Pool Room Pro Electron process holds ports 4317–4318 and
  Vantyx holds 3000, and `npx serve` silently falls back to a random port when its is taken.
  `lsof -nP -iTCP -sTCP:LISTEN` is the fast diagnosis — run it before debugging anything.
