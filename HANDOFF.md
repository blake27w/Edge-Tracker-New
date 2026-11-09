# Edge Tracker — Session Handoff

Last updated: 2026-11-09 06:05 UTC — **all eight PRs (#146–#153) are merged; `main` is at `35b91ee` plus this docs merge.** On merged `main`: `npm test` 483 / 0 failed, `node tools/smoke.mjs` 332 / 0 failed. Railway and GitHub Pages redeploy from `main` automatically. **One action is still Blake's and clears four live alarms: the DDL paste below. It has not been run.**

## OWED NOW — Blake, Supabase SQL editor, one paste

```sql
-- #136 (NEVER APPLIED — sharp has been blind on this for 229+ runs)
alter table line_movements add column if not exists gap_min         numeric;
alter table line_movements add column if not exists baseline_source text;
-- #145 (nfl-line-move drops every non-NFL close until this runs)
alter table nfl_line_moves add column if not exists sport    text;
alter table nfl_line_moves add column if not exists open_ml  numeric;
alter table nfl_line_moves add column if not exists close_ml numeric;
alter table nfl_line_moves add column if not exists ml_move  numeric;
update nfl_line_moves set sport = 'NFL' where sport is null
  and captured_at < 'YYYY-MM-DDTHH:MM:SSZ';   -- <- THE TIME YOU RUN THIS, UTC (not the deploy time)
-- #150 (a median moneyline is fractional on an even book count; integer columns reject the whole batch)
alter table pred_market_edges alter column price type numeric;
alter table monitor_scores    alter column price type numeric;
-- #153: Claude's dollar cost was going into an integer column
alter table api_usage alter column used   type numeric;
alter table api_usage alter column budget type numeric;
```

The `update` placeholder does not cast, so an unedited paste fails loudly and rolls the block back. No restart needed: `sharp`'s breaker closes on its next probe, `nfl-line-move` unlatches on its next insert, and #148's watchdog column probes stop firing. **This is the complete paste; no second one is coming.**

## What merged tonight (2026-11-09 05:50–06:02 UTC)

Order: #148, #149, #150, #153, #147, #151, #152 (retargeted from `fix/grading-bug` to `main`), then #146 (this file). Every branch was synced to `main` before merging; conflicts were all appends and were resolved by keeping both sides:

- `DECISIONS.md` — union merge; D101–D112 all present (not in numeric order, by design — append-only).
- `tools/smoke.mjs` — three PRs each added a "§17". Final numbering: §17 post-tip tail (#149), §18 price alter columns (#150), §19 Splits tab (#147). One shared closing brace was dropped by the merge and restored by hand (`d628d50`).
- `edge-tracker-agents/scripts/schema.sql` — both hand-run ALTER blocks kept (#150's price columns, #153's api_usage columns).

The branches were left in place (`--delete-branch=false`); delete them whenever.

## Live state at close (read from /health and /budget, 05:58 UTC — before the new deploy had necessarily landed)

- **Credits on.** `model = claude-haiku-4-5`, `anthropicCallsToday = 1`. Odds: `540 snapshots (540 written)` — chunked insert landing every batch.
- **Budget.** Day 9: 14,290 / 20,000 used, 5,712 remaining. The `projectedMonthly` (47,633) and `paceRatio` (2.38) are the D15/D87 naive extrapolation of the first eight days; the cadence variables (`ODDS_STRIKE_MIN=8 / NEAR=15 / MID=45`) landed on day 8 and measured **108 credits/hour** that evening. With #149's post-tip tail now live, the remaining 5,712 credits must cover 21 days ≈ **272/day**. That is tight: NCAAB, NHL and NBA cap first. **Open levers:** Odds API tier upgrade, or `ODDS_SKIP_SPORTS=NCAAB`. Watch `/budget.used` daily; if the day-over-day delta is above ~270 by day 12, pull one.
- **Standing alarms:** `sharp` reports `blind — history read failed for 9/9 games` (the `gap_min` column — the DDL above). `nfl-line-move|blocked` and `write|nfl_line_moves` (`close_ml` column — the DDL). `grading` shows `graded 0 · 8 queued` — #151 is the fix and it just deployed; the next few grading runs are the proof. `public-splits` printed `0 splits` at 05:58 — likely the post-merge restart clearing memory mid-cycle (it produced 16 the night before); if it is still 0 after two more 4-hour cycles, read its `blockedReason`.

## Watch list for the first day on this `main`

1. `/health` after the deploy settles: the four alarms above should be the ONLY degraded keys. Any `write|pred_market_edges`, `write|monitor_scores` or `write|api_usage` recurrence means the ALTERs are still unrun (expected until the paste).
2. 📊 Splits tab on the phone (GitHub Pages rebuilds in ~2 min): both-side percentages once `public-splits` runs, `—` with the real blocked reason until then; switching books changes lines only.
3. `grading` after the next slate: `graded N (W-L-P)` non-zero with finals present; the NHL SOG rows graded before this deploy are suspect: `monitor_scores where stat_type='player_shots_on_goal' and graded_at < '2026-11-09T06:00Z'`.
4. `/budget.claude.persisted` — `false` until the `api_usage` ALTERs run, then `true`.

## Follow-ups (none blocking)

1. `signal-engine`/`public-fade` add their dedupe key *before* the insert, so a rejected batch's rows are never rebuilt (D108).
2. `tennis-ingest`/`tennis-close` still write snapshots unchunked (D99).
3. The DDL regex in smoke misses `add x` without `column`, `schema.t`, `alter table only`, multi-add; three other channels still say "run scripts/schema.sql" (which aborts at the placeholder); `SQL_FILES` is a hardcoded pair (#148 review).
4. `nfl.live` treats a game live for 4h; the full tail is 3.5h (D107).
5. The steam breaker's probe is pinned to the soonest game (D94 note).
6. Per-book *splits* sourcing is a ToS/cost decision, not a build (D101).
7. **Watchdog alerts still reach zero recipients.** Every loud path built this week ends at `notifyAll`.
8. Odds API tier / drop NCAAB — see the budget line above; this is now a this-week decision, not a someday one.
9. `smoke.mjs` has two sections numbered §16 (open→close and CLV alarm population) from an earlier merge; cosmetic.

## House rules (unchanged, reinforced)

`Number('')`/`Number(null)`/`Number('  ')` are a finite `0` — type-check before coercing. "Nothing happened" and "I cannot see it" must never look the same. A `blocked` reason is a constant literal (D80). Zero expected failures (D82). Read live config from the running service, not the repo (D92). When a column is `integer`, prove nothing writes a median, a line, a ratio or an average into it. The frontend is GitHub Pages, not Vercel (D100). Append-only `DECISIONS.md` conflicts are resolved by keeping every entry.
