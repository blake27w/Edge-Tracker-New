# Line Movement (Open→Close) for All Sports

Spec date: 2026-10-14 · Branch: `feat/line-move-all-sports` · Scope: audit item **5 only**.

## Problem

`opening_lines` is written sport-agnostically by the odds agent (`odds/index.js:362-379`) and live
consensus exists for every sport, but `nfl-line-move` self-gates to NFL at
`agents/nfl-line-move/index.js:23` — raw material for 12 sports, used for 1. The result is that
open→close market direction (the cheapest market-direction signal we have, already paid for) is
invisible for NCAAF, MLB, NBA, NCAAB, NHL, WNBA, SOCCER, UFC, BOXING. Everything needed is already
in memory and in Postgres, so the fix is pure plumbing.

**Hard constraint: zero new Odds API calls.** Honored structurally — the agent's only inputs are
`getGames()` (the in-memory slate the odds agent already published) and two Supabase reads
(`opening_lines`, `nfl_line_moves`). The rewritten file must contain **no `fetch(`** and must not
import from `agents/odds/index.js`, `shared/espn-odds.js`, or any event-endpoint helper. A smoke
assertion below pins this.

## Approach

Drop the NFL filter; group the slate by `g.sport`; carry `sport` on every row; publish one payload
with an `overall` aggregate plus a `bySport` array. The sport list is **derived from the slate, not
hardcoded** — `getGames()` only ever contains sports the odds agent fetched, and it only fetches
in-season keys (`inSeasonKeys()` at `odds/index.js:197`, applied at `odds/index.js:318`). That is
the house idiom (`weather/index.js:60`, `key-number/index.js:38`, `fair-line/index.js:37` all filter
`getGames()` rather than consulting a sport list). It also means **in-season gating is free**: out of
season a sport simply has no games, and an empty slate makes the whole agent a no-op.

Moneyline is included so combat/soccer are not dark: `SPORTS.UFC`/`BOXING` have `hasTotals: false`
and no spreads, but `odds/index.js:375` already captures an `ml` opener. ML move is recorded in
**implied-probability points** (`impliedProb` from `shared/odds-math.js`), not raw American points,
because -105 → +105 is a 210-point "move" and a ~2.5pt real one.

Rejected alternatives:
- *A map keyed by sport in the store* (`{NFL:{...},MLB:{...}}`) — rejected, see store shape below.
- *A per-sport cadence table / per-sport in-season calendar* — rejected; duplicates the season
  knowledge `inSeasonKeys()` already provides for free and would drift from it.
- *Hardcoding `Object.keys(SPORTS)`* — rejected; it would make the agent iterate 12 sports with no
  games and emit empty `bySport` buckets.

### Decision 1 — Store shape: one slot, `bySport` array (NOT a map keyed by sport)

Keep a single store slot holding:

```js
{ updated, live: [ {sport, game_id, matchup, commence_time, open_total, close_total, total_move,
                    open_spread, close_spread, spread_move, open_ml, close_ml, ml_move} ],
  agg: {n, total_down_pct, total_avg_abs, spread_avg_abs},          // overall, unchanged shape
  bySport: [ {sport, n, total_down_pct, total_avg_abs, spread_avg_abs, ml_avg_abs} ] }
```

Why, not a keyed map:
1. **It mirrors the existing house idiom** for multi-sport aggregates — `clv-tracker/index.js:118-123`
   publishes exactly `overall` + `bySport: Object.entries(...).map(([sport,rows]) => ({sport, ...}))`
   sorted by `n`, and the PWA already renders that pattern in `renderClvDashboard` (`index.html:5972`).
2. **It is backward compatible across the deploy seam**, which a keyed map is not. The PWA reads
   `state.agentsNflLineMove` (set at `index.html:5899`) and renders `lm.agg` + `lm.live` at
   `index.html:6415-6430`. With this shape an old service-worker-cached client keeps working: it
   finds `lm.live` and `lm.agg` exactly where it expects them and renders all sports' rows under the
   existing 📐 header (extra fields ignored). With a keyed map, `lm.live` would be `undefined` and
   the section would silently vanish for that client.
3. **The reverse seam matters too**: `loadAgentsData` persists the whole payload to
   `localStorage.etBagCache` (`index.html:5958`) and `hydrateAgentsCache` (`index.html:5917`) replays
   it on first paint — so a *new* `index.html` will paint an *old* payload with no `sport` and no
   `bySport`. The new render must therefore treat both as optional (`lm.bySport||[]`,
   `g.sport?esc(g.sport)+' · ':''`). Required, not nice-to-have.

`sw.js` is network-first for the shell (`sw.js:23-27`), so the stale-client window is one load; the
cache fallback only bites offline. No `CACHE` bump needed.

**API surface:** `/plays` keeps `nflPrep.lineMove` (`src/index.js:432`) **and** gains a top-level
`lineMove` key with the same object. The PWA reads `bag.bePlays.lineMove||bag.bePlays.nflPrep.lineMove`.
`nflPrep.lineMove` stays indefinitely — it costs one property on a payload that already has ~25, and
removing it is the one change that can blank a cached client's view.

### Decision 2 — Rename the agent: `nfl-line-move` → `line-move`. Yes.

The agent becomes genuinely cross-sport; leaving `nfl-` on it misleads every future reader and
invites someone to re-add an NFL filter "to match the name". The cost is bounded: the agent name is a
*scheduler key + display label*, not a foreign key — nothing joins on it. Renaming orphans this
agent's rows in `scan_runs.agent` (the PWA's per-agent "last run / stale" dot, `agentStatus` at
`index.html:5843`, and the live feed at `index.html:5909`), so the agent shows "never ran" until its
first post-deploy run, and old `nfl-line-move` feed lines keep their old name. Accepted: display-only,
self-healing within 30 minutes.

Every site to change (all of them — a half-rename shows a permanently red dot):
| File | Location | Change |
|---|---|---|
| `edge-tracker-agents/src/agents/nfl-line-move/index.js` | whole dir | `git mv` to `agents/line-move/index.js`; `name: 'line-move'` at :82; `logger.warn('line-move', …)` at :62 |
| `edge-tracker-agents/src/config/index.js` | :192 | key `'nfl-line-move'` → `'line-move'`, label `'Opener→Close Lines'`, `min: 30`; update the :191 comment |
| `edge-tracker-agents/src/orchestrator/index.js` | :55, :75 | import path `../agents/line-move/index.js`, registry entry `lineMove` |
| `edge-tracker-agents/src/store/index.js` | :39, :91-92 | field `nflLineMove` → `lineMove`; `setNflLineMove`/`getNflLineMove` → `setLineMove`/`getLineMove` |
| `edge-tracker-agents/src/index.js` | :12, :432 | import `getLineMove`; `nflPrep.lineMove: getLineMove()` **and** new top-level `lineMove: getLineMove()` |
| `index.html` | :5815 | `{name:'line-move',icon:'📐',label:'Opener→Close Lines',cadence:'30m (sports in season)'}` |
| `index.html` | :5827 | `AGENT_STALE_MS`: `'nfl-line-move':5400000` → `'line-move':5400000` |
| `index.html` | :5899, :6414 | `state.agentsNflLineMove` → `state.agentsLineMove`, sourced per "API surface" above |
| `docs/nfl-model-scope.md` | :25 | note it generalized to all sports (one-line edit) |

Env override note: cadence overrides are derived as `INTERVAL_<NAME>` with dashes→underscores
(`config/index.js:117-123`), so `INTERVAL_NFL_LINE_MOVE` becomes `INTERVAL_LINE_MOVE`. There is no
`NFL_LINE_MOVE` feature flag to carry over (unlike `NFL_DERIVATIVES`). Mention in `DECISIONS.md`.

**The DB table keeps the name `nfl_line_moves`.** Deliberate asymmetry: an agent name is a label, a
live table name is data. `scripts/schema.sql` is apply-anytime idempotent DDL (`create table if not
exists` + `alter table … add column if not exists`, e.g. :116, :257-267) and cannot express a rename
safely; renaming would also split NFL history from new rows. See Risks for the optional later view.

### Decision 3 — Season/cadence gating

Unchanged wake cadence: `min: 30`. The agent spends nothing per wake (no HTTP; two Supabase selects,
one conditional insert), so a per-sport cadence would add config surface for no saving. Gating is
inherent: `getGames()` is empty-for-that-sport out of season, and if the whole slate is empty the
agent returns `dormant` early exactly as it does today (:24). PWA cadence label becomes
`30m (sports in season)`.

## Data model / API changes

`scripts/schema.sql` — additive, after `nfl_line_moves_idx` (:679):
```sql
alter table nfl_line_moves add column if not exists sport     text;
alter table nfl_line_moves add column if not exists open_ml   numeric;
alter table nfl_line_moves add column if not exists close_ml  numeric;
alter table nfl_line_moves add column if not exists ml_move   numeric;  -- implied-prob points, home
update nfl_line_moves set sport = 'NFL' where sport is null;            -- pre-existing rows are all NFL
create index if not exists nfl_line_moves_sport_idx on nfl_line_moves (sport, captured_at desc);
```
No endpoint added. `/plays` gains top-level `lineMove` (identical object to `nflPrep.lineMove`).

## File-by-file plan

1. **`edge-tracker-agents/src/agents/line-move/index.js`** (moved from `nfl-line-move/`) — rewrite of
   the header comment (drop "NFL", keep the "$0 / dormant offseason" claim) and:
   - :13 import `{ getGames, setLineMove }`; add `import { impliedProb } from '../shared/odds-math.js'`.
   - :23 `const games = getGames().filter((g) => g.sport && g.commence_time);` (no sport filter).
   - :24 dormant message → `'dormant — empty slate'`.
   - :41-45 row gains `sport: g.sport`, plus `open_ml`/`close_ml` from `openMap.get(…|ml)` /
     `m.ml.consensusHome`, and `ml_move` = `r1((impliedProb(close_ml) - impliedProb(open_ml)) * 100)`
     guarded for nulls (combat/soccer only have these; `computeMarkets` returns `null` medians for
     absent markets — `games/lines.js:33-37` — so totals/spreads stay `null` harmlessly).
   - :57 `fresh` filter also accepts `r.ml_move != null`.
   - :61 insert adds `sport`, `open_ml`, `close_ml`, `ml_move`.
   - :67 history select → `'sport,total_move,spread_move,ml_move'` with
     `gte: { captured_at: <180 days ago ISO> }`, `limit: 4000`. One query, not per-sport — no N+1.
   - :70-75 extract the aggregate into `const agg = (rows) => ({…})` (add `ml_avg_abs`), call it once
     for `overall` and once per sport group built the `clv-tracker:118-119` way.
   - :77 sort `live` by `commence_time`; keep `.slice(0, 32)` **after** a sport-interleave is *not*
     needed — instead raise to `.slice(0, 60)` so a 12-sport Saturday is not truncated to one sport.
   - :78 `setLineMove({ updated, live, agg: overall, bySport })`.
   - :79 summary → `` `${live.length} games · ${sports.length} sports (${fresh.length} new closes) · ${overall.n} in history` ``.
2. **`edge-tracker-agents/src/store/index.js`** — :39 field + :91-92 accessor rename (table above).
3. **`edge-tracker-agents/src/config/index.js`** — :191-192 key/label/comment.
4. **`edge-tracker-agents/src/orchestrator/index.js`** — :55 import, :75 registry.
5. **`edge-tracker-agents/src/index.js`** — :12 import, :432 both payload keys.
6. **`edge-tracker-agents/scripts/schema.sql`** — the DDL block above, after :679.
7. **`index.html`** — :5815 list entry, :5827 stale map, :5899 state assignment (with the
   `lineMove||nflPrep.lineMove` fallback), :6413-6430 render: rename the header to
   `📐 LINE MOVEMENT — OPEN → CLOSE`, print the overall `agg` card as today, then (if `lm.bySport`
   has ≥2 entries) a compact per-sport line per entry in the existing `.card` style, then the live
   rows with a `sport` prefix chip (`gbChip` at :6660 is the existing helper) and an ML leg rendered
   only when `g.ml_move != null`. Every new field access must be optional-chained/defaulted (old
   cached payload). No new CSS, no new `<script src=>`.
8. **`tools/smoke.mjs`** — extend (see Test plan).
9. **`DECISIONS.md`** — append a dated D17 entry: generalization, store shape, rename, table-name
   asymmetry, `INTERVAL_` env rename.
10. **`docs/nfl-model-scope.md`** :25 — one-line status edit.

Do **not** touch `agents/odds/index.js`, `agents/sharp/*`, `agents/public-splits/*`, or
`buildDataHealth` (`src/index.js:320-335`) — those are phases (b)/(c).

## Risks & open questions

- **For Blake to decide:** accept the orphaned `nfl-line-move` run history in `scan_runs` (the
  rename), or keep the stale name? Spec assumes rename.
- **For Blake to decide:** table stays `nfl_line_moves`. A later cosmetic fix is
  `create view line_moves as select * from nfl_line_moves;` — not in this spec.
- UFC/BOXING `game_id`s are per-fight; the per-day dedup at :54 is keyed on `game_id` only, which is
  still unique — but a fight card produces many rows per day. Expected, not a bug.
- `ml_move` sign convention is *home side, implied-probability points, positive = home shortened*.
  Soccer draws are ignored (we only store home ML). Document it in the file header.
- The 180-day history window plus 12 sports could make `bySport` buckets thin (n<20) early. Render
  per-sport lines regardless; do **not** add a min-n gate — this is reference data, and clv-tracker
  shows thin buckets too.

## Test plan

Extend `tools/smoke.mjs` with a new group **"9. Line-move generalization"** (same `ok()` helper, same
read-the-source style as group 7, which already reads `edge-tracker-agents/src/index.js`):
- read `edge-tracker-agents/src/agents/line-move/index.js`:
  - `ok('line-move spends nothing', !/\bfetch\s*\(/.test(src))` — the hard constraint, pinned.
  - `ok('line-move is not NFL-gated', !/sport\s*===\s*['"]NFL['"]/.test(src))`.
  - `ok('line-move publishes bySport', /bySport/.test(src))`.
- read `config/index.js`, `orchestrator/index.js`, `index.html`: assert `'line-move'` present in all
  three **and** `nfl-line-move` absent from all three (catches a half-rename), and that
  `AGENT_STALE_MS` contains `'line-move'`.
- read `store/index.js`: `ok('store exports setLineMove', /export function setLineMove/.test(src))`.
- read `src/index.js`: `ok('/plays serves lineMove at top level', /lineMove:\s*getLineMove\(\)/…)` and
  that `nflPrep` still carries `lineMove:` (backward compat).
- `index.html`: `ok('line-move render tolerates old cached payload', /lm\.bySport\s*\|\|/.test(html))`.
- Group 1 (inline-script parse) already covers the `index.html` edit; no change needed there.

Run `node tools/smoke.mjs` and `node tools/smoke.mjs --live`. Verifier should additionally confirm
`git grep -n "nfl-line-move\|NflLineMove"` returns only `DECISIONS.md` and `docs/`.

### Manual check recipe (Blake, ~5 min)

1. Apply the schema DDL in the Supabase SQL editor, then restart the agents process and hit
   `/health` — the agent list should show `line-move` (not `nfl-line-move`) with a recent run.
2. `curl -s "$API/plays" | python3 -m json.tool | grep -A3 '"lineMove"'` — confirm a top-level
   `lineMove` exists, `live[]` rows carry `sport`, and `bySport` has more than one entry on a day with
   a multi-sport slate (an NFL-only Sunday night will legitimately show one).
3. Serve the PWA: `npx serve .` — **it silently falls back to a random port when 3000/5000 is taken**
   (Vantyx holds 3000; a Pool Room Pro Electron process holds 4317-4318), so read the port off
   `lsof -nP -iTCP -sTCP:LISTEN | grep -i node` rather than assuming, and open that port.
4. Agents tab → scroll to 📐 LINE MOVEMENT — OPEN → CLOSE. Expect non-NFL rows with sport chips, an
   overall history card, and per-sport lines. Confirm the Agents list row for `line-move` is green.
5. Stale-client check: in DevTools → Application, keep `etBagCache` (do **not** clear storage) and
   hard-reload. The section must still render on first paint from the old cached payload (no `sport`,
   no `bySport`) without a console error — this is the SW/localStorage seam.
6. `curl -s "$API/plays" | grep -c '"nflPrep"'` → 1, and `nflPrep.lineMove` still populated
   (backward-compat key).

## Follow-up phases (not designed here)

- **Phase (b) — give `line_movements` a reader.** `line_movements` is write-only today: the sole
  reference is the INSERT at `odds/index.js:356`. `sharp` and `public-splits` consume
  `getIntel('movements')`, the in-memory array from only the most recent odds run, which is why sharp
  reports "no recent line movement" across 13,028 runs. Phase (b) queries `line_movements` over a real
  window for steam/RLM, and adds `['line_movements','fetched_at']` to the `buildDataHealth` specs list
  at `src/index.js:323-328`, where it is currently unwatched.
- **Phase (c) — persist the movement baseline.** `lastLines` (`odds/index.js:162`) is a process-local
  `Map`, so every redeploy wipes the baseline and the first post-restart run detects zero movement.
  Phase (c) rehydrates it from the latest `line_snapshots` row per `game_id|book|market|side` at
  startup (or writes a small `last_lines` table), making detection survive restarts. Related: movement
  is computed only inside `normalize()`, so budget-capped sports (the `break` at `odds/index.js:320`)
  produce none — worth fixing in the same pass.
