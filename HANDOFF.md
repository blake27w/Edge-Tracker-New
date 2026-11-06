# Edge Tracker — Session Handoff

Last updated: 2026-11-05 — **all three PRs merged (#137 loud blocked agents, #138 Signal dashboard + restyle, #139 automatic seasonality). `main` is at `c075e70`, zero open PRs, 231 tests / 202 smoke, no failures.** Nothing is deployed yet: GitHub Pages auto-deploys `main` for the PWA (NOT Vercel — see Next steps 1), but the backend changes need a Railway deploy, and the two env blocks below are still unset.

## OWED NOW — Railway env (both Blake's, neither is code)

```
ANTHROPIC_API_KEY=<your key>          # revives public-splits + combat-weighin; REQUIRES A RESTART
ODDS_ALLOC_NFL=0.26   ODDS_ALLOC_NCAAF=0.13   ODDS_ALLOC_MLB=0.02
ODDS_ALLOC_NBA=0.22   ODDS_ALLOC_NCAAB=0.14   ODDS_ALLOC_NHL=0.14
```

**Status 2026-11-05 23:30 UTC (read live from `/health` and `/budget`):** the new backend IS deployed; the key IS
set — but `detectModel()` found no model at boot, so both Claude agents report `blocked` with the D81 "set but no
model" message and `/budget.claude.model` is `null`. **Next action: one restart.** If it persists, read the Railway
startup log for the `detectModel` line — the key is being rejected. The six shares are **not** set yet; note three
of them (`NFL`, `NCAAF`, `MLB`) already exist in Railway with other values (0.30 / 0.26 / 0.04) and must be
**edited**, not added (D92).

The key needs a **restart**: the Anthropic client is built once at module load and `detectModel()` runs once
at boot, never retried (D81). The shares do **not** — `capOf()` reads them per call (D86). Seasonality is merged,
so the shares are a *shape* knob only; membership takes care of itself (MLB is `seeding · 14d left`).

## What merged today (all on `main` now)

| PR | branch | what | tests / smoke |
|---|---|---|---|
| #137 | `feat/loud-agent-skips` | a persistently `blocked` agent announces itself via `reportDegraded` → watchdog + `/health`; threshold 1; reason from one audited helper that distinguishes "key not set" from "key set but no model detected" (D80, D81) | 148 / 134 — tester verdict **merge** |
| #138 | `feat/signal-dashboard` | a 📡 Signal home tab (Health · Budget · Books · Steam), zero new fetches, five honest empty states; fixes `applyAgentsBag` swallowing failed reads; **restyled** to the look Blake chose — mint accent, JetBrains Mono, chamfers, grid + scanlines, scoped under `.sighud` (D83–D85) | 156 / 167 — verified in a browser at 375px against the live backend |
| new | `feat/auto-seasonality` | a sport's share releases itself when its season ends, from the already-made free `/sports` call — entry immediate, release after 14 **observed** quiet days, fail-safe tight, D6's football backstop kept (D89–D91) | 231 / 196 — tester drove a 132-day simulated season against an independent oracle, verdict **merge** |

**Install deps first.** There is no "expected failures" allowance any more — `npm ci` in `edge-tracker-agents/` and
everything is 0-fail (D82). Any failure is real.

## What the live render told us (the dashboard, day 5 of November)

- **All ten books classify as `follower`** (led% 1.3–16.2). Nobody leads — D22's ceiling made visible: no
  originating book in the feed, so the metric measures who copies the market fastest.
- **The month is NOT overrunning; the shape was wrong.** `projectedMonthly 39372` is unreachable — ceilings sum to
  ~17 000 by construction (D87, and D15 was right). But NCAAB/NHL/NBA sat at 91/87/87% of their ceilings while
  football held 0.48 of the pool at 18–28% used and MLB held 0.14 through its offseason (D86). Aggregate demand is
  ~2.3× the pool, so ceilings will switch sports off one at a time — September's "no games on the slate" by a
  different route. Reallocation changes *which* sports go dark, not *whether*.
- **`public_splits` wrote 0 rows today** (671 total) because `ANTHROPIC_API_KEY` is unset — so the against-public
  component of every `book-move` score is contributing nothing. Scores are narrower, not wrong: a missing component
  is renormalized to neutral. The dashboard says *"This is not 0%."* rather than rendering a flattering zero.
- **The ceilings in that analysis were modelled, not observed** (D88) — `getOddsCeilings()` is written but not
  deployed. Landing #138 + the Railway deploy makes the next tuning pass measured.

## In flight / loose ends

- **Scratch worktrees are cleaned up** (`wt-dash`, and a reviewer's `base`). The checkout at `~/Edge-Tracker-New`
  itself is still at `50b4fbb` — pull it before working there.
- **GitHub rejected every push to this repo for ~3 minutes during the merge** (`remote: fatal error in commit_refs`,
  even for an empty probe commit on `main`; githubstatus reported all systems operational). It cleared on its own.
  If a push fails with that message, wait and retry — it is not the branch.
- **Two design artifacts** (Signal HUD mockup; the options page Blake chose from) live in the scratchpad only. They
  are references, not deliverables — the restyle in #138 is the deliverable.
- **`ios-app/capacitor.config.json` points `server.url` at `https://blake27w.github.io`** — the old GitHub Pages
  address, not Vercel. It is a thin shell over the live site (`www/index.html` is a 205-byte stub), so if that
  wrapper is in use it is loading a stale copy. If Blake uses the Safari home-screen PWA instead, this is moot.
- **The seasonality feature's first live release is ~19 Nov** (MLB and WNBA after 14 observed quiet days). Until
  then the claim rests on the simulation. Watch `denom N/12 (…)` in the odds run summary and the `why in` column
  on the dashboard's Budget panel.

## Next steps

1. **The frontend is GitHub Pages, not Vercel** — `https://blake27w.github.io/Edge-Tracker-New/`, built from `main`
   on every merge (the repo's `vercel.json` has never produced a Vercel deployment; the GitHub deployments list shows
   only `github-pages` and Railway). Verified serving the current build on 2026-11-06. The PWA picks up each merge on
   next open (network-first SW with `skipWaiting`, `no-cache` on `index.html`; no reinstall). Add to Home Screen from
   Safari → Share → Add to Home Screen.
2. **Deploy the backend on Railway** (seasonality, loud skips, `getOddsCeilings()` are all server-side) and set the
   two env blocks above. The dashboard's Budget panel shows *"Ceilings unavailable"* until that build is live.
3. **Watch three things after deploy:** `public-splits` flips off `"skipped — no Claude"` and the `blocked`
   watchdog issue clears by itself; `vs_public_n` on `bookMoves.byBook` starts climbing; `staleBaseline` and
   `baseline <hydrated>/<attempted>` in the odds summary on the first redeploy (D76).
4. **Decide the Odds API tier.** Demand measured at ~2.3× the allocatable pool (D87). Rebalancing and seasonality
   change *who* goes dark; only cadence cuts or a larger tier change *whether*. Blake picked rebalance only; the
   other two levers are untouched and the question is still open.
5. **Phase: point `sharp` at a history reader** — spec written and shelved at `docs/specs/sharp-history-reader.md`.
   The Steam panel renders NOT FIRING until this lands; it is the thing the dashboard most visibly cannot show.
6. **Phase: generalize open→close movement to all 12 sports** — `docs/specs/line-move-all-sports.md`.
7. **Teach `public-splits` absent-vs-zero** — the two-feed split (D77) worked around the `?? 0` trap, not fixed it.
8. **`book_move_log` still not in the watchdog's schema probes** — one line.
9. **Watchdog alerts still reach zero recipients** (`notifyAll` needs `ALERT_NUMBERS` or `SMTP_*`). Every "make it
   loud" path this session built terminates here. The old `~/edge-tracker` build had Twilio wired — possibly a
   solved problem sitting in the archive. Deprioritised by Blake 2026-10-28; noted, not dropped.

## House rules earned this session

- `Number('')`, `Number(null)`, `Number('  ')`, `Number([])`, `Number(false)` are all a finite `0`, and `0` is never
  neutral here. Six shipped bugs now (D10, D67, #133's `crossedKey(null)`, D79, the `intEnv` motivation, D79 again
  in `steamSafeMovements`). **Type-check before coercing; never let `Number.isFinite` stand in for a presence check.**
- **"Nothing happened" and "I cannot see it" must never look the same.** The 13 000-run `sharp` silence,
  `applyAgentsBag`'s swallowed reads, the un-alerted dead `public_splits` feed, and the silent sentinel write were
  all the same bug. Every new condition this session reports *why*, including when the answer is "no data".
- **A standing allowance for known-failing tests is how regressions hide** (D82). Baseline is zero.
