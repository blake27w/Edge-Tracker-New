# Signal Dashboard — live, in the PWA

Status: proposed · 2026-11-04 · branch `feat/sharp-history-reader` (name is stale; this is the dashboard)

> **Not** `docs/specs/sharp-history-reader.md`, which is a different, shelved feature sitting on this
> same branch. Do not build that.

## Problem

Four things the system knows — book reputation, agent/data health, odds spend, steam — are each
buried in a different corner of a 580-line `renderAgentsContent()` or in no renderer at all, and
Blake has no single screen to look at on a phone. Worse, every one of them currently renders
"nothing happened" and "I can't see it" identically: that is what hid the `sharp` bug for 13,000+
runs, and it is what `vs_public` is doing right now. A standalone Artifact can't fetch the Railway
API under its CSP, so this lands in `index.html`.

## Approach

**A new home tab `signal` ("📡 Signal"), with four sub-panels behind a chip row.** It is a tab, not
a section inside Agents, because the Agents tab is already the longest scroll in the app and the
health panel's whole value is being the *first* thing on screen. It is not a new top-level view
because that would reintroduce the second navigation axis D43 exists to remove.

Panel order, which is also the chip order and matters: **Health → Budget → Books → Steam.** Health
first because "is anything even running" gates the meaning of everything else; Budget second because
the 1 November reset has passed and nobody has read it (HANDOFF open item 3). Only the active panel
is in the DOM — on a phone, four panels concatenated is an unusable scroll.

**Zero new network traffic.** `loadAgentsData()` (6001) already fetches `/health`, `/plays`,
`/feed`, `/budget`, `/data-health`, `/splits`, `/research` in one `Promise.all` and persists the
whole bag to `etBagCache`. The dashboard reads only `state.agents*` fields that `applyAgentsBag`
(5933) already populates. The sole change to the fetch layer is widening `onView` / `rerender`
(6002–6003) to include `'signal'`. **No second `/plays` download on tab switch** — switching to
Signal from Agents reuses the same in-memory state; a cold open hydrates from `etBagCache` first
(instant paint) and the live refresh replaces it. `/data-health` stays exactly where it is, inside
the existing `Promise.all`: it is ~976ms post-D68, it never blocks first paint (the cached bag
paints first), and moving it out is a separate change.

Rejected: a dedicated `/dashboard` aggregate endpoint (a fifth consumer of the same data, and a new
route to keep in sync); fetching `/plays` independently for this tab (a second 1.36MB download);
making `/data-health` lazy-on-chip-tap (it would then be absent from the cached bag on the Health
panel's *first* paint, which is the one paint that matters).

**The honest-empty-state machinery is the core of this spec.** There is a real bug in the current
code that makes it necessary: `applyAgentsBag` guards every backend assignment as
`if(bag.beDataHealth) state.agentsDataHealth=bag.beDataHealth;`, and each fetch in `loadAgentsData`
ends `.catch(function(){return {}})`. So **a failed read leaves the previous value in place and is
indistinguishable from a successful one.** Fix: record per-source outcome.

```
state.sigSrc = { health:{ok:false,at:null}, plays:…, feed:…, budget:…, dataHealth:…, splits:… }
```

written in `loadAgentsData`'s `.then` by testing for the key's presence in `bag`, *before*
`applyAgentsBag` runs. Every panel then renders one of exactly five states via one shared helper:

| state | when | copy (verbatim) |
|---|---|---|
| `loading` | no cached value, no load finished | `Loading — no cached copy on this device yet.` |
| `nodata` | source `ok`, payload present, count 0 | `Feed answered. 0 <things> right now.` + `as of <time>` |
| `stale` | payload's own `updated` older than the panel's bound | `Last produced <ago> ago — older than <bound>. Shown as history, not as now.` |
| `off` | payload present but the mechanism provably isn't producing | `NOT FIRING — <reason>. Blank because the signal isn't being produced, not because there is nothing to see.` |
| `failed` | `sigSrc.<src>.ok === false` | `Read failed — <src> did not answer on the last refresh (<ago>). Showing the last good copy from <ago>.` or `…and nothing is cached.` |

`stale` and `failed` are **banners over** whatever data exists, never replacements for it — showing
stale numbers unlabelled is the failure; hiding them is also a failure.

**`vs_public` is unavailable, and must say so.** Confirmed live: `vs_public_n === 0` and
`vs_public_pct === null` for all 10 books. What I found in the code without fixing it (see Risks for
the discriminating observable):

- The join *key shape* is fine. `public-splits` copies `game_id` straight out of our own slate prompt
  (`public-splits/index.js:58,62`) and writes `market` as `spread|total|ml`, which is exactly what
  `book-move`'s `SPLIT_MARKET` (`book-move/index.js:95`) maps `spreads|totals` onto.
- `SPLIT_MARKET` has **no `h2h` entry**, so `againstPublic` returns `null` for every moneyline
  episode by construction. That is a real contributor but cannot explain *all* books at 0.
- The remaining three candidates, in likelihood order: (a) `public_splits` has no recent rows at all
  — it is Claude-web-search sourced, it covers only NHL/NBA/MLB/NFL (`SPLIT_SPORTS`), and the
  trailing 14-day `book_move_log` window largely covers late October when the budget was exhausted
  and ingestion was dead (D68); (b) `PUBLIC_HEAVY = 60` filtered every row out
  (`book-move/index.js:61,128`); (c) today's 17-game slate is NCAAF-dominated and so out of
  `SPLIT_SPORTS` entirely.

The dashboard therefore shows a `vs-pub` column whose header reads `vs-pub —` and whose every cell
is `—`, plus the `off` banner: `vs-public: UNAVAILABLE — 0 of <N> episodes carry a public split, so
the against-public component (weight 0.20) contributes nothing to any score on this page. This is
not 0%.` **Never render `0%` for a null `vs_public_pct`.**

**No new dependencies, modest hand-rolled graphics.** Exactly one SVG helper, `sigSpark(vals,w,h)` —
a single `<svg viewBox>` with one `<polyline>`, ~10 lines — used once, for cumulative odds spend vs
the linear-pace line. Everything else is a dense table or the existing inline bar pattern already at
index.html:6836. Two new CSS classes only.

**Mobile at 375px.** One column throughout. Wide tables live in `.sigtbl-wrap{overflow-x:auto;
-webkit-overflow-scrolling:touch}` so the table scrolls, not the page. Chip row reuses `.flt-row`/
`.flt` (index.html:165–168) with 4 chips, which fits 375px.

## Data model / API changes

Two small, additive backend changes, both needed because the data does not currently exist anywhere
a client can reach:

1. **`/plays` gains `sharp`.** `setIntel('sharp', …)` (`agents/sharp/index.js:54`) is written on
   every run and exposed by **no endpoint** — only as a per-game boolean in `/games`. Add
   `sharp: getIntel('sharp')` to the `/plays` object (`src/index.js:419–420`). ~44 items at peak
   (D27); negligible against 1.36MB. Item shape:
   `{sport, game_id, market, side, signal_type:'steam', strength, books[], detail, detected_at}`.

2. **`/budget` gains ceilings.** Blake asked for "per-sport allocation, ceilings"; `getOddsBudget()`
   publishes `bySport` but no ceiling, and `currentCeiling()` is module-private. Add to
   `agents/odds/index.js`:
   ```js
   export function getOddsCeilings() {
     const sports = Object.keys(oddsApi.allocation);
     const ceilings = {}; for (const s of sports) ceilings[s] = currentCeiling(s);
     return { pool: POOL, denom: lastDenom, allocation: { ...oddsApi.allocation }, ceilings };
   }
   ```
   and spread it into the `/budget` response (`src/index.js:458–459`):
   `{ ...getOddsBudget(), ...getOddsCeilings(), claude: await getClaudeUsage() }`.
   `denom: null` means nothing has published a denominator yet — render it as such (D65), not as "all
   sports".

No schema change. No new localStorage key. New in-memory state only: `state.sigView` (default
`'health'`), `state.sigSrc`, `state.agentsSharp`.

## File-by-file plan

### `index.html` (the only PWA file)

1. **~469, state init block** — add `sigView:'health', sigSrc:{}, agentsSharp:[],`.
2. **~165–168, CSS, beside `.flt-row`** — add `.sigtbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -2px}` and `.sigtbl{width:100%;min-width:430px;border-collapse:collapse;font-family:var(--M);font-size:10px}` plus `.sigtbl th{font-size:8px;color:var(--leather);text-align:right;font-weight:400;padding:3px 5px;white-space:nowrap}` / `.sigtbl td{padding:4px 5px;text-align:right;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.04)}` / `.sigtbl .l{text-align:left}`.
3. **3265, pagedots `_ord`** — append `'signal'`.
4. **3365–3373, `HOME_TABS`** — append `{id:'signal',icon:'📡',label:'Signal'}`. This alone supplies the launcher tile, the header title (3258) and the back chevron (3391).
5. **3400, `renderHomeScreen` dispatch** — add `else if(state.homeTab==='signal')renderSignalView();` before the final `else`.
6. **6002, `loadAgentsData`'s `onView`** — add `||state.homeTab==='signal'`.
7. **6003, `loadAgentsData`'s `rerender`** — add `if(state.homeTab==='signal')renderSignalContent(); else if(…)` — put the signal branch first so it wins.
8. **6028–6033, `loadAgentsData`'s `.then`** — before `applyAgentsBag(bag)`, write `state.sigSrc` from key presence: `['beHealth','bePlays','beFeed','beBudget','beDataHealth','beSplits'].forEach(...)` mapping to `{ok:!!bag[k], at:Date.now()}` under short names `health/plays/feed/budget/dataHealth/splits`. `state.sigSrc` is **not** persisted into `etBagCache` (a cached "ok" is a lie about the current refresh) — strip it, or simply never add it to `bag`.
9. **5975, `applyAgentsBag`** — add `state.agentsSharp=bag.bePlays.sharp||[];` to the existing `if(bag.bePlays){…}` line.
10. **New block, inserted at 6718 — immediately after `renderAgentsContent()`'s closing brace (6717) and before `agentPlayKey` (6719).** All of the following:
    - `renderSignalView()` — mirrors `renderAgentsView` (6038) exactly: `startAgentsPoll(); hydrateAgentsCache(); if(!state.agentsLastLoad&&!state.agentsLoading){…loadAgentsData()…} renderSignalContent();`
    - `renderSignalContent()` — header row (title + `updated <ago> · backend · refresh`, copied from 6140), the 4-chip `.flt-row` writing `state.sigView`, then one of the four panel renderers, then `$('sport-selector').innerHTML=h;`
    - `sigState(src, payload, countFn, bound)` → one of `'loading'|'failed'|'stale'|'nodata'|'ok'`, and `sigBanner(kind, opts)` → the banner HTML with the copy table above. **Every state string in the table must appear verbatim in `sigBanner`.**
    - `sigNum(v)` → `v==null||v!==v ? '—' : v` (never `0` for null; never coerce).
    - `sigSpark(vals,w,h)` → inline SVG polyline.
    - `renderSigHealth()` — agent roster from `state.agentsHealth`/`AGENTS_META` (5850) reusing `agentStatus` (5918) and `AGENT_STALE_MS` (5902), as a compact `running / stale / errored` count strip plus a `.sigtbl` of only the non-OK agents (an all-green roster is 3 lines, not 53); then `state.agentsSystem.degraded` as a list (`off`/`nodata` distinguished); then the `/data-health` table counts in a `.sigtbl-wrap` (reuse the `LBL` map from `renderDataHealth`, 6787, by hoisting it to a module-level `DH_LBL` const and referencing it from both — do not copy it); then the odds baseline hydration counters, parsed out of the `odds` agent's `lastResult` string for the `baseline <h>/<a>` and `stale-baseline` segments, with `off` copy `Baseline counters not in the run summary — this build predates the rehydration fix.` when the segment is absent.
    - `renderSigBudget()` — headline `used/budget (pct)` bar (reuse the inline bar pattern at 6836), `day N of M`, `paceRatio`, `discretionaryActive` as an explicit GOVERNOR OPEN / **GOVERNOR CLOSED (discretionary scanners paused)** line, then a `.sigtbl` of sport × `alloc` / `ceiling` / `spent` / `% of ceiling`, sorted by spent desc, with sports absent from `denom` flagged `not in denominator`. `sigSpark` renders cumulative `used` vs the linear-pace line. If `ceilings` is absent from the payload (old cached bag, or backend not yet deployed) show the `off` banner `Ceilings unavailable — this backend build does not publish them.` and render the table without those two columns.
    - `renderSigBooks()` — `state.agentsBookMoves` byBook as a `.sigtbl` in `.sigtbl-wrap`: book / role / n / led% / follow% / avg move / key-x / vs-pub, `small` rows at `opacity:.5` with a `small` tag; then the `vs_public` `off` banner described above, computed as `(bm.byBook||[]).every(function(b){return !b||!b.vs_public_n})`; then `live` episodes as cards (reuse the existing card markup at 6691–6697 — move it into a `sigEpisodeCard(m)` helper and call it from both places so the two cannot drift), showing `line_from→line_to`, `score`, `reasons`, `crossed_key`, `hours_to_start`, and `public_pct` as `no public data` when null. Footer: the ceiling note from `bm.note`.
    - `renderSigSteam()` — `state.agentsSharp` as a `.sigtbl` of sport / matchup-less game / market / side / strength / books.length / `detected_at`. When empty, choose between `nodata` and `off` by inspecting the `sharp` agent's `lastResult` in `state.agentsHealth`: if it matches `/no recent line movement/` render `off` with `Steam: NOT FIRING — the sharp agent reports "no recent line movement". It reads only the most recent odds run's in-memory array; expect this to stay empty until the history reader lands (docs/specs/sharp-history-reader.md).` Otherwise `nodata`.
11. **7804, swipe `order`** — append `'signal'`.
12. **`HANDOFF.md`** rewrite; **`DECISIONS.md`** append one entry (dashboard lands as a home tab; reuses the agents bag with zero new fetches; `sigSrc` added because a caught fetch error was silently preserving stale state; the five-state rule; `vs_public` recorded as unavailable with the three candidate causes).

### Backend

13. **`edge-tracker-agents/src/agents/odds/index.js`** — add exported `getOddsCeilings()` (above), next to `getOddsBudget()` (line 60).
14. **`edge-tracker-agents/src/index.js:419`** — add `sharp: getIntel('sharp'),` to `/plays`.
15. **`edge-tracker-agents/src/index.js:458`** — spread `getOddsCeilings()` into `/budget`.

### Tests

16. **`tools/smoke.mjs`** — new section `13. Signal dashboard`, guarded by `const hasSignal = /function\s+renderSignalContent\s*\(/.test(html)` + `skipAll([...], 'awaiting the signal dashboard')` in the `else`, following the §2 pattern. Assertions:
    - the **seven** registration sites, each its own assertion: `HOME_TABS has a signal tile`, `renderHomeScreen dispatches signal`, `renderSignalView is defined`, `pagedots _ord includes signal`, `swipe order includes signal`, **`loadAgentsData onView includes signal`** (`/onView\s*=[\s\S]{0,300}?homeTab===['"]signal['"]/`), **`loadAgentsData rerender includes signal`**.
    - `no second /plays fetch` — the signal block (`html.slice(indexOf('function renderSignalContent'), indexOf('function agentPlayKey'))`) must contain **no** `fetch(` at all.
    - `every empty state has distinct copy` — all five of `Loading —`, `Feed answered.`, `older than`, `NOT FIRING`, `Read failed —` appear in the block.
    - `vs_public is never rendered as 0%` — the block contains `vs_public_n` and `vs_public_pct!=null`, and does **not** match `/vs_public_pct\s*\|\|\s*0/`.
    - `per-source status is recorded` — `/state\.sigSrc/` appears in `loadAgentsData` and `sigSrc` is not written into `etBagCache`.
    - `backward compatible field access` — the block never matches `/state\.agents\w+\.(length|forEach|map|slice)\b/` (every read must go through `(x||[])`).
    - `wide tables scroll in their own container` — `.sigtbl-wrap` is both defined in CSS with `overflow-x:auto` and used in the block.
    - `no charting dependency` — the block's only SVG is in `sigSpark`, and `<script src=` assertion (§6) still holds.
    - `the episode card is not duplicated` — `function sigEpisodeCard` exists and `renderAgentsContent`'s book-movement block calls it.
    - backend: `/plays serves sharp` (`/sharp:\s*getIntel\('sharp'\)/` on `server`), `/budget publishes ceilings` (`getOddsCeilings` in `server` and `export function getOddsCeilings` in `oddsSrc`).
    - §1 already catches any syntax error in the new inline JS — lean on it, add nothing.
17. **`edge-tracker-agents/test/odds-ceilings-payload.test.js`** (new, `node:test`, no new harness, no new deps) — `getOddsCeilings()` returns one key per `allocation` sport; every ceiling is a finite non-negative integer; `denom` is `null` before any publish and the published array after; the sum of ceilings over the full allocation table does not exceed `monthlyBudget` (D61's crossover is the live hazard here). Mutation-check per D21: replace `currentCeiling` with `sportCap` and at least one case must fail.

## Risks & open questions

1. **Blake must decide whether to chase `vs_public` now or later.** The discriminating observable is already in reach and costs one request: `GET /data-health` → the `public_splits` row's `today`. If `today === 0` the cause is upstream (the splits agent produced nothing) and the join is innocent; if `today > 0` the cause is the join or the `PUBLIC_HEAVY`/`SPLIT_SPORTS` filters. A second, free check: in `/plays.bookMoves.live[]`, is `public_pct` null on all 40 items? If yes, `publicIndex()` returned an empty map and there was never a right-hand side. **This spec only surfaces the gap; it fixes nothing.**
2. **`/budget` ceilings require a backend deploy.** Until it ships, the Budget panel's ceiling columns render the `off` banner. That is by design, but it means the panel is partially blank on first merge.
3. **The Steam panel will render empty.** That is the honest answer and the reason the `off` copy names the shelved spec. Do not pad it.
4. **`/data-health` stays inside the shared `Promise.all`.** If it regresses to 36s, every tab's live refresh slows with it. Out of scope; flagged.
5. **`sigSrc` reports the *last refresh*, not per-field freshness.** A source that failed three refreshes ago and has not been retried will read `ok`. Acceptable: `startAgentsPoll` refreshes on a cadence, so the window is bounded.
6. **Not specified because the data cannot support it:** per-book public splits (`public_splits` has no `book` column, D53/D57); any claim that a leading book is "where sharps bet" (no originating book in our 11 retail books); open→close movement for anything but NFL (`line-move-all-sports.md`); and any aggregate over `line_movements` straddling the baseline fix — D73 says `gap_min is null` rows are not a denominator, so this dashboard never aggregates them.

## Test plan

**Automated.** `node tools/smoke.mjs` → previous 106 assertions still pass, plus the ~17 new ones, 0
failed, 0 skipped. `cd edge-tracker-agents && npm test` → 111 + new cases, with the same 3
pre-existing environmental `degradation-channel` failures and no others. Verify the new smoke
assertions actually bite: delete the `onView` edit and `loadAgentsData onView includes signal` must
fail; replace one `(x||[])` with a bare dereference and `backward compatible field access` must fail;
render `vs_public_pct||0` and that assertion must fail.

**Manual check recipe.**

1. `lsof -nP -iTCP -sTCP:LISTEN` — read the actual listeners first. A Pool Room Pro Electron process
   holds 4317–4318 and Vantyx holds 3000. *Proves:* which ports are unavailable, nothing else.
2. `npx serve .` and **read the port it prints** — it silently falls back to a random port. Open that
   URL in Chrome with DevTools → Network → **Disable cache** checked, and hard-reload. *Proves:* the
   page parses and runs from this working tree, not from the service worker's cached copy. It does
   **not** prove anything about the stale-cache path (step 6).
3. Launcher shows a **📡 Signal** tile; tap it. Header reads "Signal", back chevron appears, page dots
   show 8. Swipe left/right — Signal sits last. *Proves:* all five of the display registration sites
   agree. It does **not** prove the data wiring (step 4).
4. In DevTools Network, filter `plays`. Tap through all four chips, then go to the **Agents** tab and
   back to Signal. *Proves:* exactly **one** `/plays` request for the whole session — the no-second-
   download requirement. Then confirm each panel shows real numbers, not `—` everywhere.
5. Set the throttle to **Offline**, tap `refresh` in the panel header, and watch. *Proves:* `failed`
   banners appear naming the source and the age of the last good copy, and the previous numbers stay
   on screen under the banner rather than vanishing or silently re-reading as current. Go back Online
   and refresh — the banners clear. **This is the step that tests the central requirement.**
6. Stale-cache check — this app's characteristic failure. With Disable-cache **off**, Application →
   Service Workers → Unregister, then Application → Storage → clear only Cache Storage (leave
   Local Storage alone so `etBagCache` survives), then reload. *Proves:* new code paints an **old**
   bag without throwing — the `etBagCache` backward-compatibility path — and that the Budget panel
   falls back to the `off` ceiling banner instead of rendering `undefined`.
7. On the phone, in the real PWA, at 375px: every table scrolls horizontally **inside its card** and
   the page itself never scrolls sideways. Confirm the Books panel shows `vs-pub —` in every row and
   the `vs-public: UNAVAILABLE` banner, and the Steam panel shows `NOT FIRING`, not a bare "none".
   *Proves:* the two known-dishonest states read as honest.

**Reviewer checks:** no new localStorage keys; no `fetch(` in the new block; no `<script src=`; every
`state.agents*` read defaulted; `DH_LBL` and `sigEpisodeCard` referenced from both call sites rather
than copied; diff outside the 15 named anchors is empty.

## Follow-up phases

**1. `sharp` history reader** (`docs/specs/sharp-history-reader.md`, shelved). The Steam panel this
spec ships will render empty because `sharp` reads only the most recent odds run's in-memory array.
Pointing it at a bounded `line_movements` read — checking `gap_min` itself rather than trusting
`odds` to pre-filter — is what fills the panel, and the panel is now the instrument that will show
whether it worked.

**2. Open→close movement for all 12 sports** (`docs/specs/line-move-all-sports.md`, shelved, store
shape and renames already decided). Today open→close is NFL-only despite `opening_lines` being
written sport-agnostically, so the Books panel can only ever describe intraday episodes. That
generalization would add a genuine open-to-close column per sport.

**3. Fix the `vs_public` join.** Risk 1's two observables will say whether the cause is an empty
`public_splits`, the `PUBLIC_HEAVY`/`SPLIT_SPORTS` filters, or the missing `h2h` entry in
`SPLIT_MARKET`. Until one of them is fixed, the 0.20-weight against-public component contributes
nothing to any book-move score, and the dashboard will keep saying so out loud.
