# Edge Tracker — Session Handoff

Last updated: 2026-10-14 — four silent data-integrity faults fixed; branch `fix/silent-data-integrity-faults` open as a PR.

## Current state

One commit on `fix/silent-data-integrity-faults` (PR to `origin/main`): `04d710a`. 10 files, +~700/-100, plus a new `src/health/data-health.js`.

Production is healthy by its own account and was lying about it. The binding theme: **the orchestrator marks a run failed only when it throws**, so every one of the four faults sat behind a `catch (_)` or a silent `continue` and reported `status: idle`, `error: null`, `0 consecutive failures` — 53 agents, 0 errors, `errorsToday: 0`. There was no way for an agent to say "I succeeded and produced nothing usable". That's now `reportDegraded` (see D8).

### What was wrong, and what it actually was

- **`clv` — "20 CLV records (0 beat close, 20 suspect)"**. Two independent bugs. (1) The snapshot query was `order fetched_at ASC, limit 1000`; one game/market/side gets ~8 rows per poll, so 1000 rows is ~6h of a game that sits on the board for a week — the close was truncated away and the entry batch collapsed onto it. (2) `beat_close` looked only at the line, so a spread/total that didn't move scored as "did not beat the close" even when the price on that number improved. The prompt's hypothesis about 59b94bd was right in substance but not in location: the odds columns that commit added are on `nfl/ncaaf_closing_lines` (the history path); the live CLV path reads `line_snapshots`, which always had `price` — it just never used it.
- **`grading` — "graded 0" across 868 runs**. Head-of-line block: no lower bound on the pending select plus `limit: 80` *oldest*-first, so 80 never-gradeable rows held the queue forever. Not a matching bug. `opp-grading` was fine because it windows on 30h — hence 187 `opp_results` rows the same day.
- **`/data-health` nulls**. A count timing out inside `catch (_) { /* table optional */ }`, indistinguishable from a missing table; `errorsToday` only counts agent `scan_runs` rows, so endpoint failures appeared nowhere.
- **`/data-health` 36s**. Every counted table has its timestamp only as the *trailing* column of a composite index, so even the "today" counts were full sequential scans — 23 of them, serially.

## Verified vs unverified

- **Verified.** `node --check` on every changed file; the server boots clean and serves `/data-health` (207 + `reason` with no DB, as it should) and `/plays`. The real modules were exercised with stubbed IO: 12 CLV cases, 17 data-health cases, and the grading scenarios all pass. Old-vs-new on identical fixtures reproduces both production strings — the old CLV path reports `close_at` 12.5h early with `entry_at === close_at` on a 1600-row game, and the old grader reports `graded 0 (0W-0L-0P)` with a fresh gradeable play sitting right there. The watchdog chain (agent → `reportDegraded` → issue → alert body) was run end-to-end.
- **Unverified.** Nothing has run against production Supabase. The `count: 'estimated'` speedup and the new indexes are reasoned from the schema and measured only against a stub — real proof is the deploy. Whether `grading` now actually grades depends on there being gradeable plays in the 10-day window, which can't be known from outside the DB.

## Next steps

1. **Re-run `scripts/schema.sql` in Supabase. This is a prerequisite, not a nice-to-have** — it adds the 12 `/data-health` timestamp indexes (fault 4 stays slow without them) and `clv_records.clv_odds` / `.close_source`. The CLV write falls back to the old columns and reports `clv|schema` if it hasn't been run, so the metric degrades instead of breaking, but it won't be price-aware.
2. **`scripts/migrate-research.sql` is still owed from the September session** — unrelated to this work, still not run as far as I can tell.
3. **After deploy, check in this order:** `/data-health` response time and that `line_snapshots.total` is a real integer (fault 4 + 3); the `clv` summary line for `N measurable` and a non-zero `beat close` (fault 1); the `grading` line for its new counters — `queued / no final / expired` (fault 2).
4. **Watch for the first `expired` sweep.** `grading` will retire up to 200 rows per run on its first passes and log a warning each time. A large count is expected once and should fall to zero; if it keeps churning, the floor is wrong for the volume (`GRADE_LOOKBACK_DAYS`).
5. **Tune the alarm floors if they're wrong.** `CLV_ALARM_MIN` (12) and `GRADE_ZERO_ALARM_MIN` (5) are judgement calls, not measurements. The grading alarm also requires that ESPN returned finals for the sport+date, which should keep it quiet on afternoon runs — if it fires daily anyway, that condition needs tightening rather than the floor raising.
6. **Not touched, per instruction:** odds-budget allocation and PWA navigation. The budget is still on pace to overrun (`/budget` shows 12642/20000 at day 14, pace ×1.4, projected 27993) and the watchdog is correctly flagging it; that's the pre-existing D7 issue.

## Notes for whoever picks this up

- `index.html` was touched, but only the CLV render path (null `beat_pct` would have printed `null%`, and an unknown close was being coloured as a loss). Navigation untouched.
- `buildDataHealth` moved out of `src/index.js` into `src/health/data-health.js` — it was extracted to make the counting and error-classification logic directly testable, which is also how the 17 cases exist.
- There is still no test suite. The harnesses used here live in the session scratchpad, not the repo; they work by `sed`-rewriting the real module's import lines onto stubs, which tests the real logic but isn't something to rely on long-term. If a suite ever gets bootstrapped, the CLV close-selection cases are the ones worth keeping — that bug was invisible at small data volumes and only appears past ~1000 snapshot rows.
