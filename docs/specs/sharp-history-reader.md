# sharp: bounded history reader for steam detection

Branch `feat/sharp-history-reader`, off `main` at `fefc1dc`. **No DDL in this phase** — but see
Risks: the two `alter table` lines HANDOFF still owes are a hard precondition for the feature doing
anything at all.

## Problem

`sharp` reads `getIntel('movements')` — the array from only the most recent odds run of *this*
process — so every movement row older than that one run is invisible to it, which is why it has
reported `no recent line movement` across 13,000+ runs. `line_movements` holds the same rows
durably and nothing reads them. The fix is a bounded per-game history reader, plus the follow-up
`odds` names in its own comments: `sharp` must check `gap_min` itself rather than trusting a
producer to pre-filter.

## Approach

### The simultaneity design (the heart of it)

Steam is a claim about **simultaneity**. A gap filter alone is not enough: `gap_min <= 35` proves
only that *each row's own baseline was recent*, not that three books moved *at the same time as each
other*. Three books each with `gap_min = 30` whose `detected_at` are two hours apart satisfy every
per-row test and are not one market move. Handing hours of rows to the existing "≥3 co-directional
rows" logic is D77's steam-corruption bug scaled up, which is the failure mode this spec exists to
avoid.

The true instant a book moved is unknowable from this data. What *is* knowable, exactly, is the
interval it must have happened in:

```
row interval  I(r) = [ detected_at(r) − gap_min(r) , detected_at(r) ]
```

Two rows can be one market move iff their intervals overlap. So the steam test is **common
intersection across ≥3 distinct books**:

```
lo = max over cluster of (detected_at − gap_min)
hi = min over cluster of detected_at
cluster is steam  iff  lo <= hi  AND  distinct books in cluster >= STEAM_MIN_BOOKS (3)
```

`lo <= hi` is the literal statement *"there exists a single instant at which all of these books
could have moved."* Note it **subsumes** a separate `detected_at` clustering window: non-empty
intersection already forces the span of `detected_at` across the cluster to be ≤ the widest
`gap_min` in it, which the per-row filter caps at 35. So there are two filters, not three, and they
are both necessary:

1. **Per-row (D78/D79):** `gap_min` present, typed, finite, `>= 0`, `<= STEAM_MAX_GAP_MIN` (35).
   Bounds how conflated any single row may be. Reuses `steamSafeMovements` — not a reimplementation.
2. **Cross-row:** non-empty interval intersection over ≥3 distinct books. Establishes that the books
   moved *together*.

`hi − lo` is reported as the intersection width: a 3-book cluster that intersects in a 20-second
window is far stronger evidence than one that intersects in 30 minutes. Width is published in
`detail`; it does **not** enter `strength` (the existing formula is untouched, so no downstream
threshold shifts).

Grouping key is `game_id|market|side|direction` — direction is part of the key, not a post-hoc
"dominant side" vote. Same lesson as D58 in `book-move`: two books arriving at one place from
opposite directions are not in the same move.

**Alternatives rejected.** (a) *Gap filter only, wider window* — exactly the bug described above.
(b) *A fixed `detected_at` cluster window (e.g. ±10 min) instead of intersection* — either looser
than the per-row gap (admits rows that cannot overlap) or tighter (rejects a genuine 4-min-cadence
cluster observed in two different odds runs); intersection is the exact condition, so use it.
(c) *Collapse to a single "move time"* `detected_at − gap_min/2` and cluster on proximity —
invents a precision the data does not have.

### Source routing: steam vs RLM

- **Steam reads history, with the in-memory feed merged in as a supplement.** History is primary:
  it survives process restarts, spans odds-run boundaries, and is therefore the thing that fixes
  13,000 runs. The in-memory `getIntel('movements')` feed is merged, not dropped, for two reasons:
  it covers the window between `odds` detecting a move and `line_movements` accepting the insert,
  and it is the only source when `db.isConnected()` is false. Both sources are deduped on a natural
  key, so a row present in both is counted once.
  To make a merge meaningful, `odds` must stamp `detected_at` on the in-memory rows (one line — see
  file plan). Without it the memory rows have no interval and cannot be tested at all, which is a
  worse answer than merging them.
- **RLM is NOT moved to history and is NOT added to `sharp`.** RLM is direction versus the public;
  `sharp` has no public data and says so in its own header — `public-splits` owns RLM and has the
  bets%/handle% to judge it. Teaching `sharp` RLM means reading `public_splits` inside it and
  duplicating the splits agent's resolver. Out of scope; recorded here as the deliberate answer to
  "do steam and RLM want different sources": **yes, and the split already exists along agent lines
  rather than along source lines.** `sharp` emits steam only, from history.
- **`public-splits` is left alone** — stays on `getIntel('movementsAll')`. Its question is "did the
  public's own number move at all", answered with `?? 0` over a game's whole drift, not a 45-minute
  window; pointing it at history would change *which* aggregate it computes and would re-enter the
  absent-vs-zero trap at a new source where "the read returned no rows" becomes a net move of zero.
  That is a named follow-up phase, not this one. The existing smoke assertion pinning it to
  `movementsAll` stays.

### Reporting: "nothing moved" must not look like "I cannot see"

That indistinguishability is what hid this bug for 13,000 runs. `'no recent line movement'` is
deleted and replaced by mutually exclusive outcomes, every one of which also lands in `data`:

| state | summary |
|---|---|
| no slate | `dormant — empty slate` |
| no DB and no memory feed | `blind — no DB and no in-memory feed` |
| every history read failed | `blind — history read failed for 24/24 games` + `reportDegraded('read\|line_movements', …)` |
| rows exist, all `gap_min` null | `blind — N rows but no gap_min: run the alter table lines in scripts/schema.sql` + `reportDegraded` |
| window genuinely empty | `0 steam · 0 movement rows in the last 45m across 12 games` |
| rows, none simultaneous | `0 steam · 128 rows / 41 inside the 35m gap / 0 simultaneous clusters` |
| success | `3 steam · 128 rows / 41 gap-eligible / 9 markets · history+memory · window 45m` |

Partial read failures are always appended (`, 2 read failures`) rather than only on the all-failed
path, and `preFix` (null-gap) rows are always counted and always printed when non-zero — zeros
included for the counters in `data`, per the `baselineBit` precedent in `odds`.

## Data model / API changes

**No schema change. No DDL. No new index.** The query rides `line_movements_game_idx (game_id,
detected_at desc)`, which has existed since before the 2026-07-03 `schema.sql` break and is
therefore applied. Per D70, `line_movements_detected_idx (detected_at desc)` is **not** assumed to
exist and this design never needs it — nothing here filters on `detected_at` without an equality on
`game_id` first. Nothing must be hand-run for the *query*; the two owed `alter table` lines are a
prerequisite for the *data* (see Risks).

The query, exactly one per game × run:

```js
db.select('line_movements',
  'sport,game_id,market,book,side,line_open,line_current,moved,direction,gap_min,detected_at',
  { match: { game_id },
    gte:   { detected_at: since },          // now − STEAM_LOOKBACK_MIN
    order: { column: 'detected_at', ascending: false },
    limit: HIST_ROW_LIMIT })
```

- `baseline_source` is **deliberately not selected** — it is hand-run DDL and naming it would make
  PostgREST reject the whole select on an un-migrated DB (the exact hazard commented in
  `hydrateBaseline` about `last_update`). `gap_min` *is* named because the feature is worthless
  without it, and is protected by the existing `isMissingColumn` strip-and-retry idiom: on that
  error, latch a module flag, retry without `gap_min`, and from then on report the
  `blind — … run the alter table lines` state rather than silently emitting zero steam.
- `match` on `game_id` plus `detected_at desc` is a full index-prefix equality + ordered range.
  `side`/`market`/direction are filtered and grouped **in JS** so the prefix stays an equality
  match — `book-move`'s and `hydrateBaseline`'s proven idiom, not a new access pattern. An
  `in: { game_id: [...] }` whole-slate query is rejected for D71's reason: ordering across many
  `game_id`s cannot use that index.

**Bounds and worst case.** `HIST_MAX_GAMES = 24` (`SHARP_HIST_MAX_GAMES`), slate filtered to
kickoff in `[now − 3h, now + 24h]`, upcoming first then started freshest-first — `book-move`'s
ordering, same reason. `HIST_ROW_LIMIT = 400` (`SHARP_HIST_ROW_LIMIT`): a total "everything moved"
event is 11 books × 2 markets × 2 sides = 44 rows, so 400 covers ~9 such events in 45 minutes.
Worst case **24 queries and ≤9,600 rows per run**; typical is a few hundred rows. `truncated` is
counted and reported when any game hits the limit, so a clipped window is visible rather than
assumed (`book-move`'s `truncated_queries` precedent).

**Window.** `STEAM_LOOKBACK_MIN = 45` (`SHARP_HIST_LOOKBACK_MIN`). Derived, not arbitrary: an
admissible cluster spans at most 35 minutes, plus one cadence tick so a cluster is not sliced by the
window edge. Wider buys nothing — a row that cannot join a cluster inside 35 minutes cannot become
steam later — and wider is precisely the D77 hazard.

**Cost and cadence.** `sharp`'s interval moves **2 → 5 minutes** in `AGENT_DEFS`
(`INTERVAL_SHARP` still overrides), matching `sharp-divergence`, `key-number` and `stale-line`. At
24 queries / 5 min that is 288 queries/hour against `line_movements`, the same order as `book-move`
(192/hour) and `odds`' steady-state hydration (48/run). At the old 2-minute cadence it would be
720/hour against a table `/data-health` has a documented history of timing out on; 2 minutes bought
nothing anyway, since movement only changes when `odds` runs (4–30 min). Zero Odds API spend — no
`fetch(` in either file, pinned by smoke.

**Signal shape.** `sharp_signals` rows unchanged (no provenance column, no DDL): provenance and
intersection width go in `detail`, e.g.
`3 books moved totals Over down (avg 0.5) within 2m · history`. `strength` formula unchanged.

**Re-emission.** `sharp` now re-derives the same cluster on every run for the life of the window.
A process-local `Set` of emitted cluster keys
(`game_id|market|side|direction|<sorted books>|<cluster hi ms>`) suppresses duplicate inserts;
entries are evicted when the game leaves the slate (D75's eviction idiom). A cluster that *gains* a
book changes its key and is re-emitted — intended, it is a strictly stronger claim. A restart
re-emits each live cluster once; accepted, because the alternative is a unique index, i.e. DDL.

## File-by-file plan

1. **`edge-tracker-agents/src/agents/sharp/history.js`** — NEW. The reader plus the pure logic, all
   exported for test:
   - `readMovementHistory(games, { now })` → `{ rows, queried, failures, truncated, preFix }`.
     Bounded slate selection, the per-game query above, `isMissingColumn` strip-and-retry latch,
     per-game `try/catch` that counts a failure instead of aborting the run (`hydrateBaseline`'s
     rule), `logger.warn` per failure.
   - `normalizeRow(r)` — Postgres hands numerics back as strings and timestamps in `+00:00`;
     `Number()`/`Date.parse()` with explicit presence checks before coercion, never
     `Number.isFinite` as a presence check (house rule, D79).
   - `mergeMovements(histRows, memRows)` — union deduped on
     `game_id|book|market|side|line_open|line_current|detected_at(ms)`.
   - `intervalOf(row)` → `{ lo, hi }` or `null`.
   - `findSteamClusters(rows, { minBooks })` → clusters with `{ books, lo, hi, widthMin, rows }`.
     Interval stabbing: group by `game_id|market|side|direction`, sort by `hi`, sweep candidate
     points, keep the maximal set of **distinct books** whose intervals all contain one point; one
     row per book (widest-fitting) so a book that hopped twice counts once.
   - Imports `{ steamSafeMovements, STEAM_MAX_GAP_MIN }` from `../odds/index.js` — the bound must
     have exactly one definition (D55's principle; two copies is how 30-vs-35 drift happens). No
     `35` literal anywhere in this file.
2. **`edge-tracker-agents/src/agents/sharp/index.js`** — rewrite `run()` around the above: slate →
   read → merge → `steamSafeMovements` → `findSteamClusters` → emitted-set filter → insert →
   `setIntel('sharp', …)` → the reporting table. Header comment rewritten to state what steam
   means here and why the interval test exists. Keeps `STEAM_MIN_BOOKS = 3` and the `strength`
   formula. Still reads `getIntel('movements')` (the gap-filtered feed) and **never**
   `movementsAll`.
3. **`edge-tracker-agents/src/agents/odds/index.js`** — two small changes: `export` on
   `const STEAM_MAX_GAP_MIN`, and `detected_at: new Date().toISOString()` on each row returned by
   `movementFrom` (the base-table column, *not* hand-run DDL, so `insertMovements`' strip path is
   untouched). Comment why: the in-memory feed must carry the same interval the Postgres rows do.
4. **`edge-tracker-agents/src/config/index.js`** — `sharp` `min: 2` → `min: 5`, with the reason in a
   comment.
5. **`tools/smoke.mjs`** — in the movement-feed section (~line 349–445). **Replace** the now-false
   `sharp still reads the gap-filtered feed` assertion (it currently requires `movementsAll` to be
   absent from `sharp/index.js`, which stays true, but its stated rationale is superseded) with:
   `sharp reads bounded history` (`db.select('line_movements'` + `match: { game_id` in
   `history.js`); `sharp bounds its slate` (`HIST_MAX_GAMES`/`slice(0,`); `steam requires interval
   intersection` (`findSteamClusters` present and `lo <= hi` logic, plus `direction` in the grouping
   key); `one definition of the simultaneity bound` (`history.js` imports `STEAM_MAX_GAP_MIN` and
   contains no bare `35`); `sharp drops null-gap rows and counts them` (`preFix`);
   `sharp distinguishes blind from empty` (`/blind —/` and `/0 movement rows/` both present);
   `sharp never reads the complete feed` (`!/movementsAll/` across both sharp files);
   `sharp spends nothing` (`!/\bfetch\s*\(/` across both sharp files);
   `the history query does not name baseline_source`. Use the existing `ok()`/`skip()` helpers; no
   new harness.
6. **`edge-tracker-agents/test/sharp-history.test.js`** — NEW, `node:test` + `mock.module` +
   `helpers/fake-db.js`, same shape as `test/odds-steam-gap.test.js`. Cases in the Test plan.
7. **`edge-tracker-agents/test/odds-steam-gap.test.js`** — **must be amended**: line 146 asserts
   `s.summary === 'no recent line movement'`, a string this change deletes. Re-point it at the new
   zero-steam summary and at `res.data.clusters === 0`; the *behaviour* it pins (a 300-minute drift
   at three books is not steam) is unchanged and must keep passing, now through the history path as
   well as the memory path.
8. **`DECISIONS.md`** — append D80 (interval intersection as the simultaneity rule, and why a gap
   filter alone is insufficient), D81 (steam reads history, RLM stays with `public-splits`,
   `public-splits` untouched), D82 (cadence 2 → 5 and the query arithmetic).
9. **`HANDOFF.md`** — rewritten at `/wrap`.

## Risks & open questions

1. **BLOCKING, for Blake: the two `alter table` lines in HANDOFF are still un-run.** Until they are,
   every `line_movements` row lands without `gap_min`, the per-row filter correctly drops all of
   them, and this feature emits **zero steam** — reported as `blind — N rows but no gap_min`, which
   is the honest answer but is not the feature working. Running them is step 2 of the manual check
   and the precondition for steps 4–6.
2. **`detected_at` is when *we observed* the move, not when the book moved.** The interval
   formulation is the tightest honest bound available; the data cannot support anything finer. Two
   books that genuinely moved together but were observed in odds runs 40 minutes apart will not
   intersect and will not be called steam. **That is a deliberate false-negative bias** — under-
   calling steam costs a missed signal, over-calling it writes fiction into `sharp_signals` and on
   into `corroborate`, `public-fade`, `sharp-divergence` and `export`.
3. **Client-stamped `detected_at` assumes one writer process.** Stamping in `odds` rather than
   taking the DB `now()` default introduces process-clock skew if Edge Tracker is ever run as more
   than one instance. True today (single Railway service); worth stating because the interval test
   is only as good as that stamp.
4. **`sharp` now depends on the in-memory slate for its query bound.** A process with no slate
   (budget exhausted, or before the first `odds` run) reports `dormant — empty slate` and sees
   nothing. Correct and loud, but it means history does not make `sharp` fully independent of
   `odds`. Deriving game ids from `line_movements` itself would need an unbounded query and is
   rejected.
5. **Duplicate `sharp_signals` rows across restarts.** Suppression is process-local; the clean fix
   is a unique constraint on `(game_id, market, side, signal_type, detected_at)`, i.e. DDL. Blake's
   call whether that is worth another hand-run statement given this repo's record (D69/D70).
6. **The window is tuned for STRIKE/NEAR cadence.** On MID/IDLE sports most rows carry
   `gap_min > 35` and will never be steam-eligible. That is the correct reading of the data, not a
   gap to patch, but expect the honest answer on idle slates to be `0 steam · N rows / 0 inside the
   35m gap`.

## Test plan

**`test/sharp-history.test.js`** (stubbed `db` via `helpers/fake-db.js`, assert on query *shape* as
well as results, per D22):

- *Query shape:* one select per game, `table === 'line_movements'`, `opts.match.game_id` set,
  `opts.gte.detected_at` present (a missing lower bound is the D11 bug shape), `ascending: false`,
  `limit` set, slate capped at `HIST_MAX_GAMES` with a 40-game slate, and `cols` must **not**
  contain `baseline_source`.
- *The decisive negative:* three books, each `gap_min = 30`, `detected_at` two hours apart →
  **no steam**, `clusters === 0`. Mutation check: delete the intersection test and this case must
  fail. This is the test that stops D77 scaled up.
- *The decisive positive:* three books, `gap_min = 10`, `detected_at` within 3 minutes → one steam
  signal, `books.length === 3`, `widthMin` reported, inserted into `sharp_signals` once.
- *Boundary:* intervals touching at exactly one instant (`lo === hi`) → steam; one second apart →
  not.
- *Per-row filter still governs:* three books, `detected_at` identical, `gap_min = 300` → no steam
  (intersection alone must not rescue a conflated row).
- *Two books only* → no steam. *Two books plus one at the opposite `direction`* → no steam
  (direction is in the grouping key).
- *Null/junk gaps:* `gap_min` null, `''`, `'  '`, `[]`, `false`, `true`, `-5`, `'soon'` → dropped,
  `preFix` counted, and an all-null window produces the `blind — … no gap_min` summary plus a
  `read|line_movements` degradation entry.
- *Read failure:* `fail['select:line_movements']` → `blind — history read failed for N/N`, degraded
  entry, and the run does **not** throw; one game failing out of three → signals still emitted and
  `2 read failures` in the summary.
- *Missing column:* a `column "gap_min" … does not exist` error → one retry without `gap_min`, the
  latch set, the un-run-DDL summary, and no crash.
- *Merge and dedupe:* the same movement present in both history and `getIntel('movements')` counts
  once; a memory-only row still forms a cluster when the DB is unreachable
  (`isConnected() === false` → `source: 'memory'`).
- *Re-emission:* two consecutive runs over an unchanged window insert `sharp_signals` **once**; a
  fourth book joining re-emits.
- *Messages:* each of the seven summary states is asserted as a distinct string — "nothing moved"
  and "I cannot see movement" must not match the same regex.

**Mutation-test before trusting any of it** (D21): (a) remove the interval intersection → the
two-hours-apart case must fail; (b) replace `steamSafeMovements` with a pass-through → the
`gap_min = 300` case must fail; (c) drop `direction` from the grouping key → the opposite-direction
case must fail; (d) treat a null gap as `0` → the null-gap case must fail; (e) remove the
`gte: { detected_at }` bound → the query-shape case must fail.

**Whole-suite expectation:** `npm test` from `edge-tracker-agents/` must stay at 3 failures and
those must remain the pre-existing environmental `degradation-channel` trio (`node_modules` absent
in this worktree); total count rises from 111. `node tools/smoke.mjs` must be
`0 failed`, and every skip must print with a named reason.

## Manual check recipe (Blake, verifier of record)

1. `lsof -nP -iTCP -sTCP:LISTEN` — a Pool Room Pro Electron process holds 4317-4318 and Vantyx
   holds 3000; `npx serve` silently falls back to a random port, so note the port it prints.
   *Proves nothing about this feature; it stops you reading another app's output as ours.*
2. In the Supabase SQL editor run the two owed lines (idempotent):
   `alter table line_movements add column if not exists gap_min numeric;`
   `alter table line_movements add column if not exists baseline_source text;`
   Then `select count(*) from line_movements where gap_min is not null;` — **this must be non-zero
   before step 4 can mean anything.** *Proves the DDL is applied and forward rows are
   self-identifying; proves nothing about `sharp`.*
3. `cd edge-tracker-agents && npm test`, and `node tools/smoke.mjs` from the repo root. *Proves the
   logic is pinned against stubs. It does not prove the live query uses the index, returns rows, or
   that the slate is populated.*
4. **DECISIVE — the positive.** Pick a `game_id` on the live slate from `/health` or
   `/data-health`. Insert three rows into `line_movements` by hand for one `market`/`side`, three
   different `book` values, the same `direction`, `gap_min = 10`, and `detected_at` values inside a
   3-minute span ending `now()`. Wait for the next `sharp` run and read its summary. It must report
   `1 steam` with `within <N>m · history`, and `select * from sharp_signals order by detected_at
   desc limit 5` must show the row with three books. **This is the only step that proves `sharp` can
   see history at all** — nothing before it does.
5. **DECISIVE — the negative, and the more important of the two.** Repeat step 4 with the same three
   rows but `detected_at` spread over two hours (`gap_min` still 10). `sharp` must report
   `0 steam · 3 rows / 3 inside the 35m gap / 0 simultaneous clusters` and must write **nothing** to
   `sharp_signals`. If step 4 passes and this one does not, the feature is D77 scaled up and must
   not merge.
6. Watch three consecutive `sharp` summaries on the live slate with no hand-seeded rows. You are
   checking that the *state* it reports is the true one: `0 movement rows in the last 45m` on a
   quiet slate, a non-zero `rows` count on a live one, and never `blind —` once step 2 is done.
   *Proves the reporting distinguishes empty from blind. It does not prove the cluster logic — only
   steps 4 and 5 do — and a quiet slate will look identical whether clustering works or not.*

## Follow-up phases

- **Open→close movement for all 12 sports.** Spec already written at
  `docs/specs/line-move-all-sports.md`, with the store-shape and rename decisions made. Independent
  of this phase: it reads `opening_lines` and consensus, not `line_movements`.
- **Teach `public-splits` absent-vs-zero.** `netMove = moves.total.get(id) ?? 0` cannot tell "no
  row" from "no movement", which is why D77 had to split the feeds rather than fix the consumer.
  Make the absent case `null` and carry it through `rlm`/`freeze` so any future consumer — including
  a history-backed one — inherits a safe default instead of a silent zero.
- **Add `book_move_log` to the watchdog's schema probes.** One line, and those probes exist to catch
  exactly the failure this repo keeps having: an agent shipping with DDL nobody ran (D69).
