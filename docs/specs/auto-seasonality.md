# Automatic seasonality for the odds budget [SHIPPED 2026-11-05]

Branch `feat/auto-seasonality`, based on `001acd6`.

## Problem

Per-sport ceilings are `monthlyBudget × POOL(0.85) × share / sumAlloc`, where `sumAlloc` sums the
shares of the sports **in the denominator** (`nominalCap`, `edge-tracker-agents/src/agents/odds/index.js:163`;
the live denominator is `lastDenom`, `:178`, `:200`, set at `:792`). Who is in that denominator is
decided by today's board plus a hand-coded football month range, so **every season change needs a
human to notice and retune** — measured on day 5 of November (D86): NCAAB/NHL/NBA at 91/87/87% of
ceiling, NFL+NCAAF holding 0.48 of the pool at 18% and 28% used, MLB holding 0.14 through its
offseason. This spec makes the *membership* of the denominator derive itself from data we already
pay for, so the next season change does not need Blake at all.

**The root cause nobody has written down yet.** The `billed` term at `:790-791` puts every sport with
`bySport[s] > 0` into the denominator and never removes it — deliberately, so a season *ending*
cannot inflate everyone else mid-month. MLB has spent **1 credit** in November (HANDOFF open item 3).
That one credit buys MLB membership, and therefore 0.14 of `sumAlloc`, for the whole month. So the
fix is not "add a season signal"; it is "add a season signal **and gate `billed` by it**".

## Approach

### The in-season signal: trailing memory of the free `/sports` active flag

`inSeasonKeys()` (`odds/index.js:671`) already calls `GET /v4/sports` **every run**, and that
endpoint is **not billed** (the comment at `:670` states it; it is also outside the
`markets × regions` billing model and returns no odds). It yields one boolean per league key:
`active`. That flag is exactly the thing that flaps — which is why D6 exists.

The signal is therefore not the flag but a **persisted per-sport "last seen active" date**, with an
asymmetric release grace:

```
graceDays = ODDS_SEASON_GRACE_DAYS (default 14)
today     = new Date().toISOString().slice(0,10)         // UTC calendar day
state     = { [SPORT]: { first: 'YYYY-MM-DD', last: 'YYYY-MM-DD' | null } }
```

Per run, after `inSeasonKeys()`:

1. `active === null` (feed unreadable — non-200, throw, DNS): **write nothing**, and treat every
   non-`oddsSkip` sport as `in`, reason `feed-unreadable`. That is today's behaviour (`:764`) and the
   tight side. Not writing matters: refreshing `last` on an unreadable feed would silently extend a
   dead sport's season by another 14 days, forever, on a flaky network.
2. Otherwise, per non-`oddsSkip` sport `S`:
   - `activeNow = (meta.leagues || [meta.key]).some(k => active.has(k))`
   - no entry yet → create `{ first: today, last: activeNow ? today : null }` (**seeding**)
   - `activeNow` → `last = today`
   - `in(S)` iff `activeNow || ageDays(last ?? first) <= graceDays`
3. `out(S)` = `S` is non-`oddsSkip` and `!in(S)`.
4. **Denominator** = `{S : in(S)}` ∪ `{S : bySport[S] > 0 && !out(S)}`.
   The second term keeps `oddsSkip` sports (TENNIS, GOLF) entering exactly as they do today — they
   have no bare Odds API key, never appear in `active`, and are deliberately excluded from the sweep
   (D64/D65 depend on this). The `&& !out(S)` is the whole fix: it is what releases MLB.

**Hysteresis.** Entry is immediate on one active observation; release requires `graceDays` of
*consecutive* runs with no active observation. Because any active observation writes `last = today`,
a sport cannot be released and re-enter within a grace window — at most one release transition per
sport per 14 days. Entry (the flapping direction) only ever *tightens* other sports' ceilings, which
is the harmless direction; release is the rate-limited one.

**14 days covers every real intra-season gap in our sport list**: NFL/NCAAF weekly, NBA/NHL/NCAAB
nightly, MLB's All-Star break 4 days, NBA's 5. The two it does not comfortably cover are named in
Risks.

**Why not the alternatives.**

| candidate | verdict |
|---|---|
| today's board / `/sports` flag alone | **This is the September bug** (D6). Football's 0.48 leaves the denominator on a Tuesday and soccer's cap goes ~700 → ~2040. Rejected outright. |
| trailing window of `line_snapshots` | No index on `(sport, fetched_at)`; the table is 6.7M rows and has already statement-timed-out twice (D13, D68). Worse, it is **circular**: a budget-starved sport stops writing snapshots, which would then read as "season over" and release its share — a feedback loop pointed the wrong way. |
| `opening_lines` | No `sport` column (`game_id, market, line, side, captured_at`). Not derivable. |
| declared season calendar in config | Needs a human every year — the exact cost this feature removes — and cannot express an early elimination, a late playoff run, or UFC/BOXING/TENNIS, which have no season at all. |
| `FOOTBALL_PRIORITY` month ranges, generalised | Same objection, times twelve. Twelve hand-maintained month sets is more tuning surface than the six shares we are trying to stop tuning. |
| upcoming games beyond today | `fetchOdds` bounds at `commenceTimeTo = now + 36h` (`:645`), which does not reach Monday → Thursday. The free `/sports/{key}/events` endpoint *would* answer this well, but it is a **new fetch per sport per run** (12 keys × 20 runs/hr) and I cannot verify its zero-credit status from this repo. Deferred to Follow-up phases with an explicit verification step. |

**Fail-safe direction, stated.** Keeping a dead sport in the denominator too long makes everyone's
ceiling slightly too tight and strands credits — a few thousand, recoverable next month, visible in
`/budget`. Releasing a live sport too early makes everyone else's ceiling inflate, which is the
September failure: nothing overspends the pool (`nominalCap` bounds the sum at `POOL × budget` by
construction, D85), but the wrong sports eat the month and the live sport goes dark. **Stranding is
cheaper. Design tight.** Every unknown above resolves to "in the denominator": unreadable feed,
un-seeded sport, `oddsSkip` sport with spend. Same direction as `7c6571d`/D65 — "when the
denominator is unknown, be wrong on the tight side".

**One ceiling-path consequence, and it is a bug fix.** `capOf` (`:794-796`) falls back to
`sportCap(sport)` — the unnormalised `budget × share` — for any sport outside the denominator. Today
that path is nearly unreachable; after this change a *released* sport lands on it, and would get a
**looser** ceiling for being out of season. Replace it with the D65 branch-2 shape,
`Math.max(bySport[s], nominalCap(s, [...denom, s]))`, and **delete `sportCap()`** — `capOf` is its
only caller, so deleting it closes the D61/D64 reintroduction surface permanently.

### Scope: denominator only. Shares are NOT rebalanced.

This phase decides **who is in the denominator**. It does not touch `BUDGET_ALLOCATION` or any
`ODDS_ALLOC_*` value. Blake's winter reshuffle (D86) stands and stays env-only.

What that fixes: a sport whose season has ended stops holding share, automatically, forever, without
anyone noticing. On today's numbers, releasing MLB's 0.14 (and WNBA's 0.02) out of a ~1.00 table
lifts every in-season ceiling by ~19% — **~2,100 credits** redistributed to the sports actually
playing, which is most of D86's measured damage.

What it does **not** fix: NFL holding 0.32 for a 2-game week in January is a *shape* problem, not a
*membership* problem — NFL is genuinely in season and genuinely belongs in the denominator. Nothing
here changes that, and nothing here changes the football floor. Those stay manual.

### D6's football priority: generalised, with the month range retained as a backstop

- **Mechanism 1 (denominator)** becomes redundant: the grace window gives *every* sport the
  protection football was given by hand. The `(footballOn && isFootball(s) && !m.oddsSkip)` term at
  `:775` is nevertheless **kept**, demoted to a labelled backstop (reason `football-backstop`) —
  during `footballPriorityOn()` months NFL/NCAAF are forced `in` even if the signal would release
  them. It costs nothing (tight direction), and if the `/sports` feed ever reports football inactive
  for 14 straight days, the backstop is the only thing between us and D6's measured failure. A test
  asserts both: that grace alone holds football in with `FOOTBALL_PRIORITY=false`, and that the
  backstop holds it in when grace has expired.
- **Mechanism 2 (the spend floor)** is **untouched**. It is a separately measured protection (D6:
  NFL had used 1064 of ~7450 while MLB and soccer drained the month) and a share-shape question, not
  a seasonality question. Note for the follow-up phase: the floor is
  `Σ(capOf(s) − spent(s))` over NFL/NCAAF, so releasing MLB *raises* football's ceilings and
  therefore *raises* the floor — the amount withheld from basketball and hockey goes **up** slightly
  as a side effect of this change. Quantify it in verification; it is bounded by the ceiling lift and
  is the price of not silently dropping a protection.

### Persistence: no DDL, no new table

State goes in a sentinel `api_usage` row — `provider: 'odds-season'`, `month: 'state'` — with the
map in the existing `by_sport jsonb`. Read once in `loadBudget()`, written in the `persistBudget()`
upsert path (one extra upsert per run, ~20/hr). `unique (provider, month)` is **already applied in
the live DB**: the odds budget upsert uses `onConflict 'provider,month'` and the budget demonstrably
persists across restarts (D24's method — a working write is evidence about schema state). So per D70
there is **nothing to hand-run**. A dedicated table was rejected for exactly the D70/D73 reason:
hand-applied DDL in this repo has a history of shipping unapplied.

**This exposes a pre-existing PWA bug that must be fixed with it.** `index.html:6029` reads
`/api_usage?select=*&order=updated_at.desc&limit=1` with **no provider filter** and renders it as
odds usage (`:5964`). That is already wrong — `src/utils/index.js:83` writes `provider: 'claude'`
rows into the same table — and a third provider makes it worse. Add `&provider=eq.odds`.

## Data model / API changes

No schema change. No new endpoint.

`getOddsCeilings()` (`odds/index.js:98`) gains three fields (additive; `/budget` already spreads it):

```js
{
  pool, denom, allocation, ceilings,          // unchanged
  sumAlloc: 0.86,                             // the live denominator sum, so a reader can check the arithmetic
  graceDays: 14,
  season: {
    NFL:   { in: true,  reason: 'active-now',          last: '2026-11-05', first: '2026-11-05' },
    MLB:   { in: false, reason: 'released (19d idle)', last: null,         first: '2026-10-17' },
    NBA:   { in: true,  reason: 'grace (3d ago)',      last: '2026-11-02', first: '2026-10-17' },
    TENNIS:{ in: true,  reason: 'billed (event-only sport)', last: null,   first: null },
  }
}
```

`reason` is a **closed set of authored strings**, never interpolated from env or from an API payload
(D80's hard constraint): `active-now` · `grace (Nd ago)` · `seeding (Nd left)` · `released (Nd idle)`
· `football-backstop` · `feed-unreadable` · `billed (event-only sport)` · `skip (ODDS_SKIP_SPORTS)`.

## File-by-file plan

1. **`edge-tracker-agents/src/config/index.js`** — add `ODDS_SEASON_GRACE_DAYS` via the existing
   non-coercing integer reader (`intEnv`, D80; `0` must mean zero, blank must mean 14), export as
   `oddsApi.seasonGraceDays`. Leave `BUDGET_ALLOCATION`, `FOOTBALL_*` and `footballPriorityOn`
   unchanged. Extend the `BUDGET_ALLOCATION` header comment to say the shares are now *shape only* —
   membership is derived.
2. **`edge-tracker-agents/src/agents/odds/index.js`** —
   - new module state `seasonState` (plain object) + `SEASON_ROW = { provider: 'odds-season', month: 'state' }`;
   - new **pure, exported** `seasonVerdicts(activeKeys, state, sports, now, graceDays, footballOn)` →
     `{ verdicts, nextState, transitions }`. Pure so it can be tested without driving `run()`;
   - `loadBudget()` reads the sentinel row into `seasonState` (one extra `db.select`, matched on the
     unique key, ≤1 row); a failed read leaves it `{}` (→ everything seeds → tight);
   - `persistBudget()` upserts the sentinel row alongside the month row;
   - `run()`: replace the `actives` filter at `:774-776` and the `billed`/`denom` lines at `:790-791`
     with the rule above; keep the football term as the backstop; log one `logger.info` per
     transition (`season: MLB released after 19d with no slate — share 0.14 returned to the pool`);
     extend the run summary with `denom N/12 (…); released MLB, WNBA`;
   - `capOf`: replace the `sportCap` fallback; **delete `sportCap()`** (`:134-137`);
   - `getOddsCeilings()`: add `season`, `sumAlloc`, `graceDays`;
   - update the file header comment block to describe the signal and the fail-safe direction.
3. **`index.html`** — (a) add `&provider=eq.odds` at `:6029`; (b) in the Budget panel's by-sport
   table (`:7046-7070`) add a `why` column from `b.season[s].reason`, replacing the current binary
   `not in denominator` tag; (c) extend the footer line at `:7069` with
   `· N released (sport: reason)` and `sumAlloc`. Keep it inside the existing `if(cl)` guard so the
   pre-deploy `off` banner still works unchanged.
4. **`edge-tracker-agents/test/odds-season-state.test.js`** (new) — the pure rules against
   `seasonVerdicts`: seeding, immediate entry, grace held, release at exactly `graceDays + 1`,
   `graceDays = 0`, `active === null` writes nothing, no flap inside a grace window, `oddsSkip`
   sports absent from the sweep, multi-league (SOCCER) `some()` semantics, reason strings from the
   closed set only.
5. **`edge-tracker-agents/test/odds-season-denominator.test.js`** (new, own file+process per the
   `odds-budget-gate.test.js` precedent — `node:test` cannot re-mock inside one file) — drives real
   `run()` with a stubbed `global.fetch`: football held in by grace with `FOOTBALL_PRIORITY=false`;
   football held in by the backstop when grace has expired; MLB released and `sumAlloc` falling;
   a released sport's `capOf` ≥ its spend and **not** `sportCap`; `Σ ceilings ≤ POOL × budget` before
   and after a release; the sentinel row written with `provider: 'odds-season'` and never clobbering
   the month row.
6. **`edge-tracker-agents/test/odds-ceilings-payload.test.js`** (extend) — one `season` entry per
   allocation sport, every `reason` in the closed set, `sumAlloc` equals the sum over `denom`,
   `graceDays` is an integer.
7. **`tools/smoke.mjs`** (extend, ~10 assertions over the strings it already reads at `:232`, `:354`
   and `html`) — `oddsSrc` exports `seasonVerdicts`; `oddsSrc` has no `function sportCap`;
   `codeOnly(oddsSrc)` contains no `fetch(` inside the season path; the football backstop term
   survives in `run()`; `provider: 'odds-season'` present; the `/sports` call is still the only
   season input; `html` has `provider=eq.odds` on the `api_usage` read; the Budget panel renders
   `season` reasons; the `Ceilings unavailable` `off` banner is still reachable; `cfgSrc` has
   `ODDS_SEASON_GRACE_DAYS` read through `intEnv`, not `num`/`||`.
8. **`DECISIONS.md`** — append D89 (the signal and why; the `billed`-strands-a-dead-sport finding;
   fail-safe tight; D6 generalised with the month range kept as a backstop and the floor untouched;
   `sportCap()` deleted) and D90 (the `api_usage` sentinel row and the unfiltered PWA read it exposed).
9. **`HANDOFF.md`** — rewrite at wrap.

Mutation-test every new assertion (D21): revert `&& !out(S)` → the release tests must fail; revert
the `capOf` fallback to `sportCap` → the released-ceiling test must fail; drop the football backstop
**and** set grace to 0 → the September-shape test must fail; make `active === null` write `last` →
the feed-unreadable test must fail.

## Risks & open questions

1. **The first release is 14 days after deploy, not 14 days after the sport died.** No per-sport
   activity date is persisted anywhere today, so seeding starts the clock on the first run with this
   code. MLB's 0.14 is therefore held until ~19 Nov. An optional `ODDS_SEASON_SEED_DAYS` could
   backdate `first` for sports inactive on the seeding run, but that fabricates evidence we do not
   have. **Default 0 (no backdate). Blake's call whether to set it once, manually, for this one
   rollover.**
2. **Two sports where 14 days is genuinely tight:** SOCCER (international breaks ~10–14 days — but
   our 7 leagues do not break simultaneously, so `some()` should hold it in) and BOXING/UFC (quiet
   fortnights are normal). Both are small shares (0.02–0.04), so a wrong release costs little; a
   per-sport grace override is deliberately *not* built — that is tuning again.
3. **A release raises the football floor** (see above). Measure it, do not assume it is negligible.
4. **`/sports` semantics are assumed, not proven.** D6 records football leaving the denominator, so
   the flag demonstrably flaps; whether it flaps daily or only at season edges is unmeasured. The
   `season` block in `/budget` is what finally measures it, and 14 days is judgement, not
   measurement (same status as `CLV_ALARM_MIN`, D72).
5. **Not specified because the data cannot support it:** anything that distinguishes "regular season
   over, playoffs in 3 days" from "season over". Both are 3 quiet days, and nothing we persist knows
   the difference. The grace window swallows both, which is the correct failure for a 3-day gap and
   is the honest limit of this design.
6. **No transition fires `reportDegraded`.** A season change is the system working; D80's reasoning
   applies — an alert channel that fires on normal behaviour is one nobody reads.

## Test plan

**Tester** — `node tools/smoke.mjs` must report **≥171 passed, 0 failed, 0 skipped** (161 today);
`npm test` from `edge-tracker-agents/` must report **0 failures** (156/156 today, no allowance — D82).
Every new assertion mutation-verified per the list above. Specifically confirm no test depends on
real network or on the wall clock without injection (`now` is a parameter of `seasonVerdicts`).

**Verifier** — the three questions that decide whether this shipped: (a) with `FOOTBALL_PRIORITY=false`
and `/sports` *not* listing NFL, is NFL still in `denom`? (b) with MLB inactive past grace, is MLB out
of `denom` **and** is `Σ ceilings` still `≤ 17000`? (c) does `/budget` name a reason for all 12 sports,
including the ones that are *in*? Also: `grep -n 'sportCap' edge-tracker-agents/src` returns nothing.

### Manual check recipe

1. `lsof -nP -iTCP -sTCP:LISTEN` — Pool Room Pro holds 4317-4318, node holds 3000 and 5173,
   ControlCenter 5000 and 7000. Proves which port is free before anything claims one.
2. `node tools/smoke.mjs` then `cd edge-tracker-agents && npm ci && npm test`. Proves the static
   assertions and the whole suite, including the simulated season boundary. **This is the decisive
   step** — see 6.
3. `cd edge-tracker-agents && node --test test/odds-season-denominator.test.js`. Proves the release
   path end-to-end through the real `run()`: the test sets grace **0 itself**, on the mocked config
   object, so every sport absent from the stubbed `/sports` response is released on its first run — a
   season boundary summoned on demand. **Do not try to do this through the environment**:
   `ODDS_SEASON_GRACE_DAYS` is floored at 7 in production on purpose (a one-character typo must not be
   able to release every quiet sport), so env `0` becomes `7` and would prove nothing.
4. `npx serve .` from the repo root (read the port it actually prints — it silently falls back to a
   random one), open the Signal tab → Budget. Before the backend deploys this must still show
   `Ceilings unavailable — this backend build does not publish them.` Proves the PWA change did not
   break the pre-deploy `off` path (HANDOFF's owed deploy).
5. After deploying `edge-tracker-agents/`: `curl -s $API/budget | jq '.season, .denom, .sumAlloc'`.
   Proves the denominator is **observable** rather than modelled — the D88 gap. Expected on day 1:
   every sport `in`, most with reason `seeding (14d left)`, `denom` effectively unchanged. A changed
   `denom` on day 1 is a defect, not a success.
6. **Honest limit:** a season boundary cannot be summoned live. Step 3 simulates one
   deterministically and is the real proof of the mechanism; the live proof arrives in two
   instalments — **~19 Nov**, when MLB and WNBA should appear as `released` and the three winter
   ceilings should rise ~19% in `/budget` without any env change; and **February**, when NFL/NCAAF
   must leave *after* the Super Bowl and not before. Until 19 Nov, "it works" is a claim about
   tests, and the handoff must say so.

## Follow-up phases

**Rebalance shares among in-season sports.** This phase fixes membership; shape is still six
hand-tuned numbers Blake reshuffles twice a year (D51, D86). The natural successor derives each
in-season sport's share from its own measured demand — games on the board × keys × cadence, all of
which the odds agent already computes per run — so NFL's 0.32 shrinks by itself for a 2-game week.
That is strictly harder than this phase and needs the `season` block from this one as its input,
which is why it is second.

**The shelved `sharp` history reader** (`docs/specs/sharp-history-reader.md`). `sharp` has reported
"no recent line movement" across 13,000+ runs and the Signal dashboard's Steam panel is now the
instrument that will show it working. Unrelated to budget, and the only remaining consumer of the
movement work D71–D79 landed.

**Does the Odds API tier need to rise?** D87 measured aggregate demand at ~2.3× the 17,000
allocatable pool, which means ceilings do not overspend — they switch sports off one at a time and
leave them off, September's symptom. Reallocation (this phase and the next) changes *which* sports
go dark and *when*; it cannot manufacture credits. Once the `season` block makes the denominator
observable, re-measure demand per in-season sport and put a real number in front of Blake, because
at 2.3× a bigger tier genuinely extends coverage rather than moving starvation around.
