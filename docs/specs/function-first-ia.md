# Function-first IA — Phase 1: consolidated Games view

Status: proposed · 2026-10-14 · target branch `feat/function-first-games`

## Open questions (decide before build)

1. **7th launcher tile vs. replacing one.** The launcher is a 2-column grid (`.launch-grid`, line 59). Adding a 7th tile leaves a ragged final row. Recommendation: **add** (additive = cleanly revertible, constraint 1). Alternative one-liner: replace the existing `dash`/"Sports" tile, since in Phase 2+ the sport launcher becomes redundant anyway. Blake picks.
2. **Does the sport filter share `state.sport`?** Recommendation: **yes** — the chip row reads/writes `state.sport` and `et_sport`, so no new nav state exists and the selection carries into the old per-sport module. Cost: changing the Games filter also changes which sport the old launcher deep-links into. Alternative is a separate `state.gamesSport`, which duplicates the concept. Flagging because it is the one place the two axes are deliberately coupled.
3. **Out-of-season sports in the chip row.** NCAAB/WNBA/Boxing will return empty slates most of the year. Recommendation: always show all 10 chips and let the existing empty-state (`d.note`) explain. Alternative: hide chips whose last fetch was empty — more magic, more state.
4. **Phase ordering after this.** See §Follow-up phases; sequence is a judgment call, not a derivation.

## Problem

Navigation has two competing axes — a 6-tile home launcher (`HOME_TABS`, line 3361) and 12 per-sport modules each declaring their own 1–4 tabs (`SPORTS`, line 368) — and both expose the same ~6 concepts. Because sport is a navigation level rather than a filter, the same ideas are reimplemented per sport across 94 `render*` functions (Stats 5×, Log 4×, Dash 4×, Hist 3×). This change lands the first function-first view so the model can be judged on a phone before anything is removed.

Note on the brief: the live `HOME_TABS` labels are `Sports · Plays · Stats · My Stats · Log · Agents` (not Dashboard/Results/My Stats/Log/Agents/Menu), and `homeTab==='dash'` renders a **sport picker** (`renderHomeDash`, 3398), not a dashboard. Diagnosis otherwise confirmed.

## Approach

**Consolidate `games` first.** Why it is the lowest-risk, highest-signal start:

- **Highest coverage.** 10 of 12 sports declare a `games` tab (all but UFC and Golf). Consolidating it collapses the most navigation depth per line changed.
- **Already single-implementation.** `renderGamesBoard` (7463) and `renderGamesHTML` (7492) are sport-parameterized off `state.sport` and one endpoint (`GET /games?sport=`). The consolidated view is a *navigation wrapper over existing renderers* — not a merge of divergent renderers. No display logic is rewritten.
- **Read-only.** Nothing in this path writes bet arrays or mutates model state, so a defect cannot corrupt data.
- **Highest traffic.** The code comment at 4115 already calls the games board "the new sport landing" — it is where Blake will actually feel function-first.
- **Zero new CSS and zero new dependencies.** It reuses `.flt-row`/`.flt` (165–168) and `.launch-btn` (60–64).

Rejected alternatives:

- **Stats first** — 5 implementations over different bet shapes; that is a data merge, not a wrapper, and `homeTab==='stats'` (`renderHomeStats`, 3667) already gives a cross-sport Stats, so the marginal signal is low.
- **Log first** — writes 9 separate localStorage arrays through per-sport forms; a defect loses logged bets. Worst risk profile in the file.
- **Dashboard first** — the 4 dashboards are entangled with single-slot global model state (`state.modelResults`, `state.propModelResults`, `state.slateData`), set per sport by `setSport` (2296–2308). A cross-sport dashboard needs that state keyed by sport first — a refactor out of scope here.

**Navigation model.** New home section `games`, reached from the launcher (and by swipe, appended last). Inside it: a `.flt-row` chip row of the 10 games-capable sports, where the active chip is `state.sport`; below it, the existing board HTML for that sport. One fetch per sport, cached in memory so chip-switching is instant; a `↻ Refresh` chip drops the cache entry and refetches.

**Asymmetries, handled explicitly.** UFC and Golf have no `games` tab and are *not* in the chip row. Instead a persistent muted footer under the board reads `Not on the slate board:` followed by two buttons that call the existing `setSport('ufc')` / `setSport('golf')`, which leave the home screen and open the old module at its first tab. NCAAF/NCAAB/WNBA/Boxing are games-only sports — they appear as chips like any other and are, for them, fully served by this view. The chip set is derived at render time from `SPORTS.filter(s => s.active && s.tabs.some(t => t.id==='games'))`, so it tracks `SPORTS` automatically and needs no second list.

**Coexistence.** The old launcher, the old sport selector, the old per-sport `games` tab, and `renderGamesBoard` are all left in place and reachable. No state is duplicated: the section reuses `state.homeTab` (in-memory, non-persisted — a reload still lands on the launcher, exactly as today) and `state.sport`/`et_sport`. `et_tab` is not written by this view. No new localStorage key is introduced, so nothing can desync for an existing user.

## Data model / API changes

None. No backend, Supabase, or Railway change. Existing endpoint only: `GET {state.agentApiUrl}/games?sport=<UPPER>` → `{games:[…], note?, kind?}` (already defaults to the Railway base, line 465, so there is no setup step).

New in-memory state only (no persistence):

```
gamesCache: {},        // { NFL: <payload>, NBA: <payload>, … }
gamesLoading: false,
gamesErr: ''
```

`renderGamesHTML(d)` gains an optional second parameter: `renderGamesHTML(d, spOverride)`. Line 7493 becomes `var sp=(spOverride||state.sport).toUpperCase();`. Existing callers pass one argument and are unaffected.

## File-by-file plan

Only `index.html` changes. Plain JS, string-concat renderers, `$()` helper, no reformatting of surrounding code. Edits in order:

1. **~line 459 (state init)** — after `homeTab: 'menu',` add the three `games*` fields above.
2. **~line 3261 (`render()` pagedots `_ord`)** — append `'games'` to the array so the dots count matches the sections.
3. **~line 3367 (`HOME_TABS`)** — append `{id:'games',icon:'📅',label:'Games'}`. This alone gives the tile, the header title (3254 looks the title up from `HOME_TABS`) and the back button (3387 `inSection`) for free.
4. **~line 3394 (`renderHomeScreen` dispatch)** — add `else if(state.homeTab==='games')renderHomeGames();` before the final `else`.
5. **New function, inserted immediately after `renderHomeDash` (ends 3422)** — `renderHomeGames()`:
   - compute `avail` = games-capable active sports; if `state.sport` is not in `avail`, use `avail[0]` for display without writing state;
   - build `h` = `.flt-row` of chips (`<button class="flt on|">` + `s.icon+' '+s.label`, `onclick="setGamesSport('<id>')"`), plus a trailing `<button class="flt" onclick="refreshHomeGames()">↻</button>`;
   - if a cached payload exists for the active sport, append `renderGamesHTML(cached, sportId)`; else append the existing `LOADING … SLATE…` placeholder markup copied from 7466 and kick off the fetch;
   - append the UFC/Golf footer buttons;
   - `$('sport-selector').innerHTML=h;`
6. **Same block** — `setGamesSport(id)`: `state.sport=id; save('et_sport',id); render();` (deliberately *not* `setSport`, which would set `homeScreen=false` and wipe slate/model state). `refreshHomeGames()`: delete the cache entry for the active sport and `render()`. `fetchHomeGames(sportId)`: mirrors 7467–7470 — fetch, then guard `if(!state.homeScreen||state.homeTab!=='games')return;` before writing `state.gamesCache[KEY]` and calling `render()`; on error set `state.gamesErr` and `render()`. Expose on `window` only if an inline `onclick` needs it, matching the `window.goMenu=goMenu` idiom at 3370.
7. **~line 7493 (`renderGamesHTML`)** — add the optional `spOverride` param as described.
8. **~line 7684 (swipe `order`)** — append `'games'` so the new section is swipe-reachable in the same left/right model.
9. **`HANDOFF.md`** — rewrite per CLAUDE.md with state + next steps. **`DECISIONS.md`** — append a dated entry: function-first IA adopted, Games chosen first, additive-not-replacing, and the resolution of open questions 1–3.

Non-goals, to be explicit: no edits to `renderGamesBoard`, `renderSportSelector`, `renderTabs`, `renderModule`, `renderHomeDash`, or any per-sport renderer; no deletions; no `SPORTS` changes.

## Risks & open questions

- **Launcher grid parity** — open question 1.
- **Shared `state.sport`** — open question 2; the only intentional coupling between the two axes.
- **Fetch fan-out** — the view fetches one sport at a time, on demand. Do **not** prefetch all 10; that would multiply backend/odds-budget load (HANDOFF.md: the odds budget is the binding constraint).
- **Cache staleness** — in-memory cache lives until reload or `↻`. Acceptable for a judged prototype; a TTL is a Phase-2 concern.
- **Tennis payload** — `renderGamesHTML` forks to `renderTennisHTML` on `d.kind==='tennis'`, which ignores `sp`. Verify the Tennis chip renders correctly; it should need no change.
- **Backend-unset case** — if `state.agentApiUrl` is empty the old board shows a "set the backend URL" card. Reproduce that card in the new view rather than failing silently.
- **Data integrity** (clv all-suspect, grading 0, null `line_snapshots`) is explicitly out of scope and tracked separately.

## Test plan

No test suite exists in this repo; this phase is judged by eye.

**Phone check recipe (Blake, ~3 min).** Serve with `npx serve .`, open on the phone:
1. Launcher shows a 7th **📅 Games** tile. Tap it. Header reads "Games", back chevron appears, page dots show 7.
2. Chip row shows exactly 10 sports: NFL, NCAAF, NBA, NCAAB, WNBA, MLB, NHL, Boxing, Soccer, Tennis. No UFC, no Golf.
3. Tap through 4+ chips including **Tennis** and one out-of-season sport. Each loads once, shows either a board or the "No games right now" note; returning to a previously-viewed chip is instant.
4. Tap `↻` — board reloads.
5. Footer: tap **Golf** → old Golf module opens on its Week tab. Press back/`‹` to the launcher.
6. Regression: old path still works — launcher → **Sports** → NBA → **Games** tab renders as before.
7. Regression: force-reload the PWA. It lands on the launcher (not Games), and the sport you last picked is still selected when you enter a sport module.
8. Swipe left/right across home sections; Games sits last in the sequence.

**Reviewer checks:** no new localStorage keys; `et_tab` never written by the new code; no `setSport` call from the chip row; no edits outside the 8 anchors; no new CSS classes; no new dependencies; file-wide diff is additive except the two array appends and the one `renderGamesHTML` signature line.

**Revert.** Single squashed commit on `feat/function-first-games`, PR to `origin/main`. If Blake dislikes it: `git revert <sha>` — or, before merge, just close the PR. Nothing else in the app depends on the new code, so revert cannot orphan state.

**Optional, clearly separable recommendation.** Bootstrap a 20-line `tools/smoke.mjs` (node:test, no deps) that reads `index.html`, extracts the main `<script>` body, and `new Function(src)` on it to catch syntax errors — the one class of defect that silently blanks this entire app. Worth doing as its own PR, not bundled here.

## Follow-up phases (sketch only — do not build now)

- **P2** Consolidated Log: a sport chip row over the 8 existing log forms, keeping each form intact; then retire `renderHomeLog`.
- **P3** Key `modelResults`/`slateData` by sport, then consolidate the 4 dashboards.
- **P4** Consolidate Stats on top of `getAllBets()`; retire the 5 per-sport Stats renderers.
- **P5** Only once P2–P4 are judged good: remove the sport-first axis — `renderSportSelector`, `renderTabs`, the per-sport `tabs` arrays, and the `mod-<sport>` containers.
