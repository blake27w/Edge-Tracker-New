# Edge Tracker — Session Handoff

Last updated: 2026-11-05 — **Signal dashboard built on `feat/signal-dashboard`: a 📡 Signal home tab
in the PWA with Health / Budget / Books / Steam panels, plus the two backend fields the data needed.
Not yet committed by the builder; not yet seen on a phone.**

## Current state

Branch `feat/signal-dashboard`, based on `427eada`. Dependencies are installed, so the real baseline
is **zero failures** — see D82; there is no "3 expected failures" allowance any more.

**What this branch does.** Four things the system already knew — agent/data health, odds spend, book
reputation, steam — each lived in a different corner of a 580-line `renderAgentsContent()` or in no
renderer at all, with no single screen. It is now a home tab (`signal`), four panels behind a chip
row, only the active one in the DOM.

- **Zero new network traffic.** Every number comes from the one-shot bag `loadAgentsData()` already
  fetches for the Agents tab. There is no `fetch(` in the new block and smoke asserts it: a second
  `/plays` read is another 1.36MB per tab switch. A cold open paints from `etBagCache` first.
- **Five honest empty states**, one shared `sigBanner`: `loading` / `nodata` / `stale` / `off` /
  `failed`, each with its own words. `stale` and `failed` are banners **over** the data, never
  instead of it.
- **A real bug fixed to make that possible.** Every backend fetch ends `.catch(() => ({}))` and
  `applyAgentsBag` guards each assignment with `if (bag.X)`, so **a failed read silently preserved
  the stale value and was indistinguishable from a success.** `state.sigSrc` now records per-source
  outcome from key presence in `bag`, written *before* `applyAgentsBag` consumes it, and is
  deliberately **not** persisted into `etBagCache` (a cached `ok:true` is a claim about a refresh
  that has not happened). See D83.
- **Backend, two additive fields.** `/plays` gains `sharp: getIntel('sharp')` — written on every run
  and previously exposed by no endpoint. `/budget` spreads a new exported `getOddsCeilings()`, so the
  per-sport ceiling behind "3 budget-skips" is reachable for the first time.

## Verified vs unverified

- **Verified:** `node tools/smoke.mjs` → **161 passed, 0 failed, 0 skipped** (was 134).
  `npm test` from `edge-tracker-agents/` → **156 tests, 156 pass, 0 fail** (was 148).
  Every new assertion mutation-tested, including all seven tab-registration sites, the `sigSrc`
  ordering, `vs_public_pct || 0`, a bare `state.agents*` dereference, a duplicated episode card, a
  `fetch(` in the block, and `currentCeiling` → `sportCap` in the backend test.
  All four panels and all five states were rendered in a Node/vm DOM shim against **today's live
  payloads** — including the old-cached-bag path, a cold open, and an all-sources-failed refresh.
- **Unverified:** **nobody has opened this on a phone.** The vm shim is not a browser: nothing about
  touch, the swipe handler, the real service-worker cache path, or whether the tables actually scroll
  inside their cards at 375px has been seen. Run the manual recipe in
  `docs/specs/signal-dashboard.md` — **step 5 (throttle Offline, tap refresh) is the one that tests
  the central requirement**, and step 6 is the stale-cache path.

## What each panel shows against today's live data

| panel | state | why |
|---|---|---|
| Health | **ok** | 47 running / 3 stale / 0 errored; 45 tables, 22 wrote nothing today; one degraded condition (`clv\|unmeasurable`); baseline counters present and all zero |
| Budget | **ok**, with `off` on the ceiling columns | 6548/20000, pace **1.96×**, governor OPEN. The ceiling columns show `Ceilings unavailable — this backend build does not publish them.` until the backend deploys — by design (spec Risk 2). Claude usage is `nodata` with the model reading **not detected** |
| Books | **ok**, with the `vs_public` `off` banner | 10 books, 1013 episodes, 40 live. `vs-pub` header reads `vs-pub —`, every cell is `—`, and the banner says `0 of 1013 episodes carry a public split … This is not 0%.` |
| Steam | **off** | `Steam: NOT FIRING — the sharp agent reports "no recent line movement"` and names the shelved spec. Expected and correct; do not pad it |

## OWED NOW — deploy the backend

The Budget panel's ceiling columns and the Steam panel's data source both exist only after
`edge-tracker-agents/` redeploys. Nothing breaks before that: both fall back to a labelled `off`
banner. Nothing to hand-run — no DDL, no schema change, no new localStorage key.

## Open items for Blake

1. **Chase `vs_public` now or later?** `/data-health` confirms **`public_splits: 0 today`**, so the
   cause is upstream — the splits agent produced nothing (it is Claude-web-search sourced and
   `ANTHROPIC_API_KEY` is unset in production, which the Budget panel now also says out loud). The
   join is innocent and the `PUBLIC_HEAVY`/`SPLIT_SPORTS` filters are not the story. The missing
   `h2h` entry in `SPLIT_MARKET` (`book-move/index.js:95`) is still a real, separate contributor:
   `againstPublic` returns `null` for every moneyline episode by construction. Until one is fixed the
   0.20-weight against-public component contributes nothing to any score, and the dashboard says so.
2. **The Steam panel is the instrument for the shelved `sharp` history reader.** It will stay empty
   until that lands, and will show whether it worked the moment it does.
3. **1 November budget reset — now readable.** Pace is **1.96×** and projected **39288 against a
   20000 budget**, which the panel flags with ⚠. NBA (1910), NFL (1233), NCAAB (1203) and NHL (1151)
   lead; MLB has spent 1. This is the open item from the last two handoffs and the Budget panel is
   the answer to it — worth reading before the next allocation change.
4. **`book_move_log` is still not in the watchdog's schema probes** — one line, and those probes
   exist to catch exactly the failure this repo keeps having.
5. **Watchdog alerts still reach zero recipients** (`notifyAll` needs `ALERT_NUMBERS` or `SMTP_*`).
   Deprioritised 2026-10-28; every "make it loud" path still terminates here.
6. **`docs/specs/web-app-revival.md` is abandoned.** It proposed a separate Next.js app; Blake chose
   the PWA. Delete it or mark it rejected so a future session does not build it.

## OWED NOW — Railway env (both are Blake's, neither is code)

```
ANTHROPIC_API_KEY=<your key>          # revives public-splits + combat-weighin; REQUIRES A RESTART
ODDS_ALLOC_NFL=0.26   ODDS_ALLOC_NCAAF=0.13   ODDS_ALLOC_MLB=0.02
ODDS_ALLOC_NBA=0.22   ODDS_ALLOC_NCAAB=0.14   ODDS_ALLOC_NHL=0.14
```

The key needs a **restart** — the Anthropic client is built once at module load and `detectModel()`
runs once at boot and is never retried. The allocation shares do **not**: `capOf()` reads them per
call. See D81, D86.

## Next steps

1. **Run the manual check recipe** in `docs/specs/signal-dashboard.md`. Steps 5 and 6 are the ones
   that matter. Start with `lsof -nP -iTCP -sTCP:LISTEN` and read the port `npx serve` actually
   prints — it silently falls back to a random one.
2. **Merge, then deploy `edge-tracker-agents/`** and confirm the ceiling columns and `off` banner
   swap over.
3. **Phase: point `sharp` at a history reader** (`docs/specs/sharp-history-reader.md`, shelved) —
   why `sharp` has reported "no recent line movement" across 13,000+ runs. The Steam panel is now
   the instrument that will show it working.
4. **Phase: generalize open→close movement to all 12 sports** (`docs/specs/line-move-all-sports.md`,
   shelved; store shape and renames already decided). Today the Books panel can only describe
   intraday episodes.
5. **Fix the `vs_public` join** (open item 1) — now a known upstream cause plus one known code bug.

## House rule earned this session

**A caught fetch error that leaves the previous value in place is not error handling; it is a lie
with a `try` around it.** `.catch(() => ({}))` plus `if (bag.X)` had been shipping "the data is
fine" on every failed read in this app, and nothing in the UI could have told anyone. Any loader
that swallows an error must record that it swallowed one, in state the renderer can see — and that
record must never be cached, because it describes a refresh, not a payload.
