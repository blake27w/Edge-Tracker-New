# Edge Tracker — Golf & Tennis Research Module (Scoping Doc)

A separate agent module for golf and tennis that plugs into the existing Edge Tracker dashboard, Supabase, orchestrator, and CLV tracker. It does NOT use the Under bias (doesn't apply to these sports). Instead it is built entirely around information asymmetry and soft-market exploitation, consistent with the CLV-first philosophy.

## Core Edge Philosophy (replaces the Under bias for these sports)

The books have strokes-gained, rankings, recent form, and surface splits priced into the headline markets. Our edge is NOT a better stats model — it's finding the gaps:

1. **Derivative markets > headline markets.** Outright golf winners and tennis match-winner lines have the most sharp attention and highest hold (golf outrights carry 30-40%+ overround). Play the softer derivatives instead: golf matchups, 3-balls, top-10/top-20, make/miss cut; tennis set betting, games handicaps, live. This is the structural "default lean" — the golf/tennis equivalent of the Under bias.
2. **News speed** — withdrawals, late injury news, and weather/tee-time wave splits, before the market adjusts.
3. **Lower-tier events** — Challenger/ITF tennis, smaller golf tours: less linemaking attention, softer numbers, smaller limits but bigger edges.
4. **Live/in-play** — both sports reprice slowly vs. what's actually happening on the course/court.

**CLV is the north-star metric**, same as the main system. A pick is "good" if it beats the closing line, not if it wins. Signal weights tune off CLV over time, never off small-sample win rate.

**Variance caveat (sizing rule):** golf outrights and tennis upsets are inherently high-variance. Default unit sizing for this module is HALVED vs. the team-sport model (max 0.75u instead of 1.5u) until a 200+ pick CLV sample proves the edges. Outright golf winner bets are capped at 0.25u regardless of confidence — they are lottery tickets even when +EV.

---

## Shared Infrastructure (reuse, don't rebuild)

- **Supabase** — same project, new tables (prefixed `golf_` and `tennis_`)
- **Orchestrator** — register these agents in the existing cron scheduler
- **CLV Tracker** — extend to capture golf/tennis closing lines (matchups close at tee time; tennis at first serve)
- **Dashboard** — add two new tabs to the Agents dashboard: "⛳ Golf" and "🎾 Tennis", each showing agent status, qualifying plays queue, and event calendar
- **Public Splits Agent** — extend to scrape golf/tennis betting % where available (sportsbettingdime, etc.)
- **Cost-optimized scheduling** — Claude-backed agents run on reduced frequency, only when a tournament/tournament-week is active (cost guard: skip entirely if no active event)

---

## GOLF AGENT TEAM

### G1: Field & Market Ingestion
- Pull the full field + ALL market types across books, with emphasis on derivatives: matchups (tournament + round), 3-balls, top-5/10/20, make/miss cut, first-round leader, nationality/group props
- Track hold per market type to identify the softest books per market
- Store: `golf_markets` (event, player, market_type, book, line, price, snapshot_at)
- **Primary data: DataGolf** (the sharp standard — predictive model, SG data, course fit, and their own win probabilities that can be compared directly to market price). PGA ShotLink secondary.

### G2: Course Fit Engine
- Match course characteristics (length, rough penalty, green size, grass type — bentgrass/bermuda/poa, elevation, wind exposure, scoring average) to player shot profiles (SG: off-tee, approach by distance band, around-green, putting by surface)
- Edge: the market prices generic "course history"; we price granular shot-profile fit the market underweights (e.g., a bomber's track favoring distance, small greens favoring elite scramblers)
- Compare our fit-adjusted projection to DataGolf's model AND to market price — flag where market diverges from both
- Store: `golf_course_fit`

### G3: Weather & Wave Agent (THE golf edge — highest priority)
- Pull tee-time wave assignments (AM/PM) + hour-by-hour forecast (wind, rain, temp) per round
- Detect scoring-condition splits between waves BEFORE the market fully adjusts — a wave playing into 20mph wind vs. a calm wave is a massive scoring difference
- Feeds: first-round leader markets, round matchups, make-cut, and live repricing
- This is pure information asymmetry — reading the forecast vs. wave draw before the book moves the line
- T1 signal when a significant wave split is detected
- Store: `golf_weather_waves`

### G4: Withdrawal & Motivation Agent
- Monitor late WDs, injury whispers, equipment/swing changes, scheduling fatigue (player in a long stretch, post-major letdown, travel), motivation flags (limited-field vs. signature event, missed-cut streaks)
- News-speed edge: a late WD repricing the matchup the player was in
- Claude + web search, run during tournament weeks only
- Store: `golf_player_news`

### G5: Live Tournament Agent (Phase 2)
- After each round, compare a player's strokes-gained underlying vs. leaderboard position
- Flag players whose score over/understates their actual play (putting variance regresses; ball-striking sustains) — bet the regression in live matchup/top-finish markets
- Store: `golf_live_signals`

---

## TENNIS AGENT TEAM

### T1: Match & Market Ingestion
- Pull match lines + derivatives across books, emphasis on softer markets: set betting, games handicaps (spread), total games over/under, live
- Cover ATP, WTA, AND lower tiers (Challenger/ITF) — the lower tiers are where the softest lines are
- Track per-book hold and softest-book-per-market
- **Primary data: Tennis Abstract / Jeff Sackmann match logs** (the analytics standard), surface-split data
- Store: `tennis_markets`

### T2: Surface & Style Matchup Engine
- Surface splits (hard/clay/grass), style-clash modeling (big server vs. returner, baseline grinder vs. aggressor), H2H on the specific surface
- Edge: market prices ranking + recent form; we price the style/surface interaction the market underweights (e.g., a clay grinder vs. a flat-hitting hard-courter on clay)
- Store: `tennis_matchups`

### T3: Fatigue & Schedule Agent (THE tennis edge — highest priority)
- Track minutes/sets played in recent days, days of rest, travel + time-zone changes, back-to-back tournament weeks, altitude adjustments
- A player who went 5 sets / 3.5 hours two days ago vs. a straight-sets winner is a real, quantifiable edge the market prices loosely
- T1 signal on significant fatigue differential
- Store: `tennis_fatigue`

### T4: Injury & Retirement Risk Agent
- Monitor medical timeouts and physical knocks in recent matches, retirement history, on-court distress signals
- Feeds live and pre-match; note each book's retirement-rules (affects whether a play is graded action/no-action)
- Claude + web search
- Store: `tennis_player_news`

### T5: Live/Momentum Agent (Phase 2)
- Point-by-point win-probability model vs. the live price — break points, serve holds, momentum swings
- Tennis is the most-live-bet sport in the world; slow repricing is the edge
- Store: `tennis_live_signals`

---

## Shared Signal Engine (Golf/Tennis variant)

Same gate structure as the main Signal Engine, but reweighted for these sports:

- **Tier 1 (information asymmetry, +20):** golf weather/wave split, late WD/injury repricing, significant tennis fatigue differential, a market price diverging from BOTH our model and DataGolf/Sackmann
- **Tier 2 (+10):** granular course-fit or surface/style-matchup edge vs. market; soft derivative-market mispricing; lower-tier-event softness
- **Tier 3 (confirmation only, +3):** recent form, ranking, raw H2H, course history — the stuff the books already have. Never qualifies a play alone.
- **No play qualifies on Tier 3 alone.** Requires a T1 or a T2 market-divergence signal.
- **Market preference:** the engine should prefer derivative markets (matchups, 3-balls, set betting, games handicaps) over headline markets (outright, match-winner) — flag when the same edge is playable in a softer market.

---

## Build Order

1. Shared: dashboard tabs (Golf/Tennis), Supabase tables, orchestrator registration, CLV extension
2. Golf G1 (market ingestion) + G3 (weather/wave) — wave splits are the single highest-value golf edge
3. Tennis T1 (market ingestion) + T3 (fatigue) — fatigue is the single highest-value tennis edge
4. G2 course fit + T2 surface/style matchup
5. G4 + T4 news/withdrawal agents
6. Public-splits extension for golf/tennis
7. Phase 2: G5 + T5 live agents

## Data Sources to Secure

- **DataGolf** (golf — the sharp standard; has an API, ~$30/mo, worth it)
- **Tennis Abstract / Jeff Sackmann** (tennis match logs, open data)
- The Odds API (already have — covers golf outrights + tennis match lines; derivatives may need a supplementary feed)
- Weather (reuse existing weather agent infrastructure)
- Tee times (PGA Tour site / DataGolf)

## Strategic Note

Golf and tennis are lower-volume and higher-variance than the NFL/MLB core, and the subscriber market is smaller. This module is best positioned as a **premium add-on** to the picks service rather than the headline product — "year-round coverage including golf majors and Grand Slams." Build it after the core NFL/MLB system is proven, but the architecture above lets it share all the existing infrastructure so the marginal build cost is low.
