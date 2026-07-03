# NFL Deep Build — Scope & Status

Target: live by Week 1 (early September). Biggest subscriber market. All
components are $0 (free ESPN + our own odds feed) unless noted. New signals
stay **observational** until they show positive CLV over an adequate sample.

Philosophy (unchanged): CLV is the north-star; information asymmetry over
trends; books price the obvious; our edge is speed + soft/derivative markets +
line-vs-public. Under bias applies to totals.

## Component status

| # | Component | Status | Notes |
|---|---|---|---|
| 1 | Preseason power ratings | ✅ built (`nfl-power`) | prior-season Elo regressed to mean; feeds spreads + win totals |
| 2 | Season win-totals model | ✅ built (`nfl-win-totals`) | model wins vs posted O/U |
| 3 | Situational / schedule spots | ✅ built (`nfl-schedule`) | short week, off-bye, rest edge, long road, lookahead |
| 4 | Prop workload baselines | ✅ built (`nfl-props`) | prior-year volume regressed to mean |
| 5 | Key Number Engine | ✅ exists (`key-number`) | NFL spreads: buy/sell past 3,7,6,10,14,4. Possible enhancement: quantify half-point EV |
| 6 | Weather (NFL mode) | ✅ exists (`weather`) | high wind → Under, direction-agnostic for football |
| 7 | **Scoring-environment / totals model** | ✅ built (`nfl-totals`) | off/def points-per-game ratings from prior-season finals → projected game total → Under/Over lean. THIS DOC'S BUILD. |
| 8 | Coaching / pace module | ✅ built (`nfl-pace`) | curated team-tempo map (pace + pass tendency, like MLB park factors) → totals lean; no verified free pace feed, so review each offseason / override via NFL_PACE_OVERRIDES. Reference/observational |
| 9 | Injury / inactives-speed agent | ✅ built (`nfl-inactives`) | self-gates to NFL games near kickoff (dormant offseason); flags key skill-position OUTs + Under lean + how early caught. Observational |
| 10 | Derivative ingestion | ✅ built (`nfl-derivatives`) | team totals +EV (devigged); OFF by default (`NFL_DERIVATIVES=true`), daily-capped, self-gates. Add alt_totals/alt_spreads via `NFL_DERIVATIVE_MARKETS` |
| 11 | Opener→close CLV (NFL) | ✅ built (`nfl-line-move`) | per-game open→close total/spread move + history aggregate; self-gates (dormant offseason). Reference |

## Wiring notes
- Offseason prep agents run on slow daily cadences and produce reference data.
- In-season, the general agents (odds, sharp, injury, weather, public-splits,
  key-number, ev/arb/stale/divergence) already cover NFL once games appear.
- Signal-engine wiring of NFL-specific leans (pace, scoring-environment) should
  be added as **Tier-3 confirmation** first (never qualifies alone), then
  promoted only if the per-signal CLV scorecard shows it beats the close.

## Next up (recommended order)
1. ✅ Wired: `nfl-totals` + `nfl-pace` leans → signal engine as T3 confirmation.
2. ✅ Built: injury/inactives-speed (#9) + QB-status monitor (`nfl-qb`).
3. ✅ Built: key-number EV quantification (#5), calibrated from 2025 finals.
4. Derivative ingestion (#10) — flip on at Week 1 under the credit governor.

## Props model backtest findings (2025 season, scripts/nfl-props-backtest.js)
- **Baselines are reference-only, permanently.** Prior-year volume predicts
  early-season output too loosely to price lines (best market: pass yds, 77%
  within ±25% — i.e. ±57 yds). Never wire baselines as a scored signal.
- **Yardage props are near-random game to game** (rush/rec yds CV ~81%);
  pass yds (35%) and volume stats (52-55%) are the model-trustable markets.
  Prop flags now require 3+ books for a real consensus.
- **Rolling-usage model: KILLED by the data.** Usage shifts do NOT persist
  (receptions 48%, rush att 55% — at/below the validation bar). Books are
  right to be slow on usage changes; there is no edge there. Do not build.
- The prop edge remains PRICE (stale book vs 3+-book consensus at trigger
  moments) validated live via prop close-capture → CLV, not prediction.
