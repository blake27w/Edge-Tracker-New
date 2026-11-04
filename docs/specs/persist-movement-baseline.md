# Persist the line-movement baseline

Branch: `feat/persist-movement-baseline` (off `main` @ `50b4fbb`). Phase 1 of the three line-movement
phases owed in `HANDOFF.md` next-step 3.

## Problem

`lastLines` in `edge-tracker-agents/src/agents/odds/index.js` is a process-local `Map` keyed
`${game_id}|${book}|${market}|${side}`, so movement detection needs two consecutive fetches *by the
same process* — every redeploy wipes it and the next fetch of each key detects nothing (confirmed
live: the first odds run after a redeploy reported `0 movements`). The result is that `line_movements`
rows are sparse as a function of deploy timing rather than market behaviour, which is why `book-move`
had to reconstruct movement from `line_snapshots` instead (D52, labelled D17 pre-merge). The same Map
is also never pruned, so it grows for the life of the process.

## Approach

**Rehydrate lazily from `line_snapshots`; do not persist the Map.** Chosen over a dedicated
`line_baseline` table because that table's rows would be a byte-for-byte duplicate of the newest
`line_snapshots` rows: it would add ~66 upserts per game *every run* (≈4,000 rows per run on a busy
slate) to avoid a read that happens once per process lifetime, plus a second consistency surface and
hand-applied DDL on the critical write path. The read is the cheaper side of the trade, and D52 already
proved `line_snapshots` is the authoritative source for this question.

**No new Odds API spend, by construction.** The baseline comes from `line_snapshots`, which the odds
agent already writes unconditionally every run from data it has already paid for. The hydration path
contains no `fetch(` and makes no call of any kind outside `db.select`; smoke pins that by reading the
source (same technique as `book-move spends nothing`).

**Flow.** Inside `run()`, after `fetchOdds(key)` returns and *before* `normalize()` is called for those
events, hydrate the baseline for the returned games (capped, see below). `normalize()` then compares
against a Map that is already warm. Hydration only ever *fills keys that are absent* — it never
overwrites an in-process observation with an older DB row. A game is added to a `baselineDone` set the
moment it is either hydrated **successfully** or normalized, so a game that missed the cap this run is
never hydrated later (a backwards baseline arriving after a live observation would manufacture a
phantom move).

**A read that FAILS is not a game that is done.** `line_snapshots` is the table that statement-timeouts
(D68), so a cold run can plausibly fail every read it issues. Three things therefore distinguish
*attempted* from *hydrated*: a game whose read failed goes into a `baselineFailed` set and is **not**
added to `baselineDone` (nor by `normalize()`, which skips games in that set), so the next run retries
it; a run where every attempted game failed does **not** set `hydratedOnce`, so the once-per-process
cold allowance is not burnt on a run that hydrated nothing; and the failure count is reported in the
summary. Without all three, one transient timeout at boot permanently disables rehydration for a
long-lived process — which would make it behave exactly as it did pre-fix, silently and forever.

**Query shape — bounded, rides an index that exists.** One `db.select` per **game × market**, exactly
the `book-move` idiom:

```
db.select('line_snapshots', 'game_id,book,market,side,line,price,fetched_at', {
  match: { game_id, market },                       // full equality prefix
  gte:   { fetched_at: <now − MAX_GAP_MIN> },        // same bound as staleness, below
  order: { column: 'fetched_at', ascending: false },
  limit: 40,
})
```

- Rides **`line_snapshots_game_idx (game_id, market, fetched_at desc)`** — applied in production and
  already used by `book-move`. `market` must be an equality match: without it the prefix stops at
  `game_id`, `fetched_at desc` is no longer ordered by the index, and Postgres sorts every snapshot row
  that game ever accumulated (a 36h-window game refetched every 4 min is ~35k rows). `side` is filtered
  in JS for the same reason.
- `limit: 40` covers one full batch for one market (11 books × 2 outcomes = 22 rows) plus slack. Rows are
  returned newest-first; **first occurrence per key wins**, which is the "most recent row per key" rule.
- Markets queried: `spreads`, `totals` (2 per game) — **not `h2h`**, which is `book-move`'s list for
  the same reason: h2h outcomes carry no `point`, so every h2h snapshot row has a null `line`,
  `baselineFromSnapshots` skips null lines, and no h2h row can ever produce a baseline entry. Querying
  it was a third of the cold read spent on rows that are discarded by construction.
- Worst case: `ODDS_HYDRATE_COLD_MAX` (120) games × 2 markets × 40 rows = **9,600 rows / 240 queries,
  once per process lifetime**; steady state `ODDS_HYDRATE_MAX_GAMES` (24) × 2 × 40 = **1,920 rows /
  48 queries per run**, and in practice zero because `baselineDone` is already populated. Queries are
  issued in chunks of 6 concurrently so the cold-start burst costs ~1.5s, not ~12s.
- **The projection names no hand-migrated column.** `last_update` is *not* selected: nothing in the
  hydration path reads it (the baseline age is `fetched_at`, the origin stamp) and that column exists
  only via a hand-run `alter table` (`scripts/schema.sql`). PostgREST rejects the **whole** select on
  an unknown column, so asking for it would fail 100% of hydration reads on exactly the environments
  the D69/D70 history describes — and, combined with the cold-cap retry below, forever. Not selecting
  it removes the dependency rather than guarding it.
- **No new index, and nothing in `schema.sql` needs to be assumed applied** (D70). `/data-health` is
  untouched; `line_movements` must stay out of it (smoke already asserts this).

**Rejected alternatives.** (a) A `line_baseline` table — above. (b) Rehydrating the whole slate in one
`in: { game_id: [...] }` query — ordering across many `game_id`s cannot use the composite index, so it
degrades into the unbounded sort this spec exists to avoid. (c) Reading `line_movements.line_current` as
the baseline — those rows only exist where a move was already detected, so it cannot bootstrap.

### Cold-start correctness: the staleness bound

A rehydrated baseline carries an unknown gap. A line that moved during a 10-minute deploy gap is one
real move; a line compared across three days conflates an unknown number of moves into a single row
whose `moved` magnitude and `direction` are fiction.

Every baseline entry therefore carries `at` (ms): `Date.now()` for in-process observations,
`Date.parse(fetched_at)` for rehydrated ones. A movement is emitted **only if
`now − prev.at <= ODDS_MOVE_MAX_GAP_MIN` (default 360 min)**. Beyond the bound the entry is *reseeded*
with the current observation and no movement is written, and a `staleBaseline` counter increments.

- 360 min is uniform across in-process and rehydrated baselines — an in-process 12h gap is just as
  conflated, and one rule in one place is testable.
- It is above `IDLE_MIN` (180) and `IDLE × 1.5` (270) so normal in-process behaviour does not regress.
  It *does* newly suppress idle-sport pairs separated by a governor-stretched IDLE (×2.5 = 7.5h, ×4 =
  12h) that today emit a single bogus hop; that is the intended loss, and the counter makes it visible.
- `fetched_at` is the origin stamp, **not** `last_update`: `last_update` was added by a later `alter
  table` and is null on older rows, and it is the book's own stamp, not when we saw it.

**What the data cannot support:** `gap_min` discloses that a gap existed; it cannot tell you whether the
line took one hop or six inside it. Nothing recoverable says what the baseline *was* for pre-fix rows.

### Two in-memory feeds: the steam feed is bounded more tightly than the write

`sharp` reads `getIntel('movements')` and treats ≥ 3 co-directional rows in it as **steam** — a claim
about *simultaneity* ("3 books moved totals Over down"), which it then feeds to `shared/corroborate.js`,
`public-fade`, `sharp-divergence` and `export`. That was safe by construction before rehydration: a
movement row could only exist if two consecutive in-process fetches of that key straddled the move, so
its gap *was* one refetch interval. Rehydration breaks the guarantee — a baseline up to
`ODDS_MOVE_MAX_GAP_MIN` (360) minutes old means a total that drifted 44.5 → 43.5 over an afternoon at
three books arrives in one array and is published as coordinated money.

So two different bounds, for two different questions:

- **Write bound — `ODDS_MOVE_MAX_GAP_MIN` (360).** "Is this a move we can state a magnitude for?"
  Everything inside it is written to `line_movements`, full detail, `gap_min` included.
- **Steam bound — `ODDS_STEAM_MAX_GAP_MIN` (default 35).** "Could these rows have happened *together*?"
  Only rows inside it reach the steam feed. **The number comes from `sharp`'s own window**, which is
  "the most recent odds run" (`src/agents/sharp/index.js`) — one refetch interval of the keys in the
  array, and the widest ungoverned pre-game cadence is `MID_MIN`'s 30. But 30 is not the bound, because
  a real MID gap is never 30: the per-key dedup fires at `now - lastFetch >= ivMs`, so an actual
  mid-tier refetch is 30 minutes **plus** the wake grid (the odds agent wakes every 3 min on `starter`)
  **plus** the fetch itself — and `gap_min` rounds to 1dp, which left only a ~3-second grace. A MID
  refetch 3 seconds late measures `gap_min: 30.1` and was dropped, so a bound of 30 carried only strike
  (4) and near (10) in practice and excluded the one tier it was chosen to admit. **35** admits MID with
  headroom for the grid (D74). Idle-tier gaps (180, up to 720 governed) are still excluded deliberately
  — a three-hour drift is not steam no matter which process observed it, which is the same rule this
  spec already applies to in-process gaps. It is a literal, **not** live-coupled to `MID_MIN`, so
  lowering the fetch cadence cannot silently empty the feed; and it is clamped to never exceed the write
  bound, since a row we refuse to write cannot be steam.

`gap_min` rides on the **in-memory** rows exactly as it does on the Postgres ones, so the rows stay
self-identifying wherever they land, and a row whose `gap_min` is absent or unparseable is dropped from
the steam feed rather than trusted. `steamDropped` is reported in the summary when non-zero and always
in `data`.

**But the filter is not purely subtractive for every consumer, so there are two feeds.** `odds`
publishes both, once, at the end of `run()`:

| intel key | contents | consumer |
| --- | --- | --- |
| `getIntel('movements')` | gap-filtered to `STEAM_MAX_GAP_MIN` | `sharp` — and `corroborate` / `public-fade` / `sharp-divergence` / `export` downstream of its verdict |
| `getIntel('movementsAll')` | every row this run detected | `public-splits` |

`public-splits` is the second consumer of these rows and asks a different question — not "could these
have happened together" but "did the public's own number move at all" — and answers it with
`netMove = moves.total.get(game_id) ?? 0`, then `freeze = !rlm && Math.abs(netMove) < 0.5`
(`src/agents/public-splits/index.js`). A movement **withheld** by the filter is indistinguishable there
from a line that **did not move**: the `??` turns absence into zero, and zero into a published freeze.
So a genuine reverse line move off any mid- or idle-tier refetch was republished as a freeze — a
different, weaker tell about the same game. Verified end to end in
`test/odds-steam-public-splits.test.js`.

Publishing two feeds (D74) rather than widening or dropping the filter: `sharp` must not see wide-gap
rows (that is the steam corruption this branch exists to fix) and `public-splits` must not lose rows, and
those are irreconcilable in one array. `line_movements` remains the complete record and is unfiltered,
as before — `movementsAll` is its in-memory counterpart for the current run. Every row in **both** feeds
carries `gap_min`, so a consumer that later wants to judge the gap itself can, wherever the row landed.

**Follow-up, not done here:** `sharp` should also check `gap_min` itself, so it is defended against any
other producer of that array. One agent per session; `sharp` is untouched by this work.

### A persistent hydration failure must back off

"A run where every attempted game failed does not set `hydratedOnce`" is right for a transient timeout
and catastrophic for a persistent one. `db.isConnected()` is false only when Supabase is *unconfigured*,
so a query-level failure (the documented D68 statement-timeout mode) short-circuits nothing: every
attempted game fails → `games === 0` → `hydratedOnce` stays false → the next run re-spends the **full**
cold cap, 120 games × 2 markets = 240 timing-out selects in 40 chunked waves, before a single
`normalize()` runs. Every run, indefinitely. At an 8s statement timeout that is ~5 minutes of added
latency per odds run, and the orchestrator runs `odds` first and *awaits* it, so the whole agent chain
stalls while the one table already in distress is hammered 5× harder than the steady-state cap allows.

So the consecutive all-failed runs are counted. After **`HYDRATE_FAIL_RUNS = 3`** of them the cold
allowance is forfeited and hydration drops to a one-game probe (`HYDRATE_PROBE_GAMES`, i.e. 2 selects a
run) purely to notice recovery; one hydrated game resets the counter and steady-state hydration resumes
next run. The crossing is logged once at warn and shown in the summary
(`reads circuit-broken after N failed runs`), so the condition is visible rather than silent.

**Why 3.** Odds runs are 4–30 minutes apart, so three consecutive all-failed runs mean at least ~12
minutes of continuous failure — well past a transient timeout, and past the window the "don't burn the
allowance on a blip" rule exists to protect, which it still gets (a genuinely cold process keeps its
first attempt plus two retries at the full cold cap). The cold allowance is **not** refunded on
recovery: a 240-query burst into a table that has just come back is the behaviour being prevented, and
steady-state hydration converges on the slate within a few runs anyway.

### Pre-fix `line_movements` rows: left in place, and self-identifying going forward

They are not wrong observations — they are a *biased sample*, and the bias (deploy timing) is not
recoverable, so neither deleting nor backfilling them is honest. Instead, forward rows carry two new
nullable columns, `gap_min numeric` and `baseline_source text` (`in-process` | `rehydrated`). That makes
`gap_min is null` the exact predicate for "written before this fix", with no deploy-date lookup.

Verdict for readers: **treat `line_movements` rows with `gap_min is null` as non-authoritative** — usable
as evidence a move happened, never as a denominator, a rate, or a per-book percentage. A reader
straddling the fix must either filter to `gap_min is not null` or state the discontinuity; it must not
aggregate across it. Written into the schema as a comment and into `DECISIONS.md`.

**Deploy-order hazard and its guard.** If the two `alter table` lines are not run, PostgREST rejects the
whole insert and movement writes fail silently — exactly the D70 failure shape. So the insert catches a
missing-**column** error, sets a module flag `extraCols = false`, logs once at warn, and retries with the
two fields stripped. Behaviour is correct whether or not Blake has run the DDL yet. Two details that the
obvious implementation gets wrong:

- **Not `db.isMissingRelation`.** That also matches `42P01` / "relation does not exist", i.e. a missing
  *table*, and `extraCols` latches for the process lifetime — so a `line_movements` absent from the
  schema cache for a moment would make the process write `gap_min`-less rows until restarted, and the
  reader rule below classifies exactly those rows as non-authoritative. A local `isMissingColumn(e)`
  narrows it: the word *column* is what separates the two messages (Postgres spells the column case
  `column "gap_min" of relation "line_movements" does not exist`, which **contains** the table case's
  wording, so the table test cannot come first). Note `db.insert` rethrows
  `new Error('insert <table>: <msg>')` and **discards** `.code`, so the message test is the branch that
  runs in production and the one the tests must exercise.
- **The retry must retract the degradation its own probe raised.** `db.insert` calls
  `reportWriteFailure` on the way out, so the failed first attempt leaves a `write|line_movements`
  entry standing for the full 90-minute TTL while every row is in fact landing — a false alarm on the
  one channel built to surface real silent write failure (D70). The retry calls
  `clearDegraded('write|line_movements')` once it succeeds.

### `book-move` is not changed this session

It keeps reading `line_snapshots` (D52), and the smoke assertion `book-move reads snapshots, not
line_movements` stays. Two reasons beyond scope discipline: this fix makes `line_movements` *denser*, not
yet *complete* (large slates still hydrate only 120 games on run 1), and `line_movements` structurally
cannot carry what `book-move` needs — no within-batch arrival order and no `last_update`, which is what
makes lead/follow measurable below our fetch cadence. A migration would be a data-shape loss, not a
trust upgrade. Named as a follow-up only in the sense that `book-move` could one day *cross-check*
against `line_movements`; it should not switch to it.

### Memory and growth

Keys = games × books × markets × sides ≈ games × 66 (11 books × {h2h, spreads, totals} × 2 outcomes;
fewer for `hasTotals: false` sports). A peak 12-sport slate in the 36h window — a winter Saturday with
NCAAF + NFL + NBA + NCAAB + NHL + 7 soccer leagues — is realistically 150–250 games, so **≈10k–17k keys,
a few MB**. That is fine; the problem is that the Map is never pruned, so a month-lived process
accumulates ~150 new games/day → ~300k keys. Fix: at the end of each run, delete baseline entries whose
game kicked off more than 6h ago, reusing the same cutoff the slate-retention block already uses, and
drop the matching `baselineDone` entries. `openings` has the identical leak but pruning it would re-issue
`opening_lines` upserts; left alone deliberately, noted here.

## Data model / API changes

Additive only, no new table, **must be run by hand in the Supabase SQL editor** (idempotent):

```sql
alter table line_movements add column if not exists gap_min       numeric;
alter table line_movements add column if not exists baseline_source text;
```

`line_movements` row gains `gap_min` (minutes between baseline and current observation, 1dp) and
`baseline_source`. No new index; no `/data-health` change; `scripts/migrate.js` probes tables, not
columns, so it needs no edit. No HTTP endpoint or PWA change in this phase.

New env vars (all with defaults, none required):
`ODDS_MOVE_MAX_GAP_MIN=360`, `ODDS_HYDRATE_MAX_GAMES=24`, `ODDS_HYDRATE_COLD_MAX=120`,
`ODDS_STEAM_MAX_GAP_MIN=35`.

## File-by-file plan

1. **`edge-tracker-agents/src/agents/odds/index.js`** — the whole behaviour change.
   - Baseline entries become `{ line, price, at, source }`; `lastLines.set()` always writes `at`.
   - `export function baselineFromSnapshots(rows)` — pure: newest-first rows → `Map(key → entry)` with
     `source: 'rehydrated'`, `at: Date.parse(fetched_at)`, first-occurrence-per-key wins, skips rows with
     a null `line` and unparseable stamps.
   - `export function movementFrom(prev, cur, nowMs)` — pure: returns the movement row (incl. `gap_min`,
     `baseline_source`) or `null`, encoding both guards — `prev.line != null && cur.line != null &&
     prev.line !== cur.line` and `nowMs - prev.at <= MAX_GAP_MS`. `normalize()` calls this instead of
     inlining the comparison; also returns a `stale` marker so the caller can count it.
   - `async function hydrateBaseline(games, cold)` — the bounded read above: upcoming kickoffs first
     (`book-move`'s ordering), capped at `ODDS_HYDRATE_COLD_MAX` on the process's first odds run and
     `ODDS_HYDRATE_MAX_GAMES` after, chunks of 6, skips games already in `baselineDone`, no-ops when
     `!db.isConnected()`, wrapped in try/catch per game so one failure cannot abort the run. Contains no
     `fetch(`.
   - `run()`: call `await hydrateBaseline(games, firstRun)` after each `fetchOdds` and before the
     `normalize` loop; add games to `baselineDone` in `normalize`; prune after the slate-retention block.
   - The `line_movements` insert: add the missing-column retry-strip fallback.
   - Summary string gains a baseline segment, **unconditionally**:
     `· baseline <hydrated>/<attempted> games → <keys> keys rehydrated[, N read failures], S stale-baseline`.
     `data` gains `rehydratedKeys`, `rehydratedGames`, `hydrateAttempted`, `hydrateFailures`,
     `staleBaseline`. **Required** — this is how the manual check is decided, and a count reported only
     when non-zero makes a silent no-op indistinguishable from the feature working.
   - Export a test seam: `getBaseline()` and `__resetBaseline()`.
   - `run()` publishes TWO feeds: `setIntel('movements', steamSafeMovements(movements))` for `sharp` and
     `setIntel('movementsAll', movements)` for `public-splits`. See the two-feed table above.
   - Header comment: state the rehydration source, the staleness bound, the zero-spend property, and
     both intel keys with the consumer each one serves.
1b. **`edge-tracker-agents/src/agents/public-splits/index.js`** — one line plus its comment:
   `moveIndexes(getIntel('movementsAll'))` instead of `getIntel('movements')`. Nothing else about the
   agent changes; the gap-filtered feed answers a question it is not asking, and `?? 0` turns the
   filter's withheld rows into a published freeze (D74).
2. **`edge-tracker-agents/scripts/schema.sql`** — append the two `alter table` lines in a commented
   section explaining `gap_min is null` = pre-fix row, and that these must be hand-run.
3. **`edge-tracker-agents/test/odds-movement-baseline.test.js`** (new) — `node:test` + `mock.module`,
   copying the `before/after` harness from `test/odds-ceiling.test.js` and `test/helpers/fake-db.js`.
   Covers `baselineFromSnapshots` (newest-per-key, null lines, mixed timestamp spellings) and
   `movementFrom` (emit inside the bound, reseed-and-count outside it, no emit on an unchanged line, no
   emit when either line is null or `''` — `Number('')` is 0 and finite, so an empty-string line would
   emit a phantom move off a non-existent pick-em, and the function is exported), plus the query shape asserted off
   `fakeDb().calls.select` (`match` has both `game_id` and `market`, `ascending: false`, `limit` present,
   `gte.fetched_at` present) and the cap honoured, the retry-strip path driven by the **production**
   error shape (message only, no `.code`, both `…does not exist` and `…schema cache` spellings) and
   `isMissingColumn` refusing the missing-*table* messages, and the degradation channel left empty after
   the retry. A second file, `test/odds-movement-baseline-runs.test.js`, covers what one run cannot
   show: a failed hydration read is retried next run with the cold allowance intact, and a baseline past
   the bound is **reseeded** — proved by behaviour one run later, where the suppressed key emits a
   movement measured from the reseeded line rather than a second stale verdict. (Pacing is effectively
   disabled there with a tiny `ODDS_STRIKE_MIN`; it cannot be `0`, since the agent reads it as
   `Number(x) || 4`.) **Mutation-test these** per the handoff note: reintroduce the old inline
   comparison once, and separately drop the reseed on a stale verdict, and confirm the suite fails each
   time.
3b. **`edge-tracker-agents/test/odds-steam-gap.test.js`** and
   **`edge-tracker-agents/test/odds-hydrate-breaker.test.js`** (new) — the two guards above. The steam
   file asserts both directions through the real store and the real `sharp` agent: a 300-minute
   rehydrated drift at three books writes 6 `line_movements` rows and publishes **none** of them
   (`sharp` → `no recent line movement`), while the next run's millisecond-gap move at the same three
   books still produces a `steam` signal — so the first assertion is evidence about the gap, not about
   the filter being on. The breaker file runs one process through cold → cold → breaker-announced →
   probe → probe → recovery, with three distinguishable caps (4 / 2 / 1) so "which cap governed this
   run" reads straight off `hydrateAttempted`, and pins that the projection never names `last_update`.
   `test/helpers/fake-db.js` records the `cols` argument for that last assertion.
4. **`tools/smoke.mjs`** — extend section 10 with a new `── 12. Movement baseline persistence ──`
   block reading `edge-tracker-agents/src/agents/odds/index.js` and `scripts/schema.sql`. Do **not**
   use `skip()` — nothing here waits on unmerged work. Assert: hydration reads `line_snapshots`; the
   hydrate function body contains no `fetch(`; `match` carries `game_id` **and** `market`;
   `ascending: false` with a `limit`; `ODDS_HYDRATE_MAX_GAMES`/`ODDS_HYDRATE_COLD_MAX` exist; the
   staleness const defaults to 360; the steam feed is filtered by `steamSafeMovements` before
   `setIntel` and its bound is `ODDS_STEAM_MAX_GAP_MIN ?? 35` clamped to the write bound; `movementsAll` is published for `public-splits` and `sharp` still reads `movements`; the fail-run
   breaker exists (`HYDRATE_FAIL_RUNS`, `HYDRATE_PROBE_GAMES`) and is logged; the projection does not
   name `last_update`; the emit condition tests `prev.at`; `lastLines.set` writes `at:`;
   eviction calls `lastLines.delete(`; the insert has the missing-column retry and uses
   `isMissingColumn`, not `db.isMissingRelation`; the retry calls `clearDegraded`; a failed read is not
   recorded as settled and does not burn the cold allowance; `BASELINE_MARKETS` excludes `h2h`; the
   summary reports the baseline counts unconditionally; and `schema.sql` declares both new columns.

   **Two deviations from this list, deliberate.** (a) *`line_movements` still absent from
   `data-health.js`* is **not** asserted: it is no longer true, and has not been since 2026-10-17 —
   `/data-health` counts `line_movements` by `detected_at` and there is an index for it. The invariant
   that does exist is section 10's (`line_movements` must not be counted by `src/index.js`), and it is
   left standing there. (b) *the `book-move reads snapshots, not line_movements` assertion is left
   untouched* means exactly that: it stays in section 10 and is **not** copied into section 12. One
   invariant, one assertion — duplicating it is the churn the surrounding comment argues against.
5. **`DECISIONS.md`** — append D71–D75 (next free number per the handoff): rehydrate-not-persist;
   the 360-min bound and the idle-sport regression; pre-fix rows left in place with `gap_min is null` as
   the predicate; `book-move` unchanged and why; baseline eviction at kickoff + 6h.
6. **`HANDOFF.md`** — rewrite: the hand-run DDL, the two-boot verification, the remaining two
   line-movement phases.

## Risks & open questions

1. **`ODDS_MOVE_MAX_GAP_MIN = 360` is judgement, not measurement** — like `CLV_ALARM_MIN`. It suppresses
   governor-stretched idle pairs that currently emit. Blake to confirm 6h, or pick 240/720.
2. **Large slates are only partly fixed on run 1** — 120 games hydrated, the rest behave as today one
   run later. Raise `ODDS_HYDRATE_COLD_MAX` if a Saturday shows a big gap between `hydrateAttempted`
   and the slate size. **Not** `games` vs `rehydratedKeys`: those are different units (~44 keys per
   game, 11 books × 2 markets × 2 sides), so neither direction of that comparison means anything. The
   summary reports both — `baseline <games hydrated>/<games attempted> → <keys> keys rehydrated` — and
   always, zeros included, because "hydration found nothing" and "hydration never ran" have to be
   different lines.
3. **The two `alter table` lines must be hand-run.** The retry-strip fallback means nothing breaks if
   they are not, but `gap_min` stays null and the pre-fix predicate silently keeps matching new rows.
4. **360 bounded queries in one run** is a real latency spike on the first odds run (~2s with chunking).
   Acceptable once per process; if it is not, lower the cold cap.
5. `line_open` / `price_open` now sometimes mean "previous observation from an earlier process". The
   names were already wrong (they meant "previous", never "opening" — `opening_lines` is the opener);
   **not renamed**, to avoid schema churn and downstream breakage. Flagged.

## Test plan

- `cd edge-tracker-agents && npm test` — 63 pass on `main`, plus the four new files
  (`odds-movement-baseline`, `odds-movement-baseline-runs`, `odds-steam-gap`, `odds-hydrate-breaker`):
  **89 tests, 86 pass, 3 fail**. The three are the pre-existing `degradation-channel` failures
  (environmental — `node_modules` is absent in this worktree), unrelated to this work. Run the mutation
  checks: publishing `movements` unfiltered (or routing `sharp` at `movementsAll`), dropping the fail-run breaker, re-adding `last_update` to
  the projection, and never resetting the fail-run counter must each turn the suite red.
- `node tools/smoke.mjs` from the repo root — 74 passed / 0 failed on `main`; expect **101 passed / 0
  failed / 0 skipped** with the new block.
- Verifier should confirm: hydration issues **no** HTTP request (grep the function body); no query omits
  `market` from `match`; `/data-health` still returns under a second and still does not count
  `line_movements`; a movement row written with the columns absent still lands (drop the columns on a
  scratch DB, or trust the unit test that forces `isMissingRelation`).

## Manual check recipe (Blake)

**Precondition:** steps 4–6 need a live slate and credits to spend, so they are unprovable until
ingestion resumes on **1 November**. Steps 1–3 are good any time.

1. `lsof -nP -iTCP -sTCP:LISTEN` — Pool Room Pro's Electron process holds 4317–4318 and Vantyx holds
   3000. Nothing here needs `npx serve`, but if you serve anything, pass an explicit free port: `serve`
   silently falls back to a random one.
2. Run the two `alter table` lines from `scripts/schema.sql` in the Supabase SQL editor. Expect
   `Success. No rows returned` twice.
3. `cd edge-tracker-agents && npm test` (80 tests: 77 pass, 3 pre-existing `degradation-channel`
   failures from the absent `node_modules`), then `node ../tools/smoke.mjs` — 96 passed / 0 failed.
4. **Does the baseline survive a restart?** Boot the agent (`npm start`), wait for one odds run to log
   its `… snapshots …` line, then **ctrl-C and boot again** — a fresh process is indistinguishable from
   a redeploy. Read the *first* odds run's baseline segment:

   ```
   … 142 games, 6248 snapshots, 37 movements · baseline 120/120 games → 4810 keys rehydrated, 0 stale-baseline · 3 calls …
   ```

   What matters: `games hydrated` equals `games attempted` (nothing failed), `keys rehydrated` is
   non-zero, and `movements` > 0 if anything actually moved. Before this fix the first run after a
   restart could only ever report `0 movements`.
   - `baseline 0/0 games → 0 keys rehydrated` means hydration had nothing to do — not that it worked.
   - **Any `N read failures` in that line voids the check**: the DB reads are failing, every other
     count is meaningless, and that is a `line_snapshots` problem (D68), not this feature.
5. Confirm the new columns are populating and distinguish the cohorts:
   `select baseline_source, count(*), round(avg(gap_min)) from line_movements where detected_at > now() - interval '1 hour' group by 1;`
   Expect `rehydrated` rows right after the restart and `in-process` thereafter; `gap_min is null` should
   match **no** new rows.
6. **Does the staleness bound actually govern?** Not with `ODDS_MOVE_MAX_GAP_MIN=0` — that cannot
   demonstrate anything, because the bound is *also* the hydration read window: at 0, `since` is `now`,
   hydration returns no rows, every key in a fresh process is a first sighting, and the run reports
   `0 movements` **and** `0 stale-baseline`. That is the pre-fix signature, not evidence. It takes a
   small non-zero bound and two runs of one process:

   - `cd edge-tracker-agents && ODDS_MOVE_MAX_GAP_MIN=3 npm start`. Pick a bound *below* the refetch
     interval of the keys you expect to see — `ODDS_STRIKE_MIN` is 4 minutes, so 3 works with the
     defaults.
   - The **first** odds run is only the control: expect few or zero `keys rehydrated` (a 3-minute read
     window usually holds nothing) and `0 stale-baseline`. Nothing is proven yet.
   - Leave it running until a **later** odds run logs `N calls` with N ≥ 1 — i.e. a league key was
     actually refetched rather than paced-skipped. ~4 minutes for a slate inside 30 minutes of kickoff,
     up to 30 for a mid-tier one.
   - **That run is the decisive one.** Its baselines were set in-process by the previous run, so every
     gap is at least the refetch interval, which is wider than 3 minutes. Every key whose line changed
     must come back `0 movements` with a **non-zero** `stale-baseline`.
   - **What step 6 proves, exactly: that the bound governs.** Nothing more. It is *not* evidence that
     the baseline persisted across processes. The decisive run's baselines came from the previous run of
     the **same process**, and `lastLines` is module-level — it already survived from run to run within
     one process before this fix; the bug was strictly **cross-process** loss. So a non-zero
     `stale-baseline` says a baseline existed and was too old to compare, which is the bound doing its
     job and was never the thing in doubt. Rehydration is tested by **step 4, the restart check, and
     only by step 4**: hydration could be wholly broken — every read failing, `baselineFromSnapshots`
     returning nothing — and step 6 would still pass exactly as described.
   - Then restart with the default (`npm start`, no override) and watch the equivalent run: the same
     kind of pair now reports `movements` > 0 and `0 stale-baseline`.

   One flag reverses the outcome on the same code path, in the same process, minutes apart — that is
   the bound governing. If `stale-baseline` stays 0 in the 3-minute run, check `movements` in the
   default run: if that is 0 too, nothing on the slate moved and the check is **inconclusive**, not
   failed. Re-run it closer to kickoff.

## Follow-up phases

- **Point `sharp` / `public-splits` at a history reader.** Both consume an in-memory array from only the
  *most recent* odds run (`getIntel('movements')` and `getIntel('movementsAll')` respectively) — which is why `sharp` has reported "no recent
  line movement" across 13,000+ runs. With a trustworthy `line_movements` they can read a bounded window
  of history instead; that reader is the next phase and is where this fix starts paying out.
- **Generalize open→close movement to all 12 sports.** Spec already written at
  `docs/specs/line-move-all-sports.md`; no design work needed here, just scheduling.
- **Add `book_move_log` to the watchdog's schema probes.** `HANDOFF.md` next-step 6 — one line, and
  those probes exist to catch exactly the "shipped with DDL nobody ran" failure this spec also guards
  against. Fold in next time that file is touched.
