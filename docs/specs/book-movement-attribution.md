# Book Movement Attribution

Spec date: 2026-10-14 · Branch: `feat/line-move-all-sports` · Agent: `book-move`

## Problem

We already capture every book's line on every market every run (`line_snapshots`), and movement
detection is already per-book (`odds/index.js:236`), but nothing ever reads it back: **which** book
moved, **which way**, **how far**, whether it **led or followed** the field, and whether it moved
*against* the public are all invisible. Blake wants to know when a given book's move matters —
some books get hit by sharps, some by tickets — and which moves are signal rather than noise.
**Hard constraint: zero new Odds API spend.** Honored structurally: the agent's only inputs are
`getGames()` (the in-memory slate), `getIntel('splits')`, and bounded Supabase reads. The file must
contain **no `fetch(`** and must not import from `agents/odds/index.js` (a smoke assertion pins this).

## Approach

New read-only agent `book-move` (15 min). For each game kicking off soon, rebuild the per-book
line timeline from `line_snapshots`, emit one **episode** per book-level line change, score each
episode for importance, persist episodes to a new `book_move_log`, and publish `{live, byBook}`
where `byBook` is a **derived** lead/follow scorecard (who moves first = market-maker-ish, who
moves last = follower). Surfaced on the Agents tab next to the existing line-move section.

### Decision 1 — Data source: `line_snapshots` only (derive movement), not `line_movements`

- `line_movements` is pre-computed and per-book, but **sparse and biased**: `lastLines`
  (`odds/index.js:162`) is a process-local Map, so each redeploy wipes the baseline and the first
  fetch of every key detects nothing. A lead/follow percentage computed over rows whose existence
  depends on deploy timing is worse than useless — it looks authoritative and is not. Rejected as
  the computation input.
- `line_snapshots` is written **unconditionally every run** (`odds/index.js:243`), carries `book`,
  and — critically — carries **`last_update`**, the Odds API's own "when this book last changed its
  number" stamp (`odds/index.js:222`, column added at `schema.sql:794`). That is what makes
  lead/follow measurable *below* our fetch cadence: two books whose change lands in the same
  snapshot batch are still orderable by `last_update`. This is the whole reason snapshots win.
- **Bounding** (query cost is live — `/data-health` already takes ~36s): never query by `sport` or
  by time alone. One query **per game per market**, keyed on `game_id` so it rides the existing
  `line_snapshots_game_idx (game_id, market, fetched_at desc)`:

```js
const snaps = await db.select('line_snapshots',
  'book,market,side,line,price,fetched_at,last_update,commence_time',
  { match: { game_id: g.game_id, market },            // market = 'spreads' | 'totals'
    gte: { fetched_at: since },                        // since = now − WINDOW_H (default 48h)
    order: { column: 'fetched_at', ascending: false }, // DESC + limit, then reverse in JS —
    limit: 1500 });                                    // ASC+limit would truncate the newest rows
```

  Slate is capped: `getGames()` filtered to `commence_time` in `[now − 3h, now + 24h]`, sorted by
  kickoff, `.slice(0, MAX_GAMES=24)` → **≤ 48 snapshot queries + ≤ 2 others per run**, comparable to
  `book-edges` (2 queries, 40k rows) and `clv-tracker` (one per play).
- **No new index on `line_snapshots`.** We filter `side` in JS rather than in the query precisely so
  the existing index prefix (`game_id, market`) is a full equality match; adding
  `(game_id, book, …)` would buy nothing for this query shape and costs write throughput on the
  largest table. New indexes are added only on the new (small) table.
- MLB/NHL `spreads` are excluded (fixed ±1.5 run/puck line — movement is in *price*, not line; the
  same artifact `book-edges` guards at `book-edges/index.js:23`). Those sports contribute totals
  only. `h2h`/price-only movement is deferred — see Risks.

### Decision 2 — The sharp/public classifier: market-wide only. Per-book public data does not exist.

Verified against the only public source we have, `agents/public-splits/index.js`:
- It asks Claude to return `game_id, sport, market, side, bets_pct, handle_pct` (:59-65) and writes
  `public_splits` — which has **no `book` column** (`schema.sql:145-159`).
- Granularity that genuinely exists: **per game × market × side, market-wide**, tickets (`bets_pct`)
  *and* money (`handle_pct`), for **four sports only** (`SPLIT_SPORTS` = NHL/NBA/MLB/NFL, :15), and
  only when `hasClaude()` and the web search returned (:54).

So **a true per-book public split is not derivable from our data, and this spec does not pretend
to one.** What we *can* say, and what the payload will literally be labelled: *"which books moved
against the market-wide public consensus, how early, and how far."* Per episode:
- `public_pct` = `bets_pct` of the heavy side (≥ 60) from the newest split row for that
  game+market, read from `getIntel('splits')` (zero cost, house idiom — `sharp/index.js:15`,
  `public-fade`); if the store is empty (fresh process) **one** fallback query:
  `db.select('public_splits','game_id,market,side,bets_pct,handle_pct,fetched_at',{gte:{fetched_at: now−12h}, order:{column:'fetched_at',ascending:false}, limit:2000})`, newest row per `game_id|market` wins.
- `vs_public` = true when the public side's **own number got better** as a result of this book's
  move (spread side's line rose; total moved the public side's way) — i.e. the book is not taking
  the crowd's action at a worse price, so money is on the other side. Reuse the direction rules
  already proven in `public-splits/index.js:92-103`; do **not** re-derive them.
- `handle_pct − bets_pct` (`divergence`) is carried through as context, never as a per-book claim.
- Coverage honesty: outside NHL/NBA/MLB/NFL (and whenever Claude found nothing) `public_pct` is
  `null`, `vs_public` is `null`, and the score simply loses that component (capping it ~80). The UI
  must say "no public data" rather than implying consensus.

**What this can conclude:** that a book moved first/last, far/little, early/late, and with or
against market-wide public tickets — aggregated, who behaves like a price-maker.
**What it cannot conclude:** that a specific book is "getting hit by sharps". Our `BOOKS` list
(`config/index.js:109`) is 11 licensed **US retail** books — no Pinnacle, no Circa, no exchange.
None of them originates price; the leader metric therefore measures *who copies the true market
fastest*, which is a real and useful speed signal but is **not** proof of sharp action at that book.
This limitation goes in the agent header comment and in the PWA's explainer text verbatim.

### Decision 3 — Importance scoring (and derived, not hardcoded, book reputation)

Per snapshot batch compute the **consensus** line = median across books (same median idiom as
`src/index.js:126-131`). An *event* = a change in consensus level. For each book line change emit:
`line_from, line_to, moved, direction, moved_at = last_update || fetched_at` (never null — the
dedup key depends on it), `lead_rank` = this book's 1-based position among books reaching the new
level ordered by `moved_at`, `led` = book reached the level **before** consensus did.

```
score = 100 × (0.30·mag + 0.20·key + 0.15·early + 0.20·vsPublic + 0.15·lead)
mag      = min(1, |moved| / 1.5)                      // 1.5pt move = full credit
key      = crossed_key ? LAND_PCT[k]/15.1 : 0         // football only; 0 elsewhere
early    = min(1, hours_to_start / 24)                // null → 0.3
vsPublic = vs_public === true ? 1 : vs_public === false ? 0 : 0  // null (no data) → 0
lead     = byBook[book].led_pct/100, default 0.5 when that book has n < 20 episodes
```
Emit episodes with `score ≥ MIN_SCORE` (env `BOOK_MOVE_MIN_SCORE`, default 35); publish top 40 by
score, plus `reasons: []` — short strings (`'crossed 3'`, `'led field by 2 books'`, `'vs 74% public'`)
so the UI never has to re-derive the why.

- **Key numbers are reused, not reinvented.** Extract `KEYS` / `LAND_PCT` and a
  `crossed(from, to)` helper from `key-number/index.js:18-25` into a new
  `agents/shared/key-numbers.js`; `key-number/index.js` imports them (no behaviour change — same
  constants, same order).
- **Book reputation is derived, not hardcoded.** `byBook` is computed from the trailing 14 days of
  `book_move_log` (one query, `limit: 20000`, `book-edges/index.js:48` idiom):
  `n, led_pct, follow_pct, avg_moved, key_cross_n, vs_public_n, vs_public_pct`, and
  `role` = `led_pct ≥ 45 && n ≥ 20 → 'market-maker'`, `led_pct ≤ 20 → 'follower'`, else `'mixed'`,
  with `small: n < 20` (same honesty flag as `book-edges`' `fin().small`). Hardcoding a prior was
  rejected: our book list is all retail (no book deserves a maker prior), the list changes, and a
  hardcoded table would silently go stale while a derived one self-corrects and is auditable.
  Bootstrap cost accepted: `role` is noise for the first ~2 weeks, which `small` discloses.

### Decision 4 — Where it surfaces

New agent + store slot + top-level `/plays` key + one Agents-tab section. **Backward-compat
discipline** (same seam the prior spec worked out): `/plays` gains a top-level `bookMoves`; the PWA
reads `bag.bePlays.bookMoves||null` and every field access is defaulted/optional
(`(bm.live||[])`, `(bm.byBook||[])`, `m.public_pct!=null?…:'no public data'`) because
`hydrateAgentsCache` (`index.html:5917`) replays the previous payload from `localStorage.etBagCache`
(`index.html:5958`) on first paint — a new `index.html` *will* paint an old bag. No `CACHE` bump
(`sw.js` is network-first for the shell). `/data-health` gains **`['book_move_log','detected_at']`**
only; `line_movements` is deliberately **not** added — a full `count(*)` there is exactly the kind of
unbounded count that already times out on that page, and phase (b) owns that table.

## Data model / API changes

`scripts/schema.sql` — additive, apply-anytime, placed after `line_movements_game_idx` (:81):

```sql
-- Per-book line-move episodes with importance score (book-move agent; read-only over snapshots).
create table if not exists book_move_log (
  id             uuid primary key default gen_random_uuid(),
  sport          text not null,
  game_id        text not null,
  commence_time  timestamptz,
  matchup        text,
  market         text not null,                      -- spreads | totals
  side           text,
  book           text not null,
  line_from      numeric,
  line_to        numeric,
  moved          numeric,
  price_from     integer,
  price_to       integer,
  direction      text,                               -- up | down
  moved_at       timestamptz not null,               -- book's own last_update, else batch fetched_at
  lead_rank      integer,                            -- 1 = first book to this level
  led            boolean default false,              -- moved before consensus did
  hours_to_start numeric,
  crossed_key    numeric,                            -- football key number crossed, else null
  public_pct     numeric,                            -- MARKET-WIDE bets_pct on heavy side (nullable)
  vs_public      boolean,                            -- move went against the public side (nullable)
  score          numeric,
  reasons        jsonb,
  detected_at    timestamptz not null default now(),
  unique (game_id, market, side, book, line_to, moved_at)
);
create index if not exists book_move_log_book_idx on book_move_log (book, detected_at desc);
create index if not exists book_move_log_game_idx on book_move_log (game_id, detected_at desc);
```

Writes use `db.upsert('book_move_log', rows, 'game_id,market,side,book,line_to,moved_at',
{ ignoreDuplicates: true })` — the agent re-scans a 48h window every 15 min and must not duplicate
episodes. `moved_at` is non-null by construction because Postgres treats nulls as distinct.

API: `/plays` gains top-level `bookMoves: getBookMoves()`. No new endpoint (per-episode drill-down
is deferred; `/opportunity` already shows per-book lines for a game).

## File-by-file plan

1. **`edge-tracker-agents/src/agents/shared/key-numbers.js`** (new) — export `KEYS`, `LAND_PCT`
   (verbatim from `key-number/index.js:18-25`, comments included) and
   `export function crossedKey(from, to)` → the key number strictly between the two values (highest
   `LAND_PCT` first), else `null`. Works on absolute spread points and on totals.
2. **`edge-tracker-agents/src/agents/key-number/index.js`** — delete the local `KEYS`/`LAND_PCT`
   (:18-25), import them from `../shared/key-numbers.js`. Nothing else changes.
3. **`edge-tracker-agents/src/agents/book-move/index.js`** (new, the bulk) — header comment stating
   the $0 constraint, the retail-books limitation, and that `public_pct` is market-wide; then
   `run()`: slate filter + cap → per game per market snapshot query (shape above, DESC+reverse) →
   group batches by `fetched_at` → consensus median per batch → per-book change detection with
   `moved_at = last_update || fetched_at` → `lead_rank`/`led` → public lookup from
   `getIntel('splits')` (single DB fallback) → `crossedKey()` → score → filter `≥ MIN_SCORE` →
   `upsert` → trailing-14d `byBook` aggregate → `setBookMoves({updated, window_h, max_games,
   live, byBook, note})` → summary `` `${live.length} scored moves · ${byBook.length} books · N
   market-makers · M vs-public` ``. Early return `{ summary: 'dormant — empty slate' }` when the
   capped slate is empty, and `{ summary: 'skipped — no DB' }` when `!db.isConnected()`
   (`book-edges/index.js:45`). **No `fetch(`.**
4. **`edge-tracker-agents/src/store/index.js`** — add `bookMoves: null` to the store object (after
   `bookEdges`, :46) and `setBookMoves`/`getBookMoves` accessors (after :110).
5. **`edge-tracker-agents/src/config/index.js`** — add to `AGENT_DEFS` after `'book-edges'` (:169):
   `'book-move': { label: 'Book Movement Attribution', emoji: '🧲', min: 15 }`.
6. **`edge-tracker-agents/src/orchestrator/index.js`** — import `bookMove from
   '../agents/book-move/index.js'` next to `bookEdges` (:39) and add `bookMove` to the `AGENTS`
   array (:74).
7. **`edge-tracker-agents/src/index.js`** — import `getBookMoves` (store import block, :12); add
   `bookMoves: getBookMoves()` to the `/plays` payload (:432, top level, next to `bookEdges`); add
   `['book_move_log', 'detected_at']` to `buildDataHealth` specs (:323-328).
8. **`edge-tracker-agents/scripts/schema.sql`** — the DDL block above after :81.
9. **`edge-tracker-agents/scripts/migrate.js`** :15 — add `'book_move_log'` to the table list.
10. **`index.html`** — four edits, all defaulted for an old cached bag:
    - :5802 area — `AGENTS_META` entry `{name:'book-move',icon:'🧲',label:'Book Movement Attribution',cadence:'every 15 min'}`.
    - :5827 — `AGENT_STALE_MS` gains `'book-move':1800000`.
    - :5900 — in the existing `if(bag.bePlays){…}` line, `state.agentsBookMoves=bag.bePlays.bookMoves||null;`.
    - :6430 (immediately after the line-move block, inside the `!onPlays` region of
      `renderAgentsContent`) — new section `🧲 BOOK MOVEMENT — WHO MOVED, AND DID IT MATTER`:
      one-line explainer ("market-wide public %, US retail books only — this measures who moves
      first, not who sharps bet"), then `(bm.byBook||[]).slice(0,12)` rows (book · role · n ·
      led% · avg move · vs-public%, `small` rows at `opacity:.5` exactly like `renderBookEdges`
      :6887), then `(bm.live||[]).slice(0,20)` episode cards (matchup, `book` label, `line_from→
      line_to`, `↑/↓`, score in `var(--brass)`, `reasons.join(' · ')`, and
      `public_pct!=null?public_pct+'% public':'no public data'`). Existing `.card`/`esc()`/`btColor`
      helpers only — **no new CSS, no `<script src=>`**.
11. **`tools/smoke.mjs`** — extend (see Test plan).
12. **`DECISIONS.md`** — append a dated entry: snapshots-not-line_movements and why; market-wide-only
    public attribution and the retail-books ceiling; derived (not hardcoded) book roles; scoring weights.

Do **not** touch `agents/odds/index.js`, `agents/sharp/*`, `agents/public-splits/*`, or
`nfl-line-move/*` — those are follow-up phases.

## Risks & open questions

- **For Blake to decide:** scoring weights (0.30 mag / 0.20 key / 0.15 early / 0.20 vs-public /
  0.15 lead) and `MIN_SCORE=35` are judgement, not measurement. They are env-tunable
  (`BOOK_MOVE_MIN_SCORE`); the weights are a single `W` object at the top of the agent so they can
  be retuned in one place once there is a graded sample.
- **For Blake to decide:** should `book-move` episodes feed the signal engine / plays, or stay
  observational reference like `fair-line`? This spec ships it **observational only**.
- **Data genuinely cannot support:** per-book public/handle splits (no `book` in `public_splits`);
  "sharps hit this book" (no originating book in `BOOKS`); public context outside NHL/NBA/MLB/NFL.
- **Resolution ceiling:** `last_update` is the book's stamp, but if a book moves twice between two
  of our fetches we see only the net change — episode counts are a floor, not a census. Lead/follow
  is reliable only in aggregate.
- **Deferred:** price-only movement (moneyline, and MLB/NHL spreads where the line is fixed) — the
  natural unit is implied-probability points (`shared/odds-math.js`), a second pass.
- `early` rewards distance from kickoff; late steam is also sharp. Accepted as a deliberate bias
  toward origination (late moves are the hardest to separate from public volume) — documented in
  the header, revisit with graded data.

## Test plan

Extend `tools/smoke.mjs` with group **"10. Book movement attribution"** (same `ok()` helper and
read-the-source style as group 7; a numbering gap if the line-move spec's group 9 isn't built yet is
fine). Read `edge-tracker-agents/src/agents/book-move/index.js` and assert:
- `ok('book-move spends nothing', !/\bfetch\s*\(/.test(src))` — the hard constraint, pinned.
- `ok('book-move reads snapshots, not line_movements', /line_snapshots/.test(src) && !/line_movements/.test(src))`.
- `ok('book-move bounds its slate', /MAX_GAMES|slice\(0,\s*\d+\)/.test(src))` and
  `ok('snapshot query is descending+limited', /ascending:\s*false/.test(src) && /limit:\s*\d+/.test(src))`.
- `ok('book-move reuses shared key numbers', /shared\/key-numbers\.js/.test(src))`.
- `ok('book roles are derived', /led_pct/.test(src))` and
  `ok('no hardcoded sharp-book list', !/pinnacle|circa/i.test(src))`.
- `key-number/index.js`: `ok('key-number imports shared keys', /shared\/key-numbers\.js/.test(src))`
  and `ok('key-number no longer declares LAND_PCT', !/const LAND_PCT/.test(src))`.
- `store/index.js`: `ok('store exports setBookMoves', /export function setBookMoves/.test(src))`.
- `src/index.js`: `ok('/plays serves bookMoves', /bookMoves:\s*getBookMoves\(\)/.test(server))` and
  `ok('data-health watches book_move_log', /book_move_log/.test(server))`.
- `config/index.js` + `orchestrator/index.js` + `index.html`: `'book-move'` present in all three,
  and `AGENT_STALE_MS` contains `'book-move'` (catches a half-registration → permanent red dot).
- `index.html`: `ok('book-move render tolerates old cached payload', /bm\.live\s*\|\|/.test(html) && /bm\.byBook\s*\|\|/.test(html))`.
- Group 1 (inline-script parse) already covers the `index.html` edit.

Run `node tools/smoke.mjs` and `node tools/smoke.mjs --live` (both must be green).

### Manual check recipe (Blake, ~6 min)

1. Apply the `book_move_log` DDL in the Supabase SQL editor (it is idempotent), restart the agents
   process, then `curl -s "$API/health" | grep -i book-move` — expect a recent run with a summary
   like `12 scored moves · 9 books · 2 market-makers`. On an empty slate `dormant — empty slate` is
   the correct answer, not a failure.
2. `curl -s "$API/plays" | python3 -m json.tool | grep -A25 '"bookMoves"'` — confirm top-level
   `bookMoves` with `live[]` and `byBook[]`, each `live` row naming a `book`, a `line_from→line_to`,
   a `score`, and either a `public_pct` or `null` (null is expected for NCAAF/soccer/etc.).
3. `curl -s "$API/data-health" | grep -A2 book_move_log` — `today` should be non-zero once a slate
   has moved. (It should still return in roughly its usual ~36s; if it got slower, that's a finding.)
4. Serve the PWA: check ports first — `lsof -nP -iTCP -sTCP:LISTEN` (a Pool Room Pro Electron
   process holds 4317-4318, Vantyx holds 3000), then `npx serve .`, which **silently falls back to a
   random port** when its port is taken, so read the actual port off its output / that `lsof` list
   rather than assuming 3000.
5. Agents tab → scroll past 📐 LINE MOVEMENT to **🧲 BOOK MOVEMENT**. Expect a per-book table with
   roles (several marked `small` early on) and episode cards with reasons. Confirm the Agents grid
   row for `book-move` is green.
6. Stale-client check: in DevTools → Application **keep** `etBagCache` (do not clear storage) and
   hard-reload. First paint replays the old bag with no `bookMoves`; the section must be absent with
   **no console error**, and must appear after the live fetch lands.

## Follow-up phases (not designed here)

- **(a) Open→close movement for all 12 sports.** Already specified in
  `docs/specs/line-move-all-sports.md` (generalize `nfl-line-move` → `line-move`, `bySport`
  aggregate, zero new API spend). Independent of this spec; it reads `opening_lines`/`nfl_line_moves`
  while this reads `line_snapshots`, so the two can land in either order.
- **(b) Persist the `lastLines` baseline.** `lastLines` (`odds/index.js:162`) is a process-local Map,
  so `line_movements` loses its baseline on every redeploy. Rehydrating it from the latest
  `line_snapshots` row per `game_id|book|market|side` at startup (or a small `last_lines` table)
  makes `line_movements` dense — at which point it becomes a cheap pre-computed corroboration source
  for this agent and a candidate `/data-health` entry.
- **(c) Give steam/RLM a real history reader.** `sharp/index.js:15` and `public-splits/index.js:69`
  both consume `getIntel('movements')`, the array from only the most recent odds run — which is why
  `sharp` reports "no recent line movement" across 13,028 runs. Both should read a windowed history
  (this agent's snapshot reader, or a dense `line_movements` after (b)) instead of that 3-minute
  buffer, and steam should then be defined over `book_move_log` episodes so it inherits lead/follow.
