# Edge Tracker — Session Handoff

Last updated: 2026-11-06 — **six PRs open (#140–#145), all reviewed and tested, none merged. `main` is at `c075e70`.** Nothing is deployed from them yet. The Anthropic key is set in Railway but the account has no credits, so Claude-backed agents still report `blocked`.

## DO THIS, IN THIS ORDER

### 1. Merge the PRs — order matters only for `DECISIONS.md`

Every branch is off `main` at `c075e70` and independent **in code**. But each appended its own entries to the append-only `DECISIONS.md`, so from the second merge on GitHub will report a conflict there. **Resolve every one by keeping all entries** (both sides, in number order) — nothing is ever removed from that file. Suggested order, smallest conflict surface first:

| PR | branch | what | tests / smoke |
|---|---|---|---|
| [#140](https://github.com/blake27w/Edge-Tracker-New/pull/140) | `docs/handoff-post-merge` | this file + D100 (frontend is GitHub Pages, not Vercel) | — |
| [#141](https://github.com/blake27w/Edge-Tracker-New/pull/141) | `fix/small-fixes-bundle` | watchdog probes `book_move_log`; `public-splits` absent-vs-zero + the `num()` trap; iOS shell URL | 243 / 205 |
| [#142](https://github.com/blake27w/Edge-Tracker-New/pull/142) | `fix/clv-unmeasurable` | CLV alarm counts only plays that could have had a close (D98) | 245 / 203 |
| [#144](https://github.com/blake27w/Edge-Tracker-New/pull/144) | `fix/snapshot-insert-timeout` | `line_snapshots` chunked + retried; 1-in-4 silent batch loss ends (D99) | 258 / 202 |
| [#143](https://github.com/blake27w/Edge-Tracker-New/pull/143) | `feat/sharp-history-reader-2` | steam reads bounded history with interval intersection (D92–D95) | 271 / 224 |
| [#145](https://github.com/blake27w/Edge-Tracker-New/pull/145) | `feat/line-move-all-sports-2` | open→close movement for every sport (D95) | 250 / 219 |

`tools/smoke.mjs` will also conflict between #143 and #145 (both add sections at the end) — keep both sections. After the last merge, run `npm ci && npm test` in `edge-tracker-agents/` and `node tools/smoke.mjs` from the root: **zero failures is the only acceptable result** (D82).

### 2. Hand-run DDL — Supabase SQL editor, after #145 merges

```sql
alter table nfl_line_moves add column if not exists sport    text;
alter table nfl_line_moves add column if not exists open_ml  numeric;
alter table nfl_line_moves add column if not exists close_ml numeric;
alter table nfl_line_moves add column if not exists ml_move  numeric;
update nfl_line_moves set sport = 'NFL' where sport is null
  and captured_at < 'YYYY-MM-DDTHH:MM:SSZ';   -- <- THE TIME YOU RUN THIS, in UTC. Not the deploy time.
```

The placeholder does not cast, so an unedited paste fails loudly and rolls the whole block back. Why run-time and not deploy-time: the agent's pre-DDL retry writes NFL closes sportless after deploy; a deploy-time bound would leave those permanently unlabelled and invisible to history. (Review round 2 on #145 caught the comment saying the opposite.)

### 3. Railway

- **Add Anthropic credits** (console.anthropic.com → Billing), **then** redeploy once. The key is already set; the model probe runs once at boot and is never retried (D81), which is why it needs a boot *after* credits exist. Expected after: `/budget.claude.model` is a real model name; `public-splits` and `combat-weighin` drop `skipped — no Claude`; their two `blocked` entries in `/health.system.degraded` clear **by themselves** (first live proof of #137's clearing logic).
- Railway auto-deploys `main` on merge (environment `cozy-friendship / production`), so #142–#145 take effect on their own merges. The six winter `ODDS_ALLOC_*` shares are already set and live (D86).

### 4. Watch, in the first 24h after deploy

- `odds.lastResult` → `N snapshots (N written)` with **written == built** during an evening slate; `write|line_snapshots` stops climbing (#144).
- `sharp.lastResult` → leaves `"no recent line movement"` for `0 steam · N rows / …` (#143). Phone → 📡 Signal → Steam loses the radar. A real steam signal needs three books inside 35 min and is opportunistic.
- `clv-tracker.lastResult` → shows `in-play` / `untracked` / `no-close-capture` counts; `clv|unmeasurable` self-expires within 90 min and does not return (#142).
- `/plays.lineMove.bySport` → more than `NFL` once the DDL is in (#145). Phone → Signal → **Close** panel.
- Seasonality's first live release is still due **~19 Nov** (MLB, WNBA): `denom N/12` in the odds summary.

## What this session established (beyond the PRs)

- **The frontend is GitHub Pages**: `https://blake27w.github.io/Edge-Tracker-New/`, built from `main` on every merge, verified serving the current build. Every earlier "Vercel deploys main" claim was wrong (D100). `CLAUDE.md`'s deploy line is stale — fix in a dedicated change. Add to Home Screen from Safari → Share.
- **The CLV alarm was never about snapshots.** 7 live NFL plays + 8 tennis plays = the 15 "unmeasurable"; the alarm population was wrong, the floor was fine.
- **One in four evening odds runs was silently losing its whole snapshot batch** (57014, one unchunked statement with `RETURNING *` against 7M rows). Invisible by design until #144.
- **`Number(null) === 0` is now an eleven-time offender** across this repo's history (D79 family, `num()`, `moveIndexes`, `impliedProb`, the old line-move aggregates…). The house rule stands: type-check before coercing.
- **Six parallel lanes in isolated worktrees worked**; a rate limit killed three mid-flight once, and relaunching from committed state was clean every time. Commit early.

## Known follow-ups (none blocking)

1. `tennis-ingest:87` / `tennis-close:65` — same unchunked warn-only snapshot write as #144 fixed in `odds` (D99).
2. `book-move:127` reads `bets_pct` with `Number()` and is only correct because of the `>= 60` threshold after it.
3. The steam reader's breaker probe is pinned to the soonest game; a permanently sick game would keep it tripped (same idiom as `odds`, D76). Rotate the probe.
4. `agent-blocked.test.js`'s fleet census detects opt-in by grepping for `blocked:` property syntax — brittle to an idiom change.
5. **Watchdog alerts still reach zero recipients** (`notifyAll` needs `ALERT_NUMBERS` or `SMTP_*`). Every loud path built this week ends there. The old `~/edge-tracker` build had Twilio wired.
6. **Decision, not build:** add an originating book (Pinnacle/Circa) to the odds feed? All ten retail books classify as `follower` (D22). Costs credits against a budget whose demand is ~2.3× the pool (D87).
7. Odds API tier — same question as 6, still open.

## House rules earned this week

- `Number('')`, `Number(null)`, `Number('  ')`, `Number([])`, `Number(false)` are all a finite `0`, and `0` is never neutral here. **Type-check before coercing; never let `Number.isFinite` stand in for a presence check.**
- **"Nothing happened" and "I cannot see it" must never look the same.** Every alarm this week says exactly what it measures; every lost write is counted and named.
- **A `blocked` reason is a constant literal.** Interpolated counts reset the orchestrator's streak every run (D80) — caught three separate times this week.
- **A standing allowance for known-failing tests is how regressions hide** (D82). Baseline is zero.
- **Read live config from the running service, not the repo** — the env wins and the repo cannot see it (D92).
