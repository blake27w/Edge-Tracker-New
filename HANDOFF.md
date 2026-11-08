# Edge Tracker — Session Handoff

Last updated: 2026-11-08 02:40 UTC — **seven PRs open (#146–#152), all reviewed and tested, none merged. `main` is at `5b92d70`.** Credits are on; the loud-failure machinery surfaced five real bugs in one day and all five have PRs. **One action is Blake's and clears four live alarms: the DDL paste below.**

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
```

The `update` placeholder does not cast, so an unedited paste fails loudly and rolls the block back. No restart needed: `sharp`'s breaker closes on its next probe, `nfl-line-move` unlatches on its next insert. **Two more ALTERs are coming** from the diagnosis running at close (below) — expect to run a second short paste.

## Live state at close (read from /health and /budget)

- **Credits worked.** `claude.model = claude-haiku-4-5`; `public-splits` ran (16 splits); its `blocked` alert and `combat-weighin`'s **cleared by themselves** — first live proof of #137's clearing logic. `5002 snapshots (5002 written)` — #144's chunked insert is landing every batch.
- **Budget.** Day 7: 12,572 / 20,000 used, ceilings sum 18,520. Winter shares are live (D86). Cadence variables `ODDS_STRIKE_MIN=8 / NEAR=15 / MID=45` were set tonight; **measured evening burn 108 credits/hour** (~36 fetches/h, 20-min window at 22:00 ET, 2 sports already ceiling-capped) against ~1,408/day the day before — on track for roughly 700–800/day, near the 667 budget, before #149's post-tip tail lands. NCAAB/NHL/NBA remain the sports that cap first.
- **Standing alarms and their fix:** `sharp|blocked` and `nfl-line-move|blocked` + `write|nfl_line_moves` → the DDL above. `write|monitor_scores` (`"222.5"` — a **line**, not the price #150 fixes) and `write|api_usage` (`"1.5845"` into an integer column of the **budget persistence table** — if the month row is failing, the credit counter is not persisting across restarts) → **diagnosis running at close** (`fix/integer-columns`, worktree `wt-int`); expect two more `alter column … type numeric` and a sweep of every integer column in `schema.sql` for the same family.

## The PRs

| PR | what | tests / smoke | notes |
|---|---|---|---|
| [#146](https://github.com/blake27w/Edge-Tracker-New/pull/146) | this HANDOFF | — | docs |
| [#147](https://github.com/blake27w/Edge-Tracker-New/pull/147) | 📊 Splits tab, lines-only book switcher (D101) | 388 / 287 | per-book splits don't exist (D53); shows `—` + the real blocked reason until data flows |
| [#148](https://github.com/blake27w/Edge-Tracker-New/pull/148) | watchdog probes every hand-run column, both SQL files (D103, D106) | 351 / 275 | would have caught #136's missing columns on day one |
| [#149](https://github.com/blake27w/Edge-Tracker-New/pull/149) | 45-min post-tip polling tail for sports with no in-play consumer (D102, D107) | 391 / 254 | `sharp` now reports post-tip blindness as its own state |
| [#150](https://github.com/blake27w/Edge-Tracker-New/pull/150) | `price` columns → numeric; three writers report written/lost and block on total loss (D104, D108) | 356 / 251 | needs the two ALTERs above |
| [#151](https://github.com/blake27w/Edge-Tracker-New/pull/151) | grading: game-date-aware final matching, diacritics, stats by ESPN key, truthful zero alarm, doubleheader guard (D105, D109, D111) | 358 / 245 | **NHL SOG props were graded against shootout goals**; suspect rows: `monitor_scores where stat_type='player_shots_on_goal' and graded_at < deploy` |
| [#152](https://github.com/blake27w/Edge-Tracker-New/pull/152) | opp-grading: same wrong-game fix (D110) | 361 / 245 | **stacked on #151** — merge #151 first |

Merge order: #148, #149, #150, #147 (independent); #151 then #152. Each appended to `DECISIONS.md`, so expect append conflicts — resolve by keeping every entry (D101–D111 all present, in order). After the last merge: `npm ci && npm test` and `node tools/smoke.mjs` — zero failures is the only acceptable result (D82).

## What the day taught (beyond the PRs)

- **The frontend is GitHub Pages**, `https://blake27w.github.io/Edge-Tracker-New/` (D100). Every "Vercel" claim before 2026-11-06 was wrong.
- **The `gap_min` columns were never applied**, and I had recorded them as applied. The odds agent's strip-and-retry made the miss invisible until a reader selected the column. #148 exists so this cannot happen silently again.
- **The alarm population is the thing to check first.** CLV (#142), grading (#151) and the budget "overrun" (D87) were all alarms counting the wrong population; the floors were fine.
- **`integer` columns receiving medians, lines or ratios** are a family, not incidents: `pred_market_edges.price`, `monitor_scores.price`, and now `monitor_scores.<line col>` and `api_usage.<ratio col>`. The sweep in `fix/integer-columns` should find the rest once.
- **Two of today's bugs were collisions between this week's own changes** (#144's chunked stamps vs the opener's "first batch"; #151's wider date window vs repeated matchups). Every widening needs a "what else assumed the old shape" pass.
- **Rate limits killed four agents mid-flight today.** Relaunching from committed state was clean every time; the one time a builder's partial edits were left in the tree I discarded them before relaunching. Commit early.

## Follow-ups (none blocking)

1. The two new integer-column ALTERs + the family sweep (lane running at close).
2. `signal-engine`/`public-fade` add their dedupe key *before* the insert, so a rejected batch's rows are never rebuilt (D108).
3. `tennis-ingest`/`tennis-close` still write snapshots unchunked (D99).
4. The DDL regex in smoke misses `add x` without `column`, `schema.t`, `alter table only`, multi-add; three other channels still say "run scripts/schema.sql" (which aborts at the placeholder); `SQL_FILES` is a hardcoded pair (#148 review).
5. `nfl.live` treats a game live for 4h; the full tail is 3.5h (D107).
6. The steam breaker's probe is pinned to the soonest game (D94 note).
7. Per-book *splits* sourcing is a ToS/cost decision, not a build (D101).
8. **Watchdog alerts still reach zero recipients.** Every loud path built this week ends at `notifyAll`.
9. Odds API tier / drop NCAAB — still open levers if tonight's burn doesn't hold under #149.

## House rules (unchanged, reinforced)

`Number('')`/`Number(null)`/`Number('  ')` are a finite `0` — type-check before coercing. "Nothing happened" and "I cannot see it" must never look the same. A `blocked` reason is a constant literal. Zero expected failures. Read live config from the running service, not the repo. **And new today: when a column is `integer`, prove nothing writes a median, a line, a ratio or an average into it.**
