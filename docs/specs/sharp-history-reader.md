# sharp: bounded history reader for steam detection

Branch `feat/sharp-history-reader-2`, off `origin/main` at `c075e70`. Refreshed 2026-11-05 against
D77–D91 (two-feed split, 35-min bound, live `gap_min`, loud skips, dashboard, seasonality). **No DDL
in this phase**, and — unlike the first draft — no DDL precondition either: `gap_min` and
`baseline_source` are live (hand-run 2026-10-28, `edge-tracker-agents/scripts/schema.sql:889-909`).

## Problem

`sharp` (`edge-tracker-agents/src/agents/sharp/index.js:15`) reads `getIntel('movements')`, the
in-memory array from only the most recent odds run of *this* process, so every row older than one
run is invisible to it — which is why it has reported `no recent line movement` across 13,000+
runs and why the Signal dashboard's Steam panel (`index.html:7137,7459`) renders **NOT FIRING**.
`line_movements` holds every row durably, now self-identifying via `gap_min` (D73), and nothing
reads it. This phase points steam detection at a bounded per-game history reader and makes `sharp`
check `gap_min` itself — the follow-up `odds/index.js:788` names in its own comment.

## Approach

### The simultaneity test (unchanged — the heart of it)

Steam is a claim about **simultaneity**. A per-row gap filter proves only that *each row's own
baseline was recent*, not that three books moved *at the same time as each other*: three books each
with `gap_min = 30` whose `detected_at` are two hours apart pass every per-row test and are not one
market move. Handing hours of rows to "≥3 co-directional rows" is D77's steam corruption scaled up.

What the data does know exactly is the interval each move must have happened in:

```
I(r) = [ detected_at(r) − gap_min(r) , detected_at(r) ]
lo = max(detected_at − gap_min) over the cluster;  hi = min(detected_at) over the cluster
steam  iff  lo <= hi  AND  distinct books >= STEAM_MIN_BOOKS (3)
```

`lo <= hi` is literally "there exists one instant at which all of these books could have moved".
Two filters, both necessary: (1) per-row via **`steamSafeMovements` imported from
`../odds/index.js:800`** — the single definition of the bound (D78: 35, a literal clamped by
`Math.min(MOVE_MAX_GAP_MIN, …)`, overridable by `ODDS_STEAM_MAX_GAP_MIN`). **This spec does not
restate the number and `history.js` contains no bare `35`**; `STEAM_MAX_GAP_MIN` itself stays
un-exported. (2) cross-row interval intersection over ≥3 distinct books. `hi − lo` is published in
`detail` as the intersection width; `strength` formula untouched. Grouping key is
`game_id|market|side|direction` — direction is in the key, not a post-hoc vote (D58's lesson).

Rejected: gap-filter-only with a wider window (the bug above); a fixed `detected_at` cluster window
(either looser than the per-row gap or rejects a genuine cluster seen across two odds runs —
intersection is the exact condition); a synthetic "move time" `detected_at − gap/2` (invents
precision the data lacks).

### Source routing (reconciled with D77)

- **Steam reads history, with `getIntel('movements')` merged in as a supplement.** History is
  primary: it survives restarts and spans odds-run boundaries. The gap-filtered in-memory feed is
  merged (deduped on a natural key) because it covers the window between detection and the insert
  landing, and it is the only source when `db.isConnected()` is false. `sharp` still **never** reads
  `movementsAll`.
- **In-memory rows need a `detected_at` stamp, and today they do not have one.** Verified:
  `movementFrom` (`odds/index.js:866-875`) returns `gap_min` and `baseline_source` but no
  `detected_at`; `insertMovements` (`:997`) sends the row as-is and Postgres applies the
  `default now()` (`schema.sql:79`). So the requirement **stays**: stamp
  `detected_at: new Date(nowMs).toISOString()` in `movementFrom` (it already receives `nowMs`).
  `detected_at` is a base-table column, so the strip path at `:998` is untouched, and the stored
  stamp becomes the same value the memory row carries — which is what makes the dedupe key honest.
- **`sharp` applies `steamSafeMovements` to the *union*** — history rows and memory rows alike —
  so it is safe against any producer, which is the named follow-up.
- **RLM stays in `public-splits`; `public-splits` is the status quo.** It already reads
  `getIntel('movementsAll')` (`public-splits/index.js:75`) and the smoke assertion pinning that
  (`tools/smoke.mjs:434-436`) is untouched. Nothing in this phase touches that agent or that feed.
- **`gap_min is null` is a reader rule, not a migration risk.** Per D73 it is the exact pre-fix
  predicate. The reader selects `gap_min`, never aggregates across null, counts those rows as
  `preFix`, and reports them. There is no missing-column strip-and-retry in the reader: the DDL is
  applied, and if the column ever vanished the select would fail loudly into the read-failure state
  below rather than silently emitting zero steam.

### Reporting: "nothing moved" must never look like "I cannot see" (aligned with D80)

`'no recent line movement'` is deleted. Seven mutually exclusive states, every counter also in
`data` (zeros included, the `baselineBit` precedent):

| state | summary | `blocked` |
|---|---|---|
| no slate | `dormant — empty slate` | no (benign, D80) |
| no DB and no memory feed | `blind — no DB and no in-memory feed` | no (`no DB` is normal locally, D80) |
| every history read failed — the memory feed still runs and publishes | `blind — history read failed for 24/24 games[, 3 consecutive runs] · memory-only: 1 steam · 3 rows / 3 gap-eligible` | **`blocked: 'history read failed'`** once ≥ `HIST_FAIL_RUNS` (3) consecutive runs |
| rows in window, every one `gap_min` null | `blind — 61 rows in the last 45m, none carry gap_min (writer is stripping it — see odds log)` | **`blocked: 'no row carries gap_min'`** |
| window genuinely empty | `0 steam · 0 movement rows in the last 45m across 12 games · history+memory` | no |
| rows, none simultaneous | `0 steam · 128 rows / 41 gap-eligible / 0 simultaneous clusters · 12 games · history+memory` | no |
| success | `3 steam · 128 rows / 41 gap-eligible / 9 markets · 12 games · history+memory · window 45m` | no |

**A failed history read does not discard the memory feed.** A DB that times out must not publish
*less* than a DB that is absent (`isConnected() === false` already publishes from memory), so the
read-failed state runs the memory-only path, publishes whatever it yields, and reports history's
blindness alongside — the summary still starts `blind —` (the agent cannot see `line_movements`),
`source` is `memory`, and the counts after `memory-only:` are the memory feed's. It is one state,
not two: pre-breaker it is blind, post-breaker it is blind *and* blocked.

**No fourth reporting channel.** `sharp` makes no `reportDegraded` call of its own. The two
"blind" states a human must act on return `blocked: '<constant literal>'` — `'history read failed'`
and `'no row carries gap_min'`, never the summary: the orchestrator treats a *changed* reason as a
new fault and resets the streak (`src/orchestrator/index.js:211-217`), so a reason that interpolated
`N consecutive runs` would read `blockedRuns: 1` forever. Counts stay in the summary. The
orchestrator (`src/orchestrator/index.js:202-245`) does the rest: `reportDegraded('sharp|blocked')`
→ `watchdog.issues[]` as `type: 'blocked'` and `/health.system.degraded`, plus
`blockedRuns`/`blockedReason`/`blockedSince` on `/health`, and unconditional clearing on the next
non-blocked run. `HIST_FAIL_RUNS = 3` is a module-local streak (D76's number for the same
table-in-distress case) because a single statement timeout is transient and `rules.blockedRunsMin`
is 1 globally; runs 1–2 still print `blind — history read failed for N/N games` in `lastResult`,
just without the alert. Partial failures are always appended (`, 2 read failures`). The summary
strings are authored literals with counts interpolated — never anything from `process.env` (D80).

## Data model / API changes

**No schema change, no DDL, no new index.** One query per game per run, riding
`line_movements_game_idx (game_id, detected_at desc)` (`schema.sql:81`); nothing filters on
`detected_at` without the `game_id` equality first, so `line_movements_detected_idx` (D70, may be
unapplied) is never needed:

```js
db.select('line_movements',
  'sport,game_id,market,book,side,line_open,line_current,moved,direction,gap_min,detected_at',
  { match: { game_id }, gte: { detected_at: since },
    order: { column: 'detected_at', ascending: false }, limit: HIST_ROW_LIMIT })
```

`baseline_source` is not selected (not needed; and naming hand-run columns in a projection is the
hazard `hydrateBaseline` documents at `odds/index.js:423-425` of smoke). `market`/`side`/`direction`
are filtered and grouped in JS so the index prefix stays an equality. `in: { game_id: [...] }` is
rejected per D71.

**Bounds — exact.** `HIST_MAX_GAMES = 24` (`SHARP_HIST_MAX_GAMES`), slate filtered to kickoff in
`[now − 3h, now + 36h]` — the forward edge is `odds`' fetch horizon (`fetchOdds` `commenceTimeTo`,
`SLATE_AHEAD_H` in `history.js` names the coupling, D95): a three-book move on a game 24–36h out is
written to `line_movements` the moment `odds` sees it, and a 24h slate would admit the game only
once those rows were older than the window (Saturday steam on Sunday 1pm NFL was never steam).
Upcoming soonest-first then started freshest-first (`book-move/index.js:370-381`'s ordering), so
near games always win the cap. `HIST_ROW_LIMIT = 400` (`SHARP_HIST_ROW_LIMIT`); a whole-market move is
11 books × 2 markets × 2 sides = 44 rows, so 400 covers ~9 events in the window; `truncated` is
counted and printed. **Worst case per run: 24 `db.select` + at most 1 `db.insert`
(`sharp_signals`) = 25 statements, ≤ 9,600 rows.** It is 24 and not 48: the first draft's one-time
missing-column retry is gone, and the 48/run figure belongs to `odds`' steady-state hydration, a
different agent. Breaker: after `HIST_FAIL_RUNS` all-failed runs, the reader probes
`HIST_PROBE_GAMES = 1` game per run until one read succeeds (D76 idiom), so a distressed table sees
1 select / 5 min from `sharp`, not 24.

**Window.** `STEAM_LOOKBACK_MIN = 45` (`SHARP_HIST_LOOKBACK_MIN`): an admissible cluster spans at
most the per-row bound (35) plus one cadence tick so the window edge never slices a cluster. Wider
buys nothing — a row that cannot join a cluster inside the bound cannot become steam later.

**Cadence — re-verified.** `config/index.js:180` has `sharp: { min: 2 }`; `odds` wakes every 3 min
on starter (`:170`) with per-key refetch at strike 4 / near 10 / mid 30 / idle 180 (`:166-169`), and
seasonality (#139, D89) changes denominator membership, not cadence. Movement rows only change when
`odds` fetches, so 2 min bought nothing and would be 720 selects/hour against a table `/data-health`
has timed out on (D68). **`sharp` moves to 5 min** (`INTERVAL_SHARP` still overrides), matching
`stale-line`/`sharp-divergence`/`key-number`: 24 × 12 = **288 selects/hour**, the same order as
`book-move` (192/hour). Consequence: `AGENT_STALE_MS.sharp` in `index.html:6055` is `300000` and the
Steam panel's `SIG_STEAM_BOUND` is 2× it, so it must become `600000` like the other 5-min agents or
the dashboard flags `sharp` stale between runs. Zero Odds API spend — no `fetch(` in either sharp
file, pinned by smoke.

**Signal shape.** `sharp_signals` rows unchanged. Provenance and width go in `detail`:
`3 books moved totals Over down (avg 0.5) within 2m · history`. `detected_at` on the signal stays
the run time (existing behaviour); the cluster's `hi` is in `detail`.

**Re-emission.** The same cluster is re-derived every run for the life of the window. A
process-local map keyed `game_id|market|side|direction` → the book sets already written suppresses
duplicate inserts; entries evict when the game leaves the slate (D75). A cluster re-emits only when
its book set *gains* a member — a strictly stronger claim. `hi` is deliberately not in the key: it
moves whenever a member book ticks again inside the stab point, and keying on it would insert a
second `sharp_signals` row naming the same books on every half-point tick of a live steam. A restart re-emits each live
cluster once (the alternative is a unique index, i.e. DDL). `setIntel('sharp', …)` is republished
every run regardless, so the dashboard and `/plays` see the live set.

## File-by-file plan

1. **`edge-tracker-agents/src/agents/sharp/history.js`** — NEW, all exported for test:
   `selectSlate(games, now)`; `readMovementHistory(slate, { now })` →
   `{ rows, queried, failures, truncated, preFix }` with per-game `try/catch` counting a failure
   instead of aborting (`hydrateBaseline`'s rule, `odds/index.js:893`) and `logger.warn` per failure;
   `normalizeRow(r)` (Postgres numerics arrive as strings, timestamps as `+00:00`; presence-check
   before `Number()`/`Date.parse()`, never `Number.isFinite` as a presence check — D79);
   `mergeMovements(hist, mem)` deduped on `game_id|book|market|side|line_open|line_current|detected_at ms`;
   `intervalOf(row)` → `{ lo, hi } | null`; `findSteamClusters(rows, { minBooks })` → interval
   stabbing per `game_id|market|side|direction` group, maximal set of distinct books whose intervals
   share a point, one row per book, returns `{ books, lo, hi, widthMin, rows }`. Imports
   `{ steamSafeMovements }` from `../odds/index.js` only.
2. **`edge-tracker-agents/src/agents/sharp/index.js`** — rewrite `run()`: slate → read (with the
   `HIST_FAIL_RUNS` streak + probe) → merge memory feed → `steamSafeMovements` → `findSteamClusters`
   → emitted-set filter → insert → `setIntel('sharp', …)` → the seven-state table, returning
   `blocked: true` on the two marked rows. Header comment rewritten to state what steam means and
   why the interval test exists. Keeps `STEAM_MIN_BOOKS = 3`, the `strength` formula, and
   `getIntel('movements')`; never `movementsAll`; no `fetch(`.
3. **`edge-tracker-agents/src/agents/odds/index.js:866-875`** — add
   `detected_at: new Date(nowMs).toISOString()` to the `move` object in `movementFrom`, with a
   one-line comment: the in-memory row must carry the same interval the Postgres row does. Nothing
   else in `odds` changes.
4. **`edge-tracker-agents/src/config/index.js:180`** — `sharp: { …, min: 5 }` with the reason
   (movement only changes when odds fetches; 24 reads/run at 2 min is 720/hour on `line_movements`).
5. **`index.html`** — three small edits: `:6055` `sharp:300000` → `sharp:600000`; `:7137`
   `notFiring:/no recent line movement/.test(res)` → `/^blind —/.test(res)` so the radar means
   "the agent says it cannot see", not "the agent used a string we deleted"; `:7452` stale copy
   `'10m (2× …)'` → `'20m (2× …)'`; `:7459` banner text quotes `res` instead of the fixed sentence
   (keep the `NOT FIRING —` prefix: smoke `:669-680` pins that copy in `sigBanner`).
6. **`tools/smoke.mjs`** — in the `:357-447` feed section, keep `sharp still reads the gap-filtered
   feed` (`:437-439`, still true; reword its rationale to "and merges it over history") and add:
   `sharp reads bounded history` (`db.select('line_movements'` + `match: { game_id` in `history.js`);
   `sharp bounds its slate` (`HIST_MAX_GAMES` + `slice(0,`); `steam requires interval intersection`
   (`findSteamClusters`, `lo <= hi`, `direction` in the key); `one definition of the simultaneity
   bound` (`history.js` imports `steamSafeMovements` and contains no `\b35\b`); `sharp counts null-gap
   rows` (`preFix`); `sharp distinguishes blind from empty` (`/blind —/` and `/0 movement rows/`);
   `sharp never reads the complete feed` (`!/movementsAll/` over both files); `sharp spends nothing`
   (`!/\bfetch\s*\(/` over both files); `a persistent read failure is blocked, not bespoke`
   (`blocked: true` present, `reportDegraded` absent from both sharp files); `the history query does
   not name baseline_source`; `the Steam radar keys on blind` (`/\^blind —\//` in `sigSteamFacts`);
   `movementFrom stamps detected_at`. `ok()`/`skip()` only; no new harness.
7. **`edge-tracker-agents/test/sharp-history.test.js`** — NEW. Model on
   `test/odds-steam-gap.test.js:67-103` (`mock.module` for config/db/utils, `fakeDb` from
   `test/helpers/fake-db.js` which records `select` calls with `cols` and `opts`, real store). For
   the `blocked` cases, drive through the real orchestrator the way `test/agent-blocked.test.js:25-70`
   does. Cases in the Test plan.
8. **`edge-tracker-agents/test/odds-steam-gap.test.js:146`** — asserts
   `s.summary === 'no recent line movement'`; re-point at `/^0 steam · /` and `s.data.clusters === 0`.
   The behaviour it pins (a 300-min drift at three books is not steam) must keep passing through
   both paths. Line 133's shape check gains nothing to change (`detected_at` is additive).
9. **`DECISIONS.md`** — append **D92** (interval intersection is the simultaneity rule; why a gap
   filter alone is insufficient), **D93** (steam reads history + the memory feed; RLM stays with
   `public-splits`, which is unchanged on `movementsAll`), **D94** (cadence 2 → 5 with the query
   arithmetic, and read-failure surfacing via `blocked` rather than a fourth channel).
10. **`HANDOFF.md`** — rewritten at `/wrap`.

## Risks & open questions

1. **`detected_at` is when we observed the move, not when the book moved.** Two books that moved
   together but were observed in odds runs 40 minutes apart will not intersect. Deliberate
   false-negative bias: a missed signal costs less than fiction flowing into `corroborate`,
   `public-fade`, `sharp-divergence` and `export`.
2. **Client-stamped `detected_at` assumes one writer process** (true today — one Railway service).
   Stated because the interval test is only as good as that stamp.
3. **`sharp` depends on the in-memory slate for its bound.** Before the first `odds` run, or with
   the budget exhausted, it reports `dormant — empty slate`. Deriving game ids from
   `line_movements` would need an unbounded query; rejected.
4. **Duplicate `sharp_signals` rows across restarts.** Process-local suppression; the clean fix is
   a unique constraint, i.e. hand-run DDL. **Blake's call** given D69/D70.
5. **Threshold choice for `blocked`.** `HIST_FAIL_RUNS = 3` (≈15 min at 5-min cadence) trades
   alert latency for immunity to one transient timeout. **Blake's call** if 1 is preferred — then
   `rules.blockedRunsMin` already does the counting and the local streak collapses to a probe gate.
6. **Idle-tier slates will honestly read `0 steam · N rows / 0 gap-eligible`.** Not a gap to patch.
7. **The `null`-gap "writer is stripping it" state is now near-unreachable** (DDL live). Kept because
   `extraCols` in `odds` still latches off on a missing-column error and the rows it then writes are
   exactly the non-authoritative ones D73 warns about.

## Test plan

**`test/sharp-history.test.js`** — assert on query *shape* as well as results (test/README.md):

- *Query shape:* one select per game; `table === 'line_movements'`; `opts.match.game_id` set;
  `opts.gte.detected_at` present; `ascending: false`; `limit` set; 40-game slate → exactly 24
  selects; `cols` does not contain `baseline_source`; `cols` does contain `gap_min`.
- *The decisive negative:* three books, `gap_min = 30` each, `detected_at` two hours apart → no
  steam, `clusters === 0`, no insert. Mutation: delete the intersection test and this must fail.
- *The decisive positive:* three books, `gap_min = 10`, `detected_at` within 3 min → one signal,
  `books.length === 3`, `widthMin` reported, one `sharp_signals` insert, `detail` ends `· history`.
- *Boundary:* `lo === hi` → steam; one second apart → not.
- *Per-row filter governs the union:* identical `detected_at`, `gap_min = 300` → no steam. Mutation:
  bypass `steamSafeMovements` → fails.
- *Two books* → none. *Two plus one opposite `direction`* → none. Mutation: drop `direction` from
  the key → fails.
- *Null/junk gaps:* `null`, `''`, `'  '`, `[]`, `false`, `true`, `-5`, `'soon'` dropped and
  `preFix` counted; an all-null window → the `none carry gap_min` summary and `blocked === true`.
  Mutation: treat null as `0` → fails.
- *Read failure:* `fail['select:line_movements']` → runs 1–2 return `blind — history read failed`
  with no `blocked`; run 3 returns `blocked: 'history read failed'`; through the orchestrator,
  `getDegraded()` contains key `sharp|blocked` with `type: 'blocked'` in the watchdog's view, and
  the next successful run clears it. Run 4 issues exactly `HIST_PROBE_GAMES` selects. One game
  failing of three → signals still emitted and `, 1 read failure` in the summary.
- *Merge and dedupe:* the same move in both history and `getIntel('movements')` counts once; a
  memory-only row forms a cluster with `isConnected() === false`, summary ends `· memory`.
- *`movementFrom` stamps `detected_at`* equal to `new Date(nowMs).toISOString()`.
- *Re-emission:* two runs over an unchanged window insert once; a member book re-ticking (same
  book set, different `hi`) does not re-insert; a fourth book re-emits once.
- *Blocked reason is constant:* ≥3 consecutive failed runs through the real orchestrator →
  `blockedRuns` climbs and `blockedSince` stays pinned.
- *Memory survives a failed history read:* all reads fail, three memory rows → one signal inserted,
  summary `blind — … · memory-only: 1 steam …`, `blocked` only past the breaker.
- *Slate horizon:* a game at +30h with three co-directional rows inside 45m → steam.
- *Probe-run summary:* the run that closes the breaker says `across 1 of 3 games (probe)`.
- *Messages:* all seven summaries asserted as distinct strings; no single regex matches both a
  "nothing moved" and a "blind" state.

**Whole suite:** `npm ci && npm test` in `edge-tracker-agents/` must be **0 failures** (D82 —
baseline 231, count rises); `node tools/smoke.mjs` from the root must be `0 failed` (baseline 202,
count rises) with every skip naming its reason.

### Manual check recipe (Blake, verifier of record)

1. `lsof -nP -iTCP -sTCP:LISTEN` — Pool Room Pro holds 4317-4318, node holds 3000 and 5173,
   ControlCenter 5000 and 7000; `npx serve .` falls back silently, so use the port it prints.
   *Proves nothing about the feature; it stops you reading another app's output as ours.*
2. `cd edge-tracker-agents && npm ci && npm test`; `node tools/smoke.mjs` from the root. *Proves the
   logic against stubs only — not that the live query returns rows or that the slate is populated.*
3. Deploy, then read `/health` → `agents[name=sharp].lastResult`. **Decisive observable A:** it is
   no longer `no recent line movement` and is one of the seven strings. On a live slate it should be
   `0 steam · N rows / k gap-eligible / 0 simultaneous clusters …` with **N > 0** — that single
   line proves the reader read real rows out of `line_movements`, and it is distinguishable from
   `blind —` by construction. *This is how the reader is proved without waiting for steam.*
   `dormant — empty slate` means odds has not populated the slate yet; wait one odds run.
4. Open the PWA → Signal → Steam. **Decisive observable B:** the radar/NOT FIRING banner is gone
   and the panel shows `Feed answered.` with the agent's own line underneath, or signals. The
   Agents tab must not mark `sharp` stale between 5-min runs (that is the `AGENT_STALE_MS` edit).
5. Optional, strongest — the positive and the negative, hand-seeded. Pick a `game_id` from
   `/health`'s slate. In the Supabase SQL editor insert three `line_movements` rows for one
   `market`/`side`, books `check-a`/`check-b`/`check-c`, same `direction`, `gap_min = 10`,
   `detected_at` inside a 3-min span ending `now()`. Next `sharp` run must say `1 steam …` and
   `sharp_signals` must show one row with those three books. Then delete them and repeat with
   `detected_at` spread over two hours: it must say `0 steam · 3 rows / 3 gap-eligible / 0
   simultaneous clusters` and write nothing. **If the positive passes and the negative does not,
   the feature is D77 scaled up and must not merge.** Clean up:
   `delete from line_movements where book like 'check-%'` and the seeded `sharp_signals` row.
   *This is the only step that proves the cluster logic against the live table.*
6. Seeing a *real* steam signal is opportunistic: it needs ≥3 books to move within the 35-min bound
   on a game the slate holds, which cannot be summoned. If one appears, check `detail` reads
   `within <N>m · history` and the width is plausible (seconds to a few minutes, not 35).
7. The `blocked` path is proved by tests only; do not try to break the live table to see it.

## Follow-up phases

- **Open→close movement for all 12 sports** — `docs/specs/line-move-all-sports.md`, independent of
  this phase (reads `opening_lines` and consensus, not `line_movements`).
- **Teach `public-splits` absent-vs-zero.** `netMove = moves.total.get(id) ?? 0` cannot tell "no
  row" from "no movement"; D77 split the feeds around it rather than fixing it. Make the absent case
  `null` and carry it through `rlm`/`freeze`.
- **Zero-recipient watchdog.** Everything this and #137 make loud terminates at `notifyAll` with no
  `ALERT_NUMBERS`/`SMTP_*`; `sharp|blocked` is readable on `/health`, not pushed, until that is set.
- (Shipped, no longer follow-ups: the Signal dashboard #138, automatic seasonality #139.)
