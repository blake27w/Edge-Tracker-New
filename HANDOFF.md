# Edge Tracker — Session Handoff

Last updated: 2026-10-26 — **PRs #129, #130, #131 and #132 all merged to `main`.** Four
parallel sessions' work is now in one place: data-integrity fixes + a real test suite (#130),
odds-budget governance (#131), history consensus lines (#132), and function-first IA phase 1 +
smoke harness + CORS (#129). The odds allocation reshape is applied and live on Railway.

## ⚠️ The one blocker: the migration still has not been run

Everything else degrades gracefully without it, but this is a prerequisite for several fixes
to actually take effect. **Run the concurrent index script FIRST, then `schema.sql`.** Order
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

# 2. schema — fast; carries the `freeze` fix that unsticks public_splits
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
caused a fifth silent fault: `public-splits` has reported `3 splits · 2 freeze` with 0 failures
for 103 days while writing nothing.

**Do NOT re-run `migrate-research.sql`** — it was run on 2026-09-26 including the eight odds
columns from `59b94bd`, and has been re-confirmed since.

## Current state

`main` now carries all four merges. Production deploys from it.

- **#130** — four silent data-integrity faults fixed (clv all-suspect, grading 0, the null
  `line_snapshots` count, the 36s `/data-health`), plus the fifth found above. Agents can now
  say "I succeeded and produced nothing usable" via `reportDegraded`.
- **#131** — the odds budget actually governs: discretionary spend capped, ceilings
  remainder-based. Closes the ~1107 ungoverned credits (`hasOddsBudget()` checked only the
  global reserve, never a per-sport cap).
- **#132** — history closing lines are a consensus across books rather than whichever record
  looked fullest.
- **#129** — function-first IA phase 1, `tools/smoke.mjs`, CORS for local dev origins.

**There IS a test suite now** (`edge-tracker-agents/test/`, `npm test`) — `node:test`, zero new
dependencies, mutation-tested rather than assumed. Plus `tools/smoke.mjs` for the PWA
(`node tools/smoke.mjs`, `--live` adds the backend contract). Any older note saying "there is
still no test suite" is stale.

### Odds allocation — reshaped, applied, live

Set on Railway (project **cozy-friendship**, service **Edge-Tracker-New**, production):

```
ODDS_ALLOC_NCAAF=0.26   ODDS_ALLOC_MLB=0.04   ODDS_ALLOC_NFL=0.30
```

NCAAF's ceiling went 3317 → 5525 against 3324 spent — from zero headroom to ~2200 credits for
the rest of October. Confirmed live: budget-skips 4 → 1, snapshots per run 0 → 1072. MLB stays
capped at 850 against 2906 spent, by design — postseason-only, and that is where NCAAF's
credits came from.

**`projectedMonthly` is not a decision input.** It linearly extrapolates `perDay` while ignoring
the per-sport ceilings, and `capOf()`'s 0.85 factor caps total spend near 17000 by construction.
Any note saying "the budget is on pace to overrun" predates this and is wrong. **#131 changed the
ceiling machinery these vars act on** — re-read `/budget` once deployed to confirm the shares
still land where intended.

### The Oct 1 reset verified the September work

`nfl-history` went from 124 of 588 games to 634 with closing lines; `ncaaf-history` to
2214/2257 (98.1%). Remaining "no line" games are ones ESPN genuinely lacks. Football went from
1064 of ~7450 credits to 51.6% of all spend. **The floor half of D6 is still unexercised** —
`N held for football (floor N)` only prints when football has an unspent remainder to protect,
and it is now spending its share. Correctly idle, not broken.

## In flight / unproven

1. **The Games view has never been seen on a phone.** Verified at a 375×812 viewport against a
   stubbed backend (4 rapid taps → 1 request; a 500 latches an error without caching; a healthy
   sport renders over a failed one; a cached payload beats a stale error; refresh triggers
   exactly one refetch), plus 21/21 smoke checks. **Next step: open the deployed PWA, tap GAMES.**
2. **The CORS fix is unverified against a running server.** After deploy:
   `curl -s -i -H "Origin: http://localhost:4318" <base>/health | grep -i access-control-allow-origin`
   should echo the origin back. `CORS_ORIGINS` on Railway is still `https://blake27w.github.io`;
   the deployed PWA reaches the API via the `*.vercel.app` rule.
3. **#130's fixes are unverified against production Supabase** — reasoned and stub-tested only.
   Real proof is the migration + deploy.

## Next steps

1. **Run the migration** (top of this file). Then check in this order: `public_splits.today`
   non-zero within 4h — fastest confirmation it applied; then `/data-health` response time and
   that `line_snapshots.total` is a real integer; then `clv` for `N measurable` and a non-zero
   `beat close`; then `grading`'s new `queued / no final / expired` counters.
2. **Watch for the first `expired` sweep.** `grading` retires up to 200 rows per run on its first
   passes and logs a warning each time. A large count is expected once and should fall to zero;
   continued churn means `GRADE_LOOKBACK_DAYS` is wrong for the volume.
3. **Check the Games view on a phone**, then decide Phase 2 of the IA reorg. Stats is the natural
   follow-up but is a real data merge across 5 implementations, not a wrapper. Log is the worst
   risk profile in the file (9 localStorage arrays). Dashboard needs `state.modelResults` /
   `propModelResults` / `slateData` keyed by sport first.
4. **Line-movement tracking** — the audit below is done, the work is not. A session was briefed
   on this; check whether it landed.
5. **Watch early November.** NCAAB entering season adds 0.06 to `sumAlloc` and silently
   recomputes every ceiling downward mid-season — NCAAF at 0.26 has more to lose from that than
   before. Revisit these shares after football season; MLB at 0.04 will be wrong by spring.
6. **Open finding, needs a person: watchdog alerts reach zero recipients.** `digest` reports
   "digest sent to 0 recipient(s)"; `notifyAll` needs `ALERT_NUMBERS` (SMS) or equivalent. Every
   "make it loud" path in #130 terminates here, so the alarms are currently loud into a void.
7. **Tune the alarm floors if wrong.** `CLV_ALARM_MIN` (12) and `GRADE_ZERO_ALARM_MIN` (5) are
   judgement calls, not measurements.
8. **Precondition if anyone sets `NCAAF_HISTORY_FROM` / `NFL_HISTORY_FROM` to 2022:** capture the
   four headline history stats first. The stored 2024-26 population has exactly one non-live book
   per game, so #132 changes nothing today; 2022-23 games carry 14-15 records where the two
   algorithms genuinely diverge, and `nfl-history` re-upserts every row every run — the stats
   would move with nothing recording why.

## Line-movement audit (2026-10-14) — findings, no code written yet

Capture is sound and sport-agnostic. Everything downstream is NFL-only, three-minutes-deep, or
reads nothing.

1. **`line_movements` is a write-only table.** The only reference in the codebase is the INSERT
   at `odds/index.js:356`. No agent reads it, no route serves it, the PWA never fetches it. Every
   movement ever detected has been archived and never used.
2. **Live consumers see only the last ~3 minutes.** `sharp` and `public-splits` read
   `getIntel('movements')` — the in-memory array from the most recent odds run. This is why
   `sharp` reports "no recent line movement" across 13,000+ runs.
3. **Detection state is in-process.** `lastLines` (`odds/index.js:162`) is a plain Map, so every
   redeploy wipes the baseline. Confirmed live: the first odds run after the allocation redeploy
   reported `0 movements`.
4. **Budget-capped sports get no movement data** — movement is computed only inside `normalize()`,
   which runs only on a fetch.
5. **Open→close movement is NFL-only.** `nfl-line-move` self-gates to NFL, but `opening_lines` is
   written sport-agnostically. Raw material for 12 sports, used for 1. **Cheapest big win.** It is
   *named* for NFL and writes `setNflLineMove`, which `index.html` reads — generalizing it touches
   the store shape and the PWA.
6. **Resolution is capped by cadence** — idle sampling is 3h × throttle.

Suggested order: generalize `nfl-line-move` to all sports → give `line_movements` a reader →
persist the baseline.

## Notes for whoever picks this up

- **Decision numbering:** three sessions ran in parallel on 2026-10-14 and all appended from D8.
  #129's entries were renumbered to **D42–D51** on merge; content unchanged. `main`'s D15–D19 are
  unused gaps. Next free number is **D52**.
- `buildDataHealth` lives in `src/health/data-health.js`, extracted from `src/index.js` to make
  counting and error-classification testable.
- `index.html` was touched by #130 (CLV render path only) and #129 (navigation). No overlap.
- **Environment traps that cost real time:** the preview tooling reads Pool Room Pro's
  `launch.json`, not this repo's. A Pool Room Pro Electron process holds ports 4317–4318 and
  Vantyx holds 3000, and `npx serve` silently falls back to a random port when its is taken —
  three rounds were spent looking at Pool Room Pro's login screen. `lsof -nP -iTCP -sTCP:LISTEN`
  is the fast diagnosis.
