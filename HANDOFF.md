# Edge Tracker — Session Handoff

Last updated: 2026-10-14 — verified the Oct 1 budget reset (the fixes worked), reshaped the
odds allocation so NCAAF is no longer starved, shipped function-first IA phase 1 on a branch,
bootstrapped the repo's first automated checks, and audited line-movement tracking end to end.

## Current state

**Branch `feat/function-first-games` — 4 commits, pushed, PR open. Not merged.**

- `a918fc1` — Edge Tracker's `.claude/` pipeline made independent of Pool Room Pro's.
- `9539bb9` — function-first IA phase 1: consolidated Games view + 6 review fixes.
- `630d22c` — `tools/smoke.mjs`, the first automated check in this repo.
- `f455999` — CORS allows local dev origins.

### The Oct 1 reset: the September fixes worked

Verified against live production (`/health`, `/budget`, `/data-health`).

| | Sept (day 15) | Oct (day 14) |
|---|---|---|
| Used | 19915 / 20000 | 12642 / 20000 |
| Pace ratio | ×1.99 | ×1.4 |
| Football's share | 1064 of ~7450 | 6518 of 12642 (51.6%) |

- D4's closing-line fallback is confirmed **in the data**: `nfl-history` now has 634 games
  with closing lines (was 124 of 588); `ncaaf-history` has 2214/2257 (98.1%). The 43 and 3
  "no line" are games ESPN genuinely lacks — exactly the distinction D5 built.
- The Supabase migration was run and the Railway vars were set: 53 agents report **0 errors
  and 0 consecutive failures**, and SOCCER/WNBA/BOXING have no line items at all.
- "No games on the slate" is down from ~30 agents to 7.
- **The floor half of D6 is still unexercised.** `N held for football (floor N)` only prints
  when `skippedFootballFloor > 0`; football is spending its share, so there is no remainder
  to protect. The ceiling mechanism alone is carrying it. Correctly idle, not broken.

### `projectedMonthly` is misleading — do not act on it

`/budget` reports `projectedMonthly: 27993` against a 20000 budget, but that is a naive
linear extrapolation of `perDay` that ignores the per-sport ceilings. `capOf()` multiplies
the budget by **0.85** before dividing by share, so total spend is capped near 17000 by
construction. With `sumAlloc` = 0.82 in mid-October, `capOf(sport) = floor(20731.7 × alloc)`:

| Sport | Share | Cap | Spent (d14) | Status |
|---|---|---|---|---|
| NFL | 0.32 | 6634 | 3200 | 48% |
| NCAAF | 0.16 | 3317 | 3318 | **CAPPED** |
| MLB | 0.14 | 2902 | 2906 | **CAPPED** |
| NBA | 0.10 | 2073 | 35 | 2% |
| NHL | 0.06 | 1243 | 1245 | **CAPPED** |
| UFC | 0.04 | 829 | 831 | **CAPPED** |

The odds agent's own status line reads `4 budget-skips` — exactly those four. October lands
near **18114, under budget**. No tier change is needed. (The tiny overshoots are one
in-flight request landing past the check; `recordSpend` adds after the guard.)

**The real problem is shape, not size: NCAAF capped out on day 14 of its peak season** and
gets no refreshes for 17 days. A bigger tier would not fix this — the ceiling is a *share*,
so every sport scales together and NCAAF still caps at the same point in the month.

### Allocation reshaped — APPLIED 2026-10-14, live and confirmed

Set on Railway (project **cozy-friendship**, service **Edge-Tracker-New**, production):

```
ODDS_ALLOC_NCAAF=0.26   ODDS_ALLOC_MLB=0.04   ODDS_ALLOC_NFL=0.30
```

Same total; +0.10 to NCAAF, −0.10 from MLB (postseason-only and already past its new cap),
−0.02 from NFL (sitting at 48% of its cap). The service redeployed — the odds agent's `runs`
reset from 8666 to 1 — and the effect is visible in its own status line:

| | Before | After |
|---|---|---|
| budget-skips | 4 | **1** |
| Snapshots per run | 0 | **1072** |
| Calls per run | 0 | 5 |

New `sumAlloc` is 0.80, so `capOf = floor(21250 × alloc)`. **NCAAF's cap went 3317 → 5525**
against 3324 spent — from zero headroom to ~2200 credits for the rest of October, which was
the entire point. NHL (1243→1275) and UFC (829→850) also came off their caps. MLB stays
capped at 850 against 2906 already spent — intended; that is where NCAAF's credits came from.
Total possible spend is still ~17000, so the 0.85 ceiling is intact.

`projectedMonthly` now reads 28115. **Still ignore it** — same naive `perDay` extrapolation
that ignores the ceilings (D15).

Two artifacts of the restart, neither a problem: the first odds run reported `0 movements`
(the in-process `lastLines` baseline was wiped — finding 3 of the audit below, demonstrating
itself live), and the Claude usage counters in `/budget` reset to zero (in-memory state, not
lost spend; the real figure was $13.50 / 83 calls before the redeploy).

## In flight

Nothing half-written. Two things are built but unproven:

1. **The Games view has never been seen on a phone.** It was verified by me at a 375×812
   viewport against a stubbed backend (4 rapid taps → 1 request; a 500 latches an error
   without caching; a healthy sport renders over a failed one; a cached payload beats a
   stale error; refresh triggers exactly one refetch), plus 21/21 smoke checks. Blake was
   travelling and has not laid eyes on it. **Next step: merge the PR, then open the
   deployed PWA and tap the GAMES tile.**
2. **The CORS fix is unverified against a running server.** Confirming it needs a deploy;
   starting the orchestrator locally would spend real odds-API credits. After deploy:
   `curl -s -i -H "Origin: http://localhost:4318" <base>/health | grep -i access-control-allow-origin`
   should echo the origin back. It currently returns nothing.

## Next steps

1. ~~Reshape the odds allocation for football season~~ — **DONE 2026-10-14**, see above.
   Two follow-ups remain:
   - **Watch early November.** NCAAB entering season adds 0.06 to `sumAlloc` and silently
     recomputes every ceiling downward mid-season. With NCAAF now at 0.26 it has more to
     lose from that recompute than before, so check `/budget` when NCAAB appears in
     `bySport`.
   - **Revisit the shares when football season ends (after January).** These are
     football-season values set against the code's Sep–Jan defaults; MLB at 0.04 will be
     wrong by spring.
2. **Merge `feat/function-first-games`**, then check the Games view on a phone (above).
3. **Fix line-movement tracking — the audit is done, the work is not.** See the findings
   below; this is the next `/feature`.
4. **~1107 odds credits are ungoverned.** `used` is 12642 but the `bySport` entries sum to
   11535. Discretionary consumers (props, tennis, derivatives) go through `hasOddsBudget()`
   at `odds/index.js:65`, which checks only the global reserve and **no per-sport cap** — so
   ~9% of spend sits outside the allocation system entirely. A hole in the mechanism, not a
   tuning issue. Not covered by the data-integrity session.
5. **Four silent data faults** are being handled in a separate session (clv all-suspect,
   grading 0, the null `line_snapshots` count, the 36-second `/data-health`). The shared
   theme is that all four are invisible — 53 agents report no errors and `errorsToday: 0`.
6. **Phase 2 of the IA reorg** — consolidate the next function. Stats is the natural
   follow-up but is a real data merge across 5 implementations, not a wrapper. Log is the
   worst risk profile in the file (9 localStorage arrays). Dashboard needs `state.modelResults`
   / `propModelResults` / `slateData` keyed by sport first.

> **Next free decision number is D18.** The line-movement session was briefed that D17 was
> free; D17 was then taken by the allocation change. If that session also wrote a D17,
> renumber the later one.

## Line-movement audit (2026-10-14) — findings, no code written yet

The capture layer is sound and sport-agnostic. Everything downstream of capture is either
NFL-only, three-minutes-deep, or reads nothing at all.

1. **`line_movements` is a write-only table.** The only reference in the entire codebase is
   the INSERT at `odds/index.js:356`. No agent reads it, no route serves it, the PWA never
   fetches it, and it is not in `/data-health`'s monitored list. Every movement ever detected
   has been archived and never used. There is no learning loop on this signal.
2. **Live consumers see only the last ~3 minutes.** `sharp` and `public-splits` both read
   `getIntel('movements')` — the in-memory array from the most recent odds run. Older
   movement is invisible to steam/RLM detection despite sitting in Postgres. This is why
   `sharp` reports "no recent line movement" across 13,028 runs.
3. **Detection state is in-process.** `lastLines` (`odds/index.js:162`) is a plain Map;
   movement needs two consecutive fetches of the same book/market/side, so every redeploy
   wipes the baseline and the next fetch of each key detects zero movement.
4. **Four sports are currently dark.** Movement is computed only inside `normalize()`, which
   runs only on a fetch — and NCAAF/MLB/NHL/UFC are budget-capped (`break` at
   `odds/index.js:320`). Movement tracking is hostage to the allocation shape; see step 1.
5. **Open→close movement is NFL-only.** `nfl-line-move` self-gates to NFL, but
   `opening_lines` is written sport-agnostically and live consensus exists for every sport.
   The raw material is there for 12 sports and used for 1. **Cheapest big win.**
6. **Resolution is capped by cadence** — idle sampling is 3h × throttle, so a line that moves
   and returns inside that window never existed.

Suggested order: generalize `nfl-line-move` to all sports (reuses existing data, no new API
spend) → give `line_movements` a reader so steam queries history instead of a 3-minute
buffer → persist the movement baseline so restarts do not blind it.

**Checked and fine:** snapshot writing. `odds` writes `last_update` while the base schema has
`fetched_at`, but `schema.sql:794` adds `last_update` and `fetched_at` defaults to `now()`.
The null count in `/data-health` is almost certainly a count timing out on the largest table —
consistent with that endpoint taking 36s — not a broken write.

## Environment notes (cost real time this session)

- **The preview tooling reads Pool Room Pro's `launch.json`**, not this repo's, and offers
  `prp-dev` / `rackpay-*` / `vantyx-web`. `.claude/launch.json` exists here now but was not
  picked up; the static server had to be started by hand.
- **A Pool Room Pro Electron process holds ports 4317–4318**, Vantyx holds 3000, and
  `npx serve` silently falls back to a random port when its port is taken. Three rounds were
  spent looking at Pool Room Pro's login screen — correct file over `curl`, wrong app in the
  browser. `lsof -nP -iTCP -sTCP:LISTEN` is the fast diagnosis.
