# Web App Revival — Next.js UI in `web/`, reading the agents API

Status: proposed · 2026-11-05 · spec only (no code in this branch)

## Problem

The signal dashboard designed in `docs/specs/signal-dashboard.md` has nowhere good to live: hand-rolling
four more panels into a 7,800-line `index.html` is the wrong substrate for tables, charts and honest
empty states. Blake has decided to revive the old Next.js build as the real UI and point it at the
Railway agents API instead of Postgres. This spec lands that as a small, deployable, verifiable first
slice that cannot break the PWA he uses on his phone today.

## Approach

### Which old tree (correction to the brief)

The brief describes `~/edge-tracker` — Next 14 App Router, `pg`, `twilio`, five pages. That tree exists,
but **there is a second, newer tree the brief did not mention: `~/edge-tracker/edge-tracker-v2`**, and it
is strictly better as a starting point. Verified from `~/edge-tracker/edge-tracker-v2/package.json`:

- `next 16.2.4`, `react`/`react-dom` `19.2.4`, `tailwindcss ^4` + `@tailwindcss/postcss`, `zod ^4`.
- App Router with route groups: `app/(app)/{dashboard,today,log,report,settings}`, `app/(auth)/login`,
  `app/api/**` route handlers, `lib/{db,api,types,pnl,odds,weather,signals,notify,appUrl}.ts`.
- `app/(app)/dashboard/page.tsx` is a server component that already does the thing this spec needs —
  `Promise.all` of two reads, each returning `{ok:true,data}|{ok:false,error}`, with a visible banner on
  failure. That discriminated-result shape is the antidote to the `applyAgentsBag` bug and is carried over.

So **decision 2 (Next version) answers itself: no upgrade, no port-then-upgrade.** We pin exactly
`next@16.2.4` / `react@19.2.4` — what v2 already builds on. Next 16 defaults (Node 24 runtime, Fluid
Compute, Edge deprecated) all suit us: every page is a `force-dynamic` server component making one
outbound HTTPS fetch. Nothing in phase 1 needs Edge, middleware, or streaming.

The Next-14 root tree at `~/edge-tracker` contributes **nothing**. Its value was `pg` queries against
`games`/`bets`/`signal_performance` and its own MLB/NHL/Anthropic fetchers; the schema is gone and the
agents service already owns every one of those fetches under budget governance. `components/ui.tsx` is
97 lines of generic Tailwind primitives (`Card`, `Pill`, `Button`, `Input`) that v2 itself abandoned in
favour of inline classes. `BetCard.tsx`/`GameCard.tsx` render columns from tables that do not exist.
**Abandon all of it.**

### Where the code lives

**`web/` in this repo.** Not its own repo: `HANDOFF.md`, `docs/DECISIONS.md`, `docs/specs/`, `.claude/agents/`
and the `/kickoff`→`/wrap` ritual all live here, and a second repo forks the session-continuity contract
that is the only reason this project stays coherent. Not `app/` at the root — that name collides with
Next's own convention and would make the root ambiguous to Vercel's framework detection.

`web/` is a standalone npm project (its own `package.json`, its own `node_modules`). **No npm workspaces** —
the root has no `package.json` today and adding one changes what Vercel's root project sees.

Copying is **read-only, file-by-file, by name**. `CLAUDE.md` forbids editing `~/edge-tracker/`; nothing is
written there. **Never `cp -r`.** Explicitly not copied: `.next/`, `node_modules/`, `.env`, `.env.local`,
`.env.*`, `public/*.svg` (next-logo cruft), `app/favicon.ico`. **No credential file of any kind is copied,
and no credential value is read, printed, or transcribed into this repo.** `web/.env.example` is written
from scratch with empty values.

### Data path

All reads are **server-side, in React Server Components**, through one module `web/lib/agents.ts`. No client
fetching, no route handlers in phase 1, no `NEXT_PUBLIC_` base URL. Consequences worth naming: the browser
never talks to Railway, so CORS is irrelevant and there is no CSP barrier (unlike a published Artifact —
that constraint, which forced `signal-dashboard.md` into `index.html`, does not apply here); and the
Railway base URL is not shipped to the client.

Rejected: route handlers that the pages then fetch over HTTP. v2 does this via `lib/appUrl.ts`
(`NEXT_PUBLIC_APP_URL` or `http://localhost:3000`) and it is an antipattern — a self-request per render,
plus a hardcoded port 3000 default that is **already occupied on this machine by Vantyx**. `lib/appUrl.ts`
is not copied.

**The 1.36MB `/plays` problem.** `getPlays()` uses `fetch(url, { next: { revalidate: 30 } })`. Next's Data
Cache both dedupes identical fetches *within* one render (so N panels on a page download it once) and
serves it from cache *across* requests for 30s. That is the whole caching story; no bespoke memo, no
`unstable_cache`, no `no-store`. `/health` and `/data-health` get `revalidate: 15` and `revalidate: 60`
respectively (`/data-health` is ~887ms and its counts are daily-grain).

Every accessor returns `AgentsResult<T> = {ok:true, data:T, at:number} | {ok:false, error:string, at:number}`.
A non-2xx, a timeout (8s `AbortSignal.timeout`), or a JSON parse failure yields `ok:false` with a reason.
**Nothing is ever caught to `{}`.** Note `/data-health` returns **207** when `degraded` is true — that is a
success with partial data, not a failure, and `res.ok` is false for it. The client must treat 200 and 207
as `ok:true` and surface `degraded` separately. This is the single easiest bug to ship here.

### Phase 1 scope — deliberately one page

1. `web/` scaffolds, typechecks, lints, builds.
2. One route, `/`, rendering **the Health panel only** — panel #1 of `signal-dashboard.md`, carried over, not
   redesigned: agent roster counts (running/stale/errored), the non-OK agents as a table, `system.degraded`,
   the `/data-health` table counts, and the odds `baseline <hydrated>/<attempted>` + `stale-baseline` segments
   parsed from the `odds` agent's `lastResult`.
3. Health is the chosen panel because it is the only one that needs **zero backend change**. Verified in
   `edge-tracker-agents/src/index.js:418-420,458-459`: `/plays` still has no `sharp` key and `/budget` still
   has no ceilings, so Budget, Books (`vs_public` unavailable) and Steam (`sharp` not firing) would all land
   mostly-blank. Health reads `/health` and `/data-health`, which are live and complete today.
4. One `/plays` read on the same page, used for exactly one line ("slate: N games, book-moves updated <ago>"
   from `plays.bookMoves.games`/`.updated`). Its purpose is to prove the 1.36MB server fetch and the 30s
   revalidate work inside a Vercel function before three panels depend on it.
5. The five honest-empty-state kinds from `signal-dashboard.md` (`loading`/`nodata`/`stale`/`off`/`failed`),
   **verbatim copy text**, as one `<SourceBanner>` component. `stale` and `failed` are banners *over* the data.
6. Deploy green as a **second Vercel project**.

**Not in phase 1:** the Budget, Books and Steam panels; the two backend additions (`getOddsCeilings`,
`/plays.sharp`); `today`/`log`/`report`/`settings`; any auth or login page; any write path, bet entry, or
localStorage; Twilio; `pg`; charts or any new dependency; service worker or PWA manifest for the Next app;
any change to `index.html`, `tools/smoke.mjs`, `edge-tracker-agents/`, or `vercel.json`.

### Deployment — the landmine

Current state, verified: root `vercel.json` has `"framework": null`, `cleanUrls`, and three header rules for
`sw.js`/`index.html`/`manifest.webmanifest`. `.vercelignore` excludes `edge-tracker-agents`, `ios-app`,
`.github`, `README.md`. The root project serves the static PWA from the repo root.

**The answer is: a second Vercel project, and `vercel.json` is not touched.** Not one byte.

- New Vercel project on the same GitHub repo, **Root Directory = `web`**, framework preset Next.js,
  "Include source files outside of the Root Directory" **off**. It gets its own domain
  (`<project>.vercel.app`); no custom domain in phase 1.
- `web/` may later carry its own `web/vercel.json`. Phase 1 needs none.
- One root-level change only: **add `web` to `.vercelignore`** (one line), so the PWA project never uploads
  the Next source. The root project's `framework: null` already prevents detection, so this is belt-and-braces.
- Set `AGENTS_API_BASE` in the new project's env (Production + Preview). It is not a secret — it is the same
  URL already hardcoded at `index.html:12` and `:469` — and `web/lib/agents.ts` defaults to it when unset, so
  a clone works with no setup, exactly as the PWA does.

Rejected: monorepo config in root `vercel.json` (`builds`, or `rewrites` routing `/signal/*` into a Next
build) — that changes the deployment shape of the site Blake uses, which is precisely the failure mode to
avoid; and a rewrite-proxy from the PWA domain to the new app, which adds a hop and a second failure domain
before the thing being proxied to exists.

**Rollback.** The PWA project's config, root directory and `vercel.json` are unchanged, so a failed `web/`
build *cannot* affect the live site — the worst case is a second project that is red while the first stays
green. Rollback is: delete the new Vercel project (or promote its last good deployment), then
`git revert` the one-line `.vercelignore` commit. No PWA redeploy is required or involved.

### The PWA

**It coexists, unchanged, and remains the production UI through phase 1.** `index.html`, `sw.js`,
`manifest.webmanifest` and the root `vercel.json` are not edited. The Next app is a second, additional URL
that Blake can open on his phone alongside it. No decision about replacing or freezing the PWA is made here
and none should be made until the Next app has reached panel parity — see the kill criterion in Risks.

## Data model / API changes

**None.** No schema change, no new endpoint, no change to `edge-tracker-agents/`. Phase 1 is a pure consumer
of `/health`, `/data-health` and `/plays` as they exist today.

Types in `web/lib/types.ts`, hand-written from the live payloads (all fields optional, every array read
through `?? []`):

```ts
type AgentsResult<T> = { ok: true; data: T; at: number } | { ok: false; error: string; at: number };

type Health = { ok?: boolean; time?: string; model?: string;
  agents?: Record<string, { lastRun?: string; lastResult?: string; error?: string; runs?: number }>;
  system?: { degraded?: string[]; dbConnected?: boolean } };

type DataHealth = { tables?: { table: string; today: number | null; total: number | null;
  total_mode?: string }[]; errorsToday?: number; queryErrors?: number; degraded?: boolean;
  dbConnected?: boolean; since?: string; durationMs?: number; generated?: string; cached?: boolean };

type BookMoves = { updated?: string; window_h?: number; games?: number; note?: string;
  min_score?: number; max_games?: number; byBook?: ByBook[]; live?: LiveMove[] };
```

`ByBook` and `LiveMove` mirror the field lists in the brief exactly (`{book,label,n,led_pct,follow_pct,
avg_moved,key_cross_n,vs_public_n,vs_public_pct,role,small}` and the 22-field live item). They are declared
in phase 1 because the types are cheap and phase 2 consumes them; only `BookMoves.games`/`.updated` are read.

Env: `AGENTS_API_BASE` (server-only), default `https://edge-tracker-new-production.up.railway.app`.

## File-by-file plan

**Copied verbatim from `~/edge-tracker/edge-tracker-v2/` (read-only source):**

1. `web/postcss.config.mjs` ← `postcss.config.mjs` — `{ plugins: { "@tailwindcss/postcss": {} } }`.
2. `web/tsconfig.json` ← `tsconfig.json` — strict, `moduleResolution: bundler`, `@/*` → `./*`.
3. `web/eslint.config.mjs` ← `eslint.config.mjs`.
4. `web/app/globals.css` ← `app/globals.css` — `@import "tailwindcss"` + the dark `#0b0f19` body. Three
   lines of CSS; take it as the baseline and do not restyle in phase 1.

**New files:**

5. `web/package.json` — `private: true`, `type` unset (Next owns module resolution). deps pinned exactly:
   `next 16.2.4`, `react 19.2.4`, `react-dom 19.2.4`. devDeps: `typescript ^5`, `@types/node ^24`,
   `@types/react ^19`, `@types/react-dom ^19`, `eslint ^9`, `eslint-config-next 16.2.4`,
   `tailwindcss ^4`, `@tailwindcss/postcss ^4`. **No `pg`, no `@types/pg`, no `twilio`, no `zod`, no
   `@supabase/*`, no chart library.** Scripts: `dev` (`next dev -p 3100`), `build`, `start`, `lint`,
   `typecheck` (`tsc --noEmit`), `test` (`node --test test/`), `verify` (`npm run typecheck && npm run lint && npm run build && npm test`).
6. `web/next.config.ts` — minimal; `typedRoutes` left at its default. No `output`, no rewrites, no redirects.
7. `web/.gitignore` — `node_modules/`, `.next/`, `.env`, `.env.*`, `!.env.example`, `next-env.d.ts`.
8. `web/.env.example` — `# optional; defaults to the Railway engine` + `AGENTS_API_BASE=`. Empty value.
9. `web/README.md` — four lines: `npm i`, `npm run dev -p 3100` (and *why not* 3000), `npm run verify`,
   and the sentence "this app reads the agents API only; it never touches Postgres".
10. `web/lib/types.ts` — the types above. No runtime code.
11. `web/lib/agents.ts` — `const BASE = process.env.AGENTS_API_BASE?.trim() || '<railway url>'`;
    one private `read<T>(path, revalidate)` doing `fetch` with `signal: AbortSignal.timeout(8000)`,
    `next: { revalidate }`, treating **status 200 and 207** as success and everything else as
    `{ok:false, error: 'HTTP ' + status}`; exported `getHealth()` (15s), `getDataHealth()` (60s),
    `getPlays()` (30s). Each returns `AgentsResult<T>`. No `try/catch` that returns `{}`.
12. `web/lib/freshness.ts` — **pure, zero imports** (so it is directly testable): `ageMs(iso, now)`,
    `agoLabel(ms)`, `isStale(iso, boundMs, now)`, `agentStatus(a, now)` → `'ok'|'stale'|'errored'|'unknown'`,
    `num(v)` → `'—'` for `null`/`undefined`/`NaN`. **`num` must not coerce** — per the house rule in
    `HANDOFF.md`, `Number('')` and `Number(null)` are a finite `0` and `0` is never neutral here.
    Type-check presence before touching a value.
13. `web/app/layout.tsx` — adapted from v2's `app/layout.tsx` + `app/(app)/layout.tsx`, merged into one, nav
    trimmed to a single "Signal" link (links to pages that do not exist are a lie). Keep the `max-w-5xl`
    shell and the dark body. `viewport` metadata with `width=device-width, initial-scale=1` — this is read on
    a phone at 375px.
14. `web/app/page.tsx` — `export const dynamic = 'force-dynamic'`; `Promise.all([getHealth(), getDataHealth(), getPlays()])`;
    renders `<HealthPanel>`. No `'use client'` anywhere in phase 1.
15. `web/app/_components/SourceBanner.tsx` — the five states with the verbatim copy from
    `signal-dashboard.md`'s table (`Loading —`, `Feed answered.`, `older than`, `NOT FIRING`,
    `Read failed —`). Props `{kind, source, agoLabel, reason?, count?, thing?}`.
16. `web/app/_components/HealthPanel.tsx` — the panel body described in Approach §3. Tables wrapped in
    `overflow-x-auto` so they scroll inside their card, not the page. Reuse v2's amber-banner classes from
    `dashboard/page.tsx` for the `failed` kind.
17. `web/test/freshness.test.ts` — `node:test` + `node:assert/strict`, importing `../lib/freshness.ts`.
    Node 24 strips types natively, so this runs with **no new dependency and no new test framework**. Cases:
    `num(null)`/`num('')`/`num(NaN)` → `'—'` and `num(0)` → `0` (the mutation that matters: make `num` use
    `Number(v) || '—'` and the `num(0)` case must fail); `agentStatus` on a missing `lastRun`; `isStale`
    exactly at the bound. Keep it to ~6 assertions.

**Root changes (two files, three lines total):**

18. `.vercelignore` — append `web`.
19. `.gitignore` — append `node_modules/` and `.next/`. The root `.gitignore` currently covers only
    `.claude` locals, `.DS_Store` and `*.log`; without this, `web/node_modules` is one `git add -A` away
    from the index.
20. `HANDOFF.md` rewrite; `docs/DECISIONS.md` append one entry (code lands in `web/`; harvested from
    `edge-tracker-v2`, not the Next-14 tree; second Vercel project with root `vercel.json` untouched;
    agents API only, never `pg`; the `AgentsResult` discriminated shape adopted because a caught fetch error
    was silently preserving stale state in `applyAgentsBag`).

## Risks & open questions

1. **Two UIs is worse than one if the second stalls.** Phase 1 ships a Next app with one panel while the PWA
   keeps eight tabs. **Kill criterion for Blake:** if the Next app has not reached the four-panel dashboard
   within two more sessions, delete `web/` and the Vercel project and build the panels into `index.html` per
   `signal-dashboard.md` as originally specced. That spec stays valid and unbuilt; this does not burn it.
2. **The bet-log divergence is NOT solved and phase 1 must not look like it is.** There are now up to three
   candidate homes for real-money wager records: the old app's server-side `bets`/`games`/`signal_performance`
   in Postgres (schema gone), the PWA's nine localStorage arrays (device-local, no backup, flagged in
   `HANDOFF.md` as the worst risk profile in the file), and the agents service's 47 tables, which contain
   **none of the three**. Phase 1 is **read-only**: no bet entry, no writes, no localStorage, not one row.
   Nobody should later assume this phase picked a source of truth. It explicitly did not.
3. **`/data-health` returns 207 when degraded.** If the builder writes `if (!res.ok)` the Health panel will
   render "Read failed" on exactly the days the panel exists to describe. Called out again because it is the
   likeliest shipped defect here.
4. **Blake must confirm the Vercel project creation**, which is a dashboard action an agent should not take
   on its own: new project, same repo, Root Directory `web`, preset Next.js. Until he does, phase 1's deploy
   step is unverified and only the local build is proven.
5. **`~/edge-tracker` is 1.2GB and contains two apps plus `node_modules`.** The copy must be the 4 named files
   in the Copied list. A `cp -r` of either tree would drag `.next`, `node_modules` and possibly `.env.local`
   into this repo — and `.env.local` would land in a repo whose root `.gitignore` does not currently ignore it.
6. **Honest flag: this is not really a revival.** After abandoning `pg`, the route handlers, the external API
   fetchers, `components/`, and both bet-log pages, what crosses over is a config scaffold and one error-banner
   pattern — maybe an hour saved over `create-next-app`. The accurate framing is "new app, with v2's
   version pins and config harvested". Say so in `DECISIONS.md`; do not let a future reader believe five pages
   of working UI were recovered.
7. **`tools/smoke.mjs` and `edge-tracker-agents/test/` are owned by an in-flight tester branch** (127 and 132
   assertions respectively). Phase 1 touches neither. A `web/` section in `tools/smoke.mjs` is the right
   long-term home but is deferred to a follow-up, after that branch merges, to avoid a conflict in a file whose
   assertions are the project's main safety net.

## Test plan

**Automated.** From `web/`: `npm run verify` — `tsc --noEmit` clean, `next lint` clean, `next build` succeeds,
`node --test test/` passes (~6 assertions, 0 fail). Verify the tests bite: change `num` to
`Number(v) || '—'` and the `num(0)` case must fail; drop `207` from the success check and no test will
catch it — which is why it is a manual step below.

**Unchanged suites must stay unchanged.** `node tools/smoke.mjs` and `cd edge-tracker-agents && npm test`
must produce **byte-identical** output before and after this branch, because this branch does not touch
either tree. The verifier should diff the two runs, not just check for green.

**Manual check recipe.**

1. `lsof -nP -iTCP -sTCP:LISTEN` — read the listeners *first*. A Pool Room Pro Electron process holds
   4317–4318 and **Vantyx holds 3000, which is `next dev`'s default port**. *Proves:* 3000 is unusable; both
   `next dev` and `npx serve` fall back silently, so any later "it works on localhost:3000" claim would be
   about Vantyx, not this app. Nothing else.
2. `cd web && npm i && npm run verify`. *Proves:* the dependency set resolves, types are sound, and the
   production build compiles. It proves **nothing** about live data — `next build` never calls the API for a
   `force-dynamic` page.
3. `npm run dev` (pinned to 3100) and open `http://localhost:3100` with DevTools → Network. *Proves:* the
   Health panel renders real agent names, real `/data-health` table counts, and a slate line with a non-zero
   game count — i.e. the server-side read of the live Railway API works. Confirm the browser's Network tab
   shows **no request to `railway.app`**: all three reads happened on the server.
4. Reload three times within 30 seconds, watching the `next dev` terminal. *Proves:* the Data Cache is
   sharing `/plays` — one upstream fetch, not three 1.36MB downloads. This is the step that tests decision 3.
5. Set `AGENTS_API_BASE=http://127.0.0.1:9` and restart dev. *Proves:* the `failed` banner appears naming the
   source and renders the verbatim `Read failed —` copy, the page still returns 200 rather than throwing, and
   no panel silently shows `0` or `—` as if it were an answer. **This is the central requirement.** Restore
   the env and confirm the banner clears.
6. `curl -s -o /dev/null -w '%{http_code}\n' "$AGENTS_API_BASE/data-health"` — if it returns **207**, the
   panel must show the data *plus* a degraded note, **not** "Read failed". If it returns 200, force the case
   by pointing `AGENTS_API_BASE` at a one-line local server that replies 207 with a valid body. *Proves:* risk 3
   is actually handled rather than merely mentioned.
7. On the phone, at 375px, open the Vercel URL. *Proves:* tables scroll horizontally inside their cards and
   the page never scrolls sideways; and that the PWA on the home screen is **untouched** — open it and confirm
   it still loads and still shows its own eight tabs.

**Reviewer checks:** no `pg`/`twilio`/`zod`/`@supabase`/chart dependency in `web/package.json`; no `'use client'`;
no `NEXT_PUBLIC_` variable; no `.catch(() => ({}))` or any catch that returns an empty object; no `fetch` in a
client component; no `.env*` file other than `.env.example`, and that file's values empty; no file copied from
`~/edge-tracker` outside the 4 named; `vercel.json` diff empty; `index.html`, `sw.js`,
`manifest.webmanifest`, `tools/smoke.mjs` and `edge-tracker-agents/**` diffs all empty; every array read via
`?? []`; `num` never coerces.

## Follow-up phases

1. **Panels 2–4** (Budget, Books, Steam) from `docs/specs/signal-dashboard.md`, carried over as React. Needs
   the two additive backend changes that spec already specifies: exported `getOddsCeilings()` in
   `edge-tracker-agents/src/agents/odds/index.js` and `sharp: getIntel('sharp')` in `/plays`
   (`src/index.js:419`). Carry over its `vs_public: UNAVAILABLE` banner and its three candidate causes verbatim.
2. **Bet-log reconciliation** — pick one source of truth for real wagers among Postgres, nine localStorage
   arrays, and nothing. This is the highest-stakes open question in the project and its own phase, with its own
   spec. Phase 1 deliberately left it untouched.
3. **Port the remaining pages** — `today`, `log`, `report`, `settings`. `today` maps onto `/games` and `/plays`
   and is mostly mechanical; `log` is blocked on follow-up 2; `report` means deciding whether Anthropic calls
   move to the agents service (they should) rather than being re-added to the web app.
4. **Recover the Twilio alerting.** `HANDOFF.md` item 9 — watchdog alerts reach zero recipients because
   `notifyAll` needs `ALERT_NUMBERS` or `SMTP_*`, and *every* "make it loud" path in this project terminates
   there. `~/edge-tracker/edge-tracker-v2/lib/notify.ts` is real SMS code (`TWILIO_SID`, `TWILIO_AUTH`,
   `TWILIO_PHONE`, `USER_PHONE`) and is **worth recovering** — but into `edge-tracker-agents/`, not into
   `web/`, because the watchdog runs on Railway and a Vercel page cannot send an alert nobody has opened.
5. **`sharp` history reader** (`docs/specs/sharp-history-reader.md`, shelved) — what makes the Steam panel
   non-empty.
6. **Open→close for all 12 sports** (`docs/specs/line-move-all-sports.md`, shelved, store shape and renames
   already decided) — what gives the Books panel an open-to-close column beyond NFL.
7. **A `web/` section in `tools/smoke.mjs`**, after the in-flight tester branch merges (risk 7).
