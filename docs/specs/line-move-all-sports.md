# Line Movement (Open→Close) for All Sports

Spec date: 2026-10-17 · **Refreshed in place 2026-11-05** against `c075e70` (= `origin/main`) · Branch: `feat/line-move-all-sports-2` · Decision: **D95**.

Refresh delta, in one breath: anchors re-verified (`index.html` is ~8,200 lines now); the rename is **reversed** (keep `nfl-line-move`); the cross-sport view moves to a **Signal-tab panel** and the NFL Prep block becomes NFL-only; `Number(null)===0` traps fixed (two are live in the current file); loud-skip via `blocked:` constants; test plan extends the 231/202 zero-fail suites with `fake-db` prior art; follow-ups updated.

## Problem

`opening_lines` is written for every sport (`odds/index.js:1335-1353` caps `total`/`spread`/`ml` from `computeMarkets`) and live consensus exists in `getGames()` for every sport, but `nfl-line-move` filters to `g.sport === 'NFL'` at `agents/nfl-line-move/index.js:23` — raw material for 12 sports, used for 1. Open→close direction is the cheapest already-paid-for market signal we have and it is dark for NCAAF/MLB/NBA/NCAAB/NHL/WNBA/SOCCER/UFC/BOXING. The fix is plumbing: **zero new Odds API calls**, structurally — the agent's inputs stay `getGames()` plus two reads of our own small tables, no `fetch(`, no import from `agents/odds/index.js`, `shared/espn-odds.js` or any event-endpoint helper, and a smoke assertion pins it (same technique as `book-move spends nothing`, `tools/smoke.mjs:167`).

## Approach

Drop the NFL filter, group the slate by `g.sport`, carry `sport` on every row, add a moneyline leg, publish `overall` + `bySport[]` in the one existing store slot. Sports are **derived from the slate, never from a list**: `getGames()` holds only what the odds agent fetched this run. Out of season a sport simply has no games; an empty slate is the existing `dormant` early return.

**Why not `getOddsCeilings().season` (D89–D91).** That signal answers a budget question — "is this sport in the ceiling denominator?" — with a deliberate 14-day release grace and a forced football backstop, so a sport reads `in` for two weeks after its last game and NFL reads `in` on a Tuesday in a backstop month with nothing on the board. This agent needs "which games are on the board right now", which is exactly `getGames()`. Consulting the season table would also require importing from `agents/odds/index.js`, which the zero-spend assertion forbids. Stated in the file header so nobody "fixes" it.

**Baseline/movement tables are untouched.** Open→close is `opening_lines` (first sight, immutable via `ignoreDuplicates`) vs in-memory consensus. It has no reason to read `line_movements`, `getIntel('movements')`/`'movementsAll'` (D77) or `line_snapshots` — those answer *when/who moved*, this answers *net from open*. A smoke assertion pins that none of the three names appear in the agent's code.

**Moneyline leg** so UFC/BOXING (`hasTotals: false`, no spreads) and SOCCER are not dark: `ml_move` is in **implied-probability points, home side, positive = home shortened**, because -105→+105 is a 210-point "move" and a ~2.5-pt real one. Soccer draws ignored (we store home ML only).

### Decision 1 (unchanged) — one store slot, `bySport` array, not a keyed map
`{ updated, live:[{sport, game_id, matchup, commence_time, open_total, close_total, total_move, open_spread, close_spread, spread_move, open_ml, close_ml, ml_move}], agg:{n,total_down_pct,total_avg_abs,spread_avg_abs,ml_avg_abs}, bySport:[{sport, …same as agg}] }`. Mirrors `clv-tracker/index.js:238-243`; an old service-worker-cached client still finds `lm.live`/`lm.agg` where it expects them. `sw.js` is network-first with `skipWaiting` (`sw.js:5,9`), no `CACHE` bump. `/plays` keeps `nflPrep.lineMove` and gains top-level `lineMove` (same object).

### Decision 2 (REVERSED) — keep the name `nfl-line-move`; generalize the behaviour
October's spec renamed to `line-move` because "an agent name is a label, not a key". That is less true now: `/health` carries durable per-agent `blockedRuns`/`blockedReason`/`blockedSince` (D80, `orchestrator/index.js:159-161`) keyed by `agent.name`; `scan_runs.agent` is the only durable run history and the PWA's Supabase-only health fallback derives status from it (`index.html:6092-6096`); `AGENTS_META`/`AGENT_STALE_MS` (`index.html:6043,6055`) and `sigHealthFacts` (`:7101`) key on it; and `INTERVAL_NFL_LINE_MOVE` (`config/index.js:254-264`) would stop applying **silently** if set on Railway — a D80-shaped config loss. The trade: a misleading name (mitigated by the header comment, the label "Opener→Close Lines (all sports)", and a smoke assertion that fails if an NFL gate is re-added) versus a split run history, a "No data" roster row until the first post-deploy run, nine rename sites, and one silent env break. **Keep the name.** Same asymmetry for the table: `nfl_line_moves` stays, additive columns only. Store accessors `setNflLineMove/getNflLineMove` also stay (internal; renaming them buys nothing durable). If Blake wants the rename anyway, the full site list is in git history of this file at `c075e70`.

Rejected: a map keyed by sport (breaks cached clients); a per-sport calendar (duplicates `inSeasonKeys()`); `Object.keys(SPORTS)` (emits 12 empty buckets).

## Data model / API changes

`scripts/schema.sql`, after `:710` — **must be hand-run** (D69/D70 history; nothing applies this file):
```sql
alter table nfl_line_moves add column if not exists sport    text;
alter table nfl_line_moves add column if not exists open_ml  numeric;
alter table nfl_line_moves add column if not exists close_ml numeric;
alter table nfl_line_moves add column if not exists ml_move  numeric;  -- implied-prob pts, home side
update nfl_line_moves set sport = 'NFL' where sport is null;            -- pre-existing rows are all NFL
```
No new index: the table is NFL-only today (hundreds of rows) and at 12 sports grows ~150 rows/day, ~27k over the 180-day window — a sequential scan is free (D70 rule; the existing `nfl_line_moves_idx` may itself be unapplied and it does not matter). No endpoint added; `/plays` gains `lineMove`.

**Query cost, bounded.** (1) `opening_lines` (3,427 rows): `in: { game_id }` over the slate, chunked 100 ids per call so a 300-game Saturday never builds an over-long PostgREST URL; served by `unique (game_id, market)`. (2) `nfl_line_moves` today-dedup: `gte captured_at` today, `select game_id`. (3) history: `select sport,total_move,spread_move,ml_move`, `gte: { captured_at: now-180d }`, `order captured_at desc`, `limit 4000` — one query, grouped in JS, not per-sport. **`line_snapshots` (7M rows) is never read.** Nothing else to hand-run.

## File-by-file plan

1. **`edge-tracker-agents/src/agents/nfl-line-move/index.js`** — rewrite in place (name stays `'nfl-line-move'`):
   - Header: drop "NFL", keep "$0 / dormant on an empty slate", add the two paragraphs above (why not the season signal; why not the movement tables), the `ml_move` sign convention.
   - Imports: add `import { impliedProb } from '../shared/odds-math.js'`. Nothing from `odds/`, `espn-odds`, or event helpers.
   - Add `const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);` (the `shared/key-numbers.js:34` shape). **Two live traps in the current file:** `:31 Number(o.line)` and `:68-69 .map(Number).filter(Number.isFinite)` turn a null `total_move` into a counted `0` move, diluting `total_down_pct` and `avg_abs`. Replace both with `num()` + `Number.isFinite`. `impliedProb(null)` returns `0` silently (`toDecimal(null)` → `Infinity`), so `ml_move` is computed only when both sides pass `num()` and `Math.abs(x) >= 100`.
   - `:23` → `getGames().filter((g) => g.sport && g.commence_time)`; `:24` message `'dormant — empty slate'` (benign, not blocked).
   - `:29` openers read: chunked as above; on **throw** → `setNflLineMove(null); return { summary: 'skipped — opening_lines unreadable', blocked: OPENERS_BLOCKED }` where `const OPENERS_BLOCKED = 'opening_lines could not be read'` — a constant literal, no counts, no env (D80). Today it is a swallowed `catch (_)`.
   - Row (`:41-45`): add `sport: g.sport`, `open_ml`/`close_ml` from `openMap.get(…|ml)` / `m.ml.consensusHome`, `ml_move = r1((impliedProb(close) - impliedProb(open)) * 100)`.
   - `:57` fresh filter also accepts `r.ml_move != null`. `:61` insert adds the four columns. On a missing-column error (`/column/i.test(e.message)`, the D73 distinction — not `db.isMissingRelation`) retry once with the four fields stripped so NFL history keeps landing, and return `blocked: SCHEMA_BLOCKED` (`'nfl_line_moves is missing the all-sports columns — run the schema.sql block'`). Prune `persisted` to game_ids still on the slate (the Set was never pruned).
   - History (`:67`): the bounded query above; `const agg = (rows) => ({…})` with `ml_avg_abs`; `overall = agg(hist)`, `bySport` built the `clv-tracker:238-243` way, sorted by `n`.
   - Publish: `live` sorted by `commence_time`, `.slice(0, 80)` (12-sport Saturday); `setNflLineMove({ updated, live, agg: overall, bySport })`. Summary: `` `${live.length} games · ${sports.length} sports (${fresh.length} new closes) · ${overall.n} in history` ``.
2. **`edge-tracker-agents/src/config/index.js`** `:230-231` — comment and label `'Opener→Close Lines (all sports)'`; `min: 30` unchanged.
3. **`edge-tracker-agents/src/index.js`** `:419` — add top-level `lineMove: getNflLineMove()`; keep `nflPrep.lineMove`.
4. **`edge-tracker-agents/scripts/schema.sql`** — DDL block after `:710`, with a comment that it is hand-run.
5. **`index.html`**:
   - `:6043` label `'Opener→Close Lines (all sports)'`, cadence `'30m (sports on the slate)'`. `:6055` unchanged.
   - `:6127` stays; append to the `:6129` line `state.agentsLineMove=bag.bePlays.lineMove||(bag.bePlays.nflPrep&&bag.bePlays.nflPrep.lineMove)||null;`.
   - `:6675-6692` (Plays → NFL Prep, inside the `:6566` NFL PREP section): read `state.agentsLineMove||state.agentsNflLineMove`, and **filter `live` to `g.sport==='NFL'||g.sport==null`** (the page is NFL Prep; legacy cached rows have no `sport`). Header text unchanged. The history card uses the NFL entry of `lm.bySport||[]` when present, else `lm.agg` (old payload).
   - Signal tab, fifth panel **`close`**: `SIG_PANELS` (`:6925`) gains `{id:'close',label:'Close'}`; `SIG_CLOSE_BOUND=(AGENT_STALE_MS['nfl-line-move']||5400000)*2` beside `:6928`; `sigCloseFacts()` next to `:7122` reading `state.agentsLineMove` with `sigState(state.sigSrc.plays, lm, (lm.live||[]).length+(lm.bySport||[]).length, SIG_CLOSE_BOUND, lm&&lm.updated)`; a chip entry in `sigChipStatus()` (`:7142`, text `N sports` or `—`); `renderSigClose()` after `renderSigSteam()` (`:7485`) — banners via `sigBanner` only, a `sigtbl` per-sport table (sport · n · totals-down% · avg total · avg spread · avg ML pp) then live rows (sport, matchup, O/U open→now, spr, ML pp) in `.sigtbl-wrap`; dispatch in `renderSignalContent()` (`:6984-6987`). No `fetch(`, no CSS outside `.sighud`, no `<svg>`. Every field optional-chained/defaulted (`etBagCache` replay, `:6146-6151`).
6. **`tools/smoke.mjs`** — new group 16 (below). **`edge-tracker-agents/test/nfl-line-move.test.js`** — new (below).
7. **`DECISIONS.md`** — D95: generalization, rename reversed and why, table asymmetry, slate-not-season, the two `Number` traps, the two `blocked` constants.
8. **`docs/nfl-model-scope.md`** `:25` — one-line status edit.

Do **not** touch `agents/odds/*`, `agents/sharp/*`, `agents/book-move/*`, `agents/public-splits/*`, `src/health/data-health.js` (already probes `nfl_line_moves`, `:103`).

## Risks & open questions

- **Blake:** confirm keeping the name `nfl-line-move` (Decision 2). Flip = nine sites + a split history; the spec assumes keep.
- **Blake:** the DDL is hand-run. Until it is, closes still persist (legacy columns) but `/health` shows `blockedRuns ≥ 1` with the schema reason — that is the feature, not a defect.
- UFC/BOXING `game_id`s are per fight: many rows per card-day. Expected.
- Early `bySport` buckets will be thin (n<20); render regardless, no min-n gate (reference data; clv-tracker shows thin buckets).
- `impliedProb` has no null guard upstream; this spec guards at the call site rather than changing `shared/odds-math.js` (other callers unaudited).

## Test plan

Baseline is **231 tests / 202 smoke, 0 failures** (D82); any failure is real. `npm ci` in `edge-tracker-agents/` first.

**Unit — `test/nfl-line-move.test.js`** (`node:test`, `mock.module` for `db`, `utils`, `store`; `fakeDb` from `test/helpers/fake-db.js`; the `clv-tracker.test.js:25-35` harness shape; inject `getGames` and capture `setNflLineMove`):
1. Three sports on the slate (NFL total/spread, NBA, UFC ML-only) → `live[]` rows carry `sport`, `bySport` has 3 entries, UFC row has `ml_move` and null totals/spread.
2. `ml_move` for open -110 → close -130 ≈ +4.1 pp (home shortened); a `null` opener yields `null`, never `0`.
3. History rows with `total_move: null` do not count toward `total_down_pct`/`total_avg_abs` (the live trap).
4. Query shape (assert on `db.calls.select`): history has `gte.captured_at`, `ascending:false`, `limit` ≤ 4000; openers are chunked (≤100 ids per call for a 250-game slate); **no select on `line_snapshots` or `line_movements`**.
5. `fail['select:opening_lines']` → result has `blocked === OPENERS_BLOCKED` (constant equality, D80 closed-template style) and store set to `null`.
6. `fail['insert:nfl_line_moves']` with a "column … does not exist" message → second insert without `sport/open_ml/close_ml/ml_move`, result `blocked === SCHEMA_BLOCKED`; a non-column error → no retry, no blocked.
7. Empty slate → `dormant — empty slate`, no `blocked`.

**Smoke — `tools/smoke.mjs` group 16 "Open→close for all sports"** (same read-the-source style as group 10; feature-detect on `/bySport/.test(lmSrc)` and `skip()` otherwise so the harness stays green on `main`):
`spends nothing` (`!/\bfetch\s*\(/` on `codeOnly(src)`); `not NFL-gated` (`!/sport\s*===\s*['"]NFL['"]/`); `does not read movement tables` (no `line_snapshots|line_movements|getIntel\(`); `does not import the odds agent` (no `agents/odds/|espn-odds`); `blocked reasons are constant literals` (`OPENERS_BLOCKED`/`SCHEMA_BLOCKED` assigned from a quoted string with no `${`); `no bare Number( on possibly-absent values` (`!/Number\((o|h)\./`); `name unchanged` (`name: 'nfl-line-move'` in agent, config, `AGENTS_META`, `AGENT_STALE_MS`); `/plays serves lineMove at top level` and `nflPrep` still has `lineMove:`; `index.html` has `SIG_PANELS` entry `close`, `function renderSigClose`, `lm.bySport||`, and the NFL Prep block filters on `sport==='NFL'`; group 14's existing "no second /plays fetch" and scoped-CSS assertions must still pass.

Verifier: `node tools/smoke.mjs`, `node tools/smoke.mjs --live`, `npm test`; `git grep -n "line-move'" -- edge-tracker-agents/src index.html` shows only `nfl-line-move`.

### Manual check recipe (Blake, ~10 min) — each step names what it proves
0. `lsof -nP -iTCP -sTCP:LISTEN` — Pool Room Pro holds 4317-4318, node 3000 and 5173, ControlCenter 5000 and 7000. Note a free port; `npx serve .` silently falls back when its default is taken, so read its port from the next `lsof`, never assume.
1. Supabase SQL editor: run the five DDL lines, then `select column_name from information_schema.columns where table_name='nfl_line_moves'` → shows `sport, open_ml, close_ml, ml_move`. *Proves the schema is applied.*
2. Deploy/restart Railway; `curl -s $API/health | python3 -c "import sys,json;a=[x for x in json.load(sys.stdin)['agents'] if x['name']=='nfl-line-move'][0];print(a['lastResult'],a['blockedRuns'],a['blockedReason'])"` → summary reads `N games · K sports …` with `K ≥ 2` on a multi-sport day, `blockedRuns 0`. *Proves the run completed, unblocked, across sports.* (If `blockedRuns ≥ 1` with the schema reason, step 1 did not take.)
3. **Decisive observable:** `curl -s $API/plays | python3 -c "import sys,json;lm=json.load(sys.stdin)['lineMove'];print([b['sport'] for b in lm['bySport']]);print([r for r in lm['live'] if r['sport']!='NFL' and (r['total_move'] is not None or r['ml_move'] is not None)][:3])"` → a non-NFL sport with a real non-null delta. *Proves non-NFL open→close is published.* Also `'nflPrep' in …` and `nflPrep.lineMove is lineMove-shaped` — *backward-compat key intact.*
4. After any non-NFL game passes kickoff −30m: `select sport, count(*) from nfl_line_moves where captured_at > now() - interval '1 day' group by 1` → a non-NFL row. *Proves persistence, with `sport` populated.*
5. `/budget` `used` before and after: the only new reads are our own tables; smoke pins no `fetch(`. *Zero Odds API spend is structural, not observed.*
6. PWA on the port from step 0: Signal → Close chip shows `K sports`; panel renders the per-sport table and live rows with sport chips. Plays → NFL Prep → 📐 block shows **only NFL** rows. *Proves both surfaces, and that NFL Prep stayed NFL.*
7. DevTools → Application: keep `etBagCache`, hard-reload → first paint from the old cached payload (no `sport`, no `bySport`) renders without a console error; Close panel shows a banner, not `undefined`. *Proves the cache seam.*

## Follow-up phases (not designed here)

Done since October: `book-move` per-book attribution (#133), movement baseline rehydration (#136), Signal dashboard (#138), automatic seasonality (#139), the steam history reader (D92–D94). Remaining: `public-splits` absent-vs-zero (in the small-fixes PR now); the zero-recipient watchdog (`notifyAll` needs `ALERT_NUMBERS`/`SMTP_*`); the "add an originating book" decision (D57 — costs API spend, deliberately untaken). Optional cosmetic: `create view line_moves as select * from nfl_line_moves;` if the table name ever grates.
