# Edge Tracker — Session Handoff

Last updated: 2026-09-16 — learning-loop bundle applied; history closing-line fix; football budget priority.

## Current state

Four commits on `origin/main` this session (direct to main per Blake's instruction — see D2):

- `812fde1` — learning-loop bundle: NCAAF model, closing-line history (NFL + NCAAF), prop baselines from box scores, signal-tagged research picks. 10 files, 3 new agent dirs.
- `dfc012c` — `edge-tracker-agents/scripts/migrate-research.sql` (idempotent).
- `fc75f15` — core-API closing-line fallback + football floor.
- `7c6571d` — football stays in the cap denominator all season.

Deploy is live and all four new/changed agents ran. `nfl-props` rewrite works (1395 players off box scores, ESPN `/leaders` no longer used). `ncaaf-model` builds Elo fine (241 teams / 185 games).

**The binding constraint is the odds budget, not the agents.** 19915/20000 used by day 15, pace ×1.99, below the 1000 reserve — which is why ~30 agents report "no games on the slate" and `gamesMonitored: 0`. Nothing recovers September; the fixes below take effect at the Oct 1 reset.

## What was fixed and why it was wrong

- **History agents graded 124 of 588 games.** Not rate-limiting — ESPN empties `pickcenter` for older games (key stays, array goes to `[]`). Verified against 2024 NFL (5/5) and NCAAF (3/3). The core API still serves them. New `src/agents/shared/espn-odds.js` falls back to it. Providers matching `/live/i` are skipped: on ORE/MSU 2024 the live entry reads 39.5 against a 52.5 close, and unfiltered it would silently corrupt the O/U splits.
- **Football priority.** Two independent mechanisms, both on `FOOTBALL_PRIORITY=auto|true|false`. See D6 — the short version is that ceilings stop other sports *earning* an inflated share, the floor stops them *spending* football's unspent remainder, and neither alone is sufficient.

Note for whoever reads the old session log: an earlier claim in-session that sports were "overshooting their caps" was wrong and was corrected before any code was written. Nothing ever exceeded its cap; the caps were being recomputed loose because football was absent from the denominator.

## Verified vs unverified

- **Verified:** `node --check` on every changed file; `coreClosingOdds` smoke-tested live against both leagues, returning the close and not the live number; config loads and `footballPriorityOn()` returns true for Sep/Nov, false for Jul.
- **Unverified:** the budget changes are arithmetic simulation against the posted `/status` numbers, not a live run — there is no test suite in this repo. Real proof is the Oct 1 reset.

## Next steps

1. **Supabase migration — still owed.** SQL Editor → paste `edge-tracker-agents/scripts/migrate-research.sql` → Run. The history agents write to `nfl_closing_lines` / `ncaaf_closing_lines` and will error until it exists.
2. **Railway vars → Deploy:** `NCAAF_MODEL=true`, `NFL_LIVE=true`, `ODDS_SKIP_SPORTS=SOCCER,WNBA,BOXING`.
3. **Watch the Oct 1 reset.** Expect the odds status line to show `N held for football (floor N)` when a non-football sport pushes past its share. If it never appears, the floor isn't biting — check `FOOTBALL_PRIORITY`.
4. **Re-run the history agents after the migration** and check the new counters (`N no line`, `N fetch errors`). If `no line` is still large, ESPN genuinely lacks those games; if `fetch errors` is large, that's ours.
5. **Decide on the odds tier.** Even with both fixes, pace ×1.99 means the mix is bigger than a 20k starter plan. Either trim with `ODDS_ALLOC_<SPORT>` or move up a tier.
6. `HANDOFF.md` / `DECISIONS.md` / `CLAUDE.md` / `.claude/` were untracked stubs before this session — commit them so the next session starts from a real state.
