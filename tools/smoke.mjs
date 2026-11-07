#!/usr/bin/env node
// Smoke checks for the Edge Tracker PWA.
//
// index.html is one ~7700-line file served statically with no build step, so a
// syntax error silently breaks the whole app and there is nothing to catch it.
// This asserts the things a human would otherwise have to open a phone to see.
//
//   node tools/smoke.mjs          # structure + parse only (offline, fast)
//   node tools/smoke.mjs --live   # also check the backend /games payload shape
//
// Exits non-zero on the first failing group so it is usable as a pre-push gate.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'index.html'), 'utf8');

let pass = 0;
const fails = [];
const skips = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fails.push(detail ? `${name} — ${detail}` : name);
};
// Some assertions in this file arrived with a branch whose feature is not on
// `main` yet, so they would fail for a reason that is nobody's regression. A
// skip states WHICH unmerged work the assertion is waiting for, and starts
// enforcing by itself the moment that feature lands — deleting the assertion
// instead would silently drop its coverage.
const skip = (name, why) => { skips.push(`${name} — ${why}`); };
const skipAll = (names, why) => { for (const n of names) skip(n, why); };
// Strip comments before asserting that source does NOT contain a construct.
// A bare `!/x/.test(src)` over the whole file also forbids PROSE about x, so
// documenting the very decision the assertion pins fails the build for a
// non-defect. Crude but adequate: block comments and line comments, with a
// guard so the `//` in a URL survives.
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── 1. Every inline script parses ────────────────────────────────
// The whole app is inside <script> blocks; one typo takes the page down.
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok('found inline scripts', scripts.length > 0, `matched ${scripts.length}`);
scripts.forEach((src, i) => {
  if (!src.trim()) return;
  try { new Function(src); ok(`script[${i}] parses`, true); }
  catch (e) { ok(`script[${i}] parses`, false, e.message); }
});

// ── 2-5. The consolidated Games view (PR #129) ───────────────────
// This harness was cherry-picked from the branch that BUILDS that view, so on
// any branch based on plain `main` the view is simply absent and all of its
// assertions fail for a reason unrelated to the branch under test. Detect the
// feature and skip rather than fail; when #129 merges these light up on their
// own with no edit here.
const GAMES_VIEW_PR = 'awaiting the consolidated Games view (PR #129, feat/function-first-games)';
const hasGamesView = /function\s+renderHomeGames\s*\(/.test(html);
if (!hasGamesView) {
  skipAll([
    'HOME_TABS has a games tile', 'renderHomeScreen dispatches games',
    'renderHomeGames is defined', 'pagedots _ord includes games',
    'swipe order includes games', 'gamesCache exists on state',
    'gamesLoading was removed', 'new Games block found',
    'chip row does not call setSport', 'new view never writes et_tab',
    'fetch checks response.ok', 'late-response guard present',
    'error state is keyed by sport', 'renderGamesHTML takes spOverride',
    'spOverride falls back to state.sport',
  ], GAMES_VIEW_PR);
} else {

// ── 2. Router wiring for the consolidated Games view ─────────────
// Each of these is a separate place the section has to be registered; missing
// any one of them yields a tile that renders nothing, or dots/swipe that
// disagree with the sections that exist.
ok('HOME_TABS has a games tile', /HOME_TABS[\s\S]{0,800}?id:\s*'games'/.test(html));
ok('renderHomeScreen dispatches games', /homeTab===['"]games['"]\s*\)\s*renderHomeGames\(\)/.test(html));
ok('renderHomeGames is defined', /function\s+renderHomeGames\s*\(/.test(html));
ok('pagedots _ord includes games', /_ord\s*=\s*\[[^\]]*'games'/.test(html));
ok('swipe order includes games', /\border\s*=\s*\[[^\]]*'games'/.test(html));

// ── 3. State shape ───────────────────────────────────────────────
ok('gamesCache exists on state', /gamesCache\s*:/.test(html));
ok('gamesLoading was removed', !/gamesLoading/.test(html),
  'dead field: written but never read (reviewer finding 6)');

// ── 4. Invariants the reviewer confirmed, as regressions ─────────
// These encode defects that were actually shipped once and fixed; they are the
// ones most likely to come back during Phase 2.
const gamesBlock = (html.match(/function\s+renderHomeGames[\s\S]*?function\s+renderHomeLog/) || [''])[0];
ok('new Games block found', gamesBlock.length > 0);
ok('chip row does not call setSport', !/function\s+setGamesSport[\s\S]{0,300}?setSport\(/.test(html),
  'setSport() clears homeScreen and wipes slate/model state');
ok('new view never writes et_tab', !/et_tab/.test(gamesBlock),
  'reload behavior must stay unchanged');
ok('fetch checks response.ok', /\.ok\b/.test(gamesBlock),
  'a 500 body would otherwise be cached as an empty slate for the session');
ok('late-response guard present', /!state\.homeScreen\s*\|\|\s*state\.homeTab\s*!==\s*['"]games['"]/.test(gamesBlock));
ok('error state is keyed by sport', !/state\.gamesErr\s*=\s*e\.message\s*;/.test(gamesBlock),
  'an unkeyed error string blanks a different sport\'s loaded board');

// ── 5. renderGamesHTML stays backward compatible ─────────────────
ok('renderGamesHTML takes spOverride', /function\s+renderGamesHTML\s*\(\s*d\s*,\s*spOverride/.test(html));
ok('spOverride falls back to state.sport', /\(\s*spOverride\s*\|\|\s*state\.sport\s*\)/.test(html));

} // end: consolidated Games view present

// ── 6. No new dependencies or external CSS ───────────────────────
ok('no script src= added', !/<script[^>]*\bsrc=/i.test(html), 'app is deliberately dependency-free');

// ── 7. Backend CORS origin matching ──────────────────────────────
// The API admits local dev origins so the PWA is testable before deploy. That
// regex is the only thing standing between "localhost works" and "any host
// ending in localhost works", so pin its behaviour rather than trusting a read.
const server = await readFile(join(root, 'edge-tracker-agents/src/index.js'), 'utf8');
// The monitored-table list moved out of src/index.js into its own module (#130,
// extracted to make the counting and error-classification testable), so the
// data-health assertions below read it from there rather than from `server`.
const dataHealth = await readFile(join(root, 'edge-tracker-agents/src/health/data-health.js'), 'utf8');
const localRe = (server.match(/const isLocalDev\s*=\s*origin\s*&&\s*(\/.+?\/)\.test\(origin\)/) || [])[1];
// `isLocalDev` is a feature #129 ADDS (it admits local dev origins so the PWA
// is testable before deploy) — not a rename of anything on `main`. Where the
// const is absent the local-dev allowance does not exist, so there is no regex
// to pin and nothing is being let through unchecked.
if (!localRe && !/const isLocalDev\s*=/.test(server)) {
  skipAll(['isLocalDev origin regex found', 'local-dev origin regex accepts/rejects correctly'],
    'awaiting the local-dev CORS allowance (PR #129) — absent here, so no origin is admitted by it');
} else ok('isLocalDev origin regex found', !!localRe);
if (localRe) {
  const re = new RegExp(localRe.slice(1, -1));
  const cases = [
    ['http://localhost:59383', true], ['http://localhost', true],
    ['http://127.0.0.1:3000', true], ['https://localhost:8443', true],
    ['http://[::1]:4318', true],
    // spoofing attempts — every one of these must be rejected
    ['http://localhost.evil.com', false], ['http://localhost:3000.evil.com', false],
    ['http://notlocalhost:3000', false], ['http://127.0.0.1.evil.com', false],
    ['https://evil.com/?x=http://localhost', false], ['http://evil.com#http://localhost', false],
  ];
  const bad = cases.filter(([o, want]) => re.test(o) !== want).map(([o]) => o);
  ok('local-dev origin regex accepts/rejects correctly', bad.length === 0, `misclassified: ${bad.join(', ')}`);
}

// ── 8. Optional: live backend contract ───────────────────────────
if (process.argv.includes('--live')) {
  const base = (html.match(/et_agent_api'\s*,\s*'([^']+)'/) || [])[1];
  ok('backend base URL found in source', !!base, base || 'no default found');
  if (base) {
    try {
      const r = await fetch(`${base}/games?sport=NFL`, { signal: AbortSignal.timeout(20000) });
      ok('GET /games?sport=NFL responds ok', r.ok, `HTTP ${r.status}`);
      const d = await r.json();
      ok('/games returns a games array or a note', Array.isArray(d.games) || typeof d.note === 'string',
        `got keys: ${Object.keys(d).join(',')}`);
    } catch (e) {
      ok('GET /games?sport=NFL responds ok', false, e.message);
    }
  }
}

// ── 10. Book movement attribution (book-move agent) ──────────────
// The agent's whole justification is that it costs nothing: its inputs are the
// in-memory slate, the in-memory splits and bounded reads of our own snapshot
// table. A single fetch( in that file silently turns a $0 agent into an Odds
// API bill, so pin it by reading the source.
const bmSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/book-move/index.js'), 'utf8');
ok('book-move spends nothing', !/\bfetch\s*\(/.test(bmSrc), 'no Odds API call may appear in this agent');
ok('book-move reads snapshots, not line_movements', /line_snapshots/.test(bmSrc) && !/line_movements/.test(bmSrc),
  'the pre-computed table loses its baseline on every redeploy');
ok('book-move bounds its slate', /MAX_GAMES|slice\(0,\s*\d+\)/.test(bmSrc));
ok('snapshot query is descending+limited', /ascending:\s*false/.test(bmSrc) && /limit:\s*\d+/.test(bmSrc),
  'ASC + limit would truncate the newest rows');
ok('book-move reuses shared key numbers', /shared\/key-numbers\.js/.test(bmSrc));
ok('book roles are derived', /led_pct/.test(bmSrc));
ok('no hardcoded sharp-book list', !/pinnacle|circa/i.test(bmSrc), 'our book list is all US retail — no book gets a maker prior');

// Semantics, not syntax. These three defects all parsed cleanly, shipped, and
// silently inverted or doubled the numbers the scorecard is built from — each
// one compounds, because led_pct becomes the next run's `lead` prior.

// `led` must mean "of the books that reached this level, I got there first".
// It was `consensus !== to` — "my line differs from the batch median" — which
// credits a book for moving AWAY from the field and makes BOTH movers leaders
// in a two-book batch.
ok('led means first to the level, not different from the median',
  /lead_rank/.test(bmSrc) && !/const led\s*=\s*consensus/.test(bmSrc) && !/\bmedian\s*\(/.test(bmSrc),
  'a book moving away from the field is not a leader');
ok('led is only ever the first arrival', /i === 0 && cluster\.length > 1/.test(bmSrc),
  'and never when there was no field to lead (a lone book at a level)');
ok('arrival order comes from batch order first', /_bi/.test(bmSrc) && /function cmpArrival/.test(bmSrc),
  'last_update is a market-level stamp — it may not reorder the leaderboard on its own');
ok('the moved_at stamp is clamped to the observed interval', /function clampStamp/.test(bmSrc),
  'an unplaceable stamp also inflates hours_to_start into full `early` credit');

// odds/index.js writes one snapshot row per OUTCOME, so one spread move arrives
// twice (Chiefs −3→−3.5 and Broncos +3→+3.5). Both scored identically and the
// dedup key included `side`, so every card was duplicated and every n was 2×.
ok('one episode per line move, not one per outcome',
  /function canonicalSide/.test(bmSrc) && /canonicalSide\(/.test(bmSrc),
  'a spread move is written twice — score the home side only');
ok('book-move no longer loops every side', !/of bySide\b/.test(bmSrc),
  'iterating both outcomes doubles every episode and every book count');

// A component with no data must be NEUTRAL. `vsPublic === true ? 1 : 0` scored
// "no public_splits coverage for this sport" exactly like "moved WITH the
// public", capping NCAAF/soccer/tennis at 80 against a threshold of 35.
ok('the score renormalizes over the components that applied',
  /parts\.push/.test(bmSrc) && /wSum/.test(bmSrc) && !/vsPublic === true \? 1 : 0/.test(bmSrc),
  'dividing by the full weight total scores a missing input as an adverse one');
ok('a null public split is excluded, not counted as zero', /if \(vsPublic != null\)\s*parts\.push/.test(bmSrc));
ok('key numbers are spreads-only', /keyApplies/.test(bmSrc) && /market === 'spreads'/.test(bmSrc),
  'KEYS are football margin numbers — a 43→44.5 total can never cross one');
ok('the scorecard counts the log once', /logged\.has\(epKey\(ep\)\)/.test(bmSrc),
  'history already contains the episodes the last three runs wrote');
ok('a null price never persists as 0', /row\.price != null/.test(bmSrc),
  'Number(null) === 0 reads as a real American price');
ok('an empty slate preserves the published scorecard', !/setBookMoves\(null\)/.test(bmSrc),
  'nulling it erases 14 days of history from the PWA and flaps on the 15-min cadence');

const knSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/key-number/index.js'), 'utf8');
ok('key-number imports shared keys', /shared\/key-numbers\.js/.test(knSrc));
ok('key-number no longer declares LAND_PCT', !/const LAND_PCT/.test(knSrc), 'two copies would drift apart');

const storeSrc = await readFile(join(root, 'edge-tracker-agents/src/store/index.js'), 'utf8');
ok('store exports setBookMoves', /export function setBookMoves/.test(storeSrc));

ok('/plays serves bookMoves', /bookMoves:\s*getBookMoves\(\)/.test(server));
ok('data-health watches book_move_log', /book_move_log/.test(dataHealth));

// A half-registered agent (defined but missing from one of these) shows as a
// permanent red dot on the Agents grid and never runs.
const cfgSrc = await readFile(join(root, 'edge-tracker-agents/src/config/index.js'), 'utf8');
const orchSrc = await readFile(join(root, 'edge-tracker-agents/src/orchestrator/index.js'), 'utf8');
ok('book-move registered in config', /'book-move'/.test(cfgSrc));
ok('book-move registered in orchestrator', /book-move/.test(orchSrc) && /\bbookMove\b/.test(orchSrc));
ok('book-move listed in the PWA agent grid', /'book-move'|name:'book-move'/.test(html));
ok("AGENT_STALE_MS covers book-move", /AGENT_STALE_MS[\s\S]{0,4000}?'book-move':\s*\d+/.test(html));
ok('book-move render tolerates old cached payload', /bm\.live\s*\|\|/.test(html) && /bm\.byBook\s*\|\|/.test(html),
  'hydrateAgentsCache replays a pre-bookMoves bag on first paint');


// The section lived inside `if(onPlays){` — it rendered on the Plays tab and
// was unreachable on the Agents tab, where the spec puts it.
const bmBlock = html.indexOf('// Book movement attribution');
const endOnPlays = html.indexOf('} // end onPlays');
ok('book movement renders on the Agents tab', bmBlock > endOnPlays && bmBlock > 0,
  'it must sit in the !onPlays region of renderAgentsContent');

// ── 10b. The `led` rules the scorecard is built from ─────────────
// Every one of these parsed cleanly and shipped once. `led_pct` becomes the next
// run's `lead` prior, so each of them compounds across runs.
ok('a tie is not a lead', /function strictlyBefore|const strictlyBefore/.test(bmSrc) && /strictlyBefore\(cluster\[0\], cluster\[1\]\)/.test(bmSrc),
  'two books in one batch with no usable stamp cannot be separated');
ok('a revisited level is clustered by arrival time', /CLUSTER_MS/.test(bmSrc) && /6 \* 3600_000/.test(bmSrc),
  '3 -> 3.5 -> 3 must not rank two unrelated moves against each other');
ok('arrivals are grouped by level AND direction', /const k = `\$\{e\.line_to\}\|\$\{e\.direction\}`/.test(bmSrc),
  'two books converging on -3.5 from opposite sides are not the same market move; ranking them together credited a lead nobody earned and inflated led_pct on choppy markets');
ok('the clamp floor is the previous batch this book was seen in', /lastTs/.test(bmSrc) && /clampStamp\(row\.last_update, prevTs, ts\)/.test(bmSrc),
  'without a floor a stale market-level stamp reorders the leaderboard');
ok('the canonical-side picker has a deterministic fallback', /\|\| sorted\[0\]/.test(bmSrc),
  'an unmatchable feed label must still emit exactly one episode, not zero and not two');
ok('window_h reports the window observed, not the one requested',
  /window_h:\s*r1\(obsMin\)/.test(bmSrc) && /window_h_requested/.test(bmSrc),
  'SNAP_LIMIT, not WINDOW_H, is the real coverage ceiling');
ok('the slate gives the cap to upcoming kickoffs first',
  /const upcoming\s*=[\s\S]{0,200}?const started\s*=[\s\S]{0,200}?\[\.\.\.upcoming,\s*\.\.\.started\]/.test(bmSrc),
  'a late slate of in-progress games must not crowd out pre-game movement');
ok('hours_to_start is measured from the move, not from now', /Date\.parse\(movedAt\)/.test(bmSrc));
ok('the early component is clamped to [0,1]', /Math\.max\(0,\s*Math\.min\(1,\s*hours \/ 24\)\)/.test(bmSrc),
  'a post-kickoff move has negative hours and would otherwise score negative');

// The weights are judgement, but they are SPEC'd judgement — a silent retune
// changes which sports clear MIN_SCORE.
const wLine = (bmSrc.match(/const W = \{[^}]*\}/) || [''])[0];
ok('scoring weights match the spec', /mag:\s*0\.30/.test(wLine) && /key:\s*0\.20/.test(wLine)
  && /early:\s*0\.15/.test(wLine) && /vsPublic:\s*0\.20/.test(wLine) && /lead:\s*0\.15/.test(wLine), wLine);

// Cross-file invariant: the upsert conflict target must be exactly the table's
// unique constraint, or every re-scan of the 48h window duplicates its episodes.
const schema = await readFile(join(root, 'edge-tracker-agents/scripts/schema.sql'), 'utf8');
const uniq = (schema.match(/create table if not exists book_move_log[\s\S]*?unique \(([^)]+)\)/) || [])[1];
const conflict = (bmSrc.match(/upsert\('book_move_log',\s*\w+,\s*'([^']+)'/) || [])[1];
ok('book_move_log declares its unique key', !!uniq, uniq || 'no unique(...) found');
ok('the upsert conflict target is the table unique key',
  !!uniq && !!conflict && uniq.replace(/\s/g, '') === conflict.replace(/\s/g, ''),
  `schema: ${uniq} / upsert: ${conflict}`);
ok('moved_at is non-null in the schema', /moved_at\s+timestamptz not null/.test(schema),
  'Postgres treats nulls as distinct, so a null moved_at defeats the unique key');
ok('the new table is indexed', /book_move_log_book_idx/.test(schema) && /book_move_log_game_idx/.test(schema));
const migrate = await readFile(join(root, 'edge-tracker-agents/scripts/migrate.js'), 'utf8');
ok('migrate.js knows about book_move_log', /book_move_log/.test(migrate));

// The watchdog's schema probes are the ONE runtime tell for a table whose DDL
// nobody ran (D69/D70) — and book_move_log, hand-run 2026-10-28, was not in
// them. The list is hand-maintained, so this pins it structurally: every table
// either hand-run SQL file declares must be probed, except the ones that
// pre-date the probe (frozen below — do not add to it; add the probe instead).
const watchdogSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/watchdog/index.js'), 'utf8');
// schema.sql is not the only file a human pastes into the Supabase editor.
// migrate-research.sql carries 11 more `alter table … add column` statements
// and the only declaration of the two closing-line tables, and reading only
// schema.sql left every one of them outside this guard (D106).
const migrateResearch = await readFile(join(root, 'edge-tracker-agents/scripts/migrate-research.sql'), 'utf8');
const SQL_FILES = [['scripts/schema.sql', schema], ['scripts/migrate-research.sql', migrateResearch]];

// One pass over the `alter table` statements of a file, in source order, so a
// column that was added and later DROPPED or RENAMED AWAY leaves the required
// set. Without that, a future `drop column` would demand a probe for a column
// that no longer exists, forever — and the only way out would be deleting the
// assertion. Forms accepted: a quoted or bare table name, `add column` with or
// without `if not exists`. `alter column` is excluded on purpose: it changes a
// column that already exists and creates nothing to probe.
const DDL_COL_RE = /alter\s+table\s+(?:if\s+exists\s+)?"?(\w+)"?\s+(add|drop|rename)\s+column\s+(?:if\s+not\s+exists\s+|if\s+exists\s+)?"?(\w+)"?(?:\s+to\s+"?(\w+)"?)?/gi;
const requiredColumns = (sql) => {
  const req = new Set();
  for (const [, table, verb, col, to] of sql.matchAll(DDL_COL_RE)) {
    const key = `${table}.${col}`;
    const v = verb.toLowerCase();
    if (v === 'add') req.add(key);
    else if (v === 'drop') req.delete(key);
    else if (v === 'rename' && req.delete(key) && to) req.add(`${table}.${to}`);
  }
  return req;
};
const declaredTables = (sql) => [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi)].map((m) => m[1]);

// ── the parser's forms, on fixtures rather than on the live schema ──
// Pinning these against the real files would make the assertions tautological
// (they pass because today's schema happens not to use the form) and would
// need a `drop column` added to production DDL to test retirement at all.
{
  const FIXTURE = `
    alter table "public_splits" add column freeze boolean;
    alter table public_splits add column if not exists pileon boolean;
    alter table public_splits alter column pileon drop not null;
    alter table public_splits add column "net_move" numeric;
    alter table public_splits add column doomed text;
    alter table public_splits drop column if exists doomed;
    alter table public_splits add column old_name text;
    alter table public_splits rename column old_name to new_name;
  `;
  const req = requiredColumns(FIXTURE);
  ok('the DDL parser accepts a quoted table name', req.has('public_splits.freeze'),
    '"public_splits" is valid SQL and reads as a different table to a bare-\\w+ regex');
  ok('the DDL parser accepts add column without if not exists', req.has('public_splits.freeze')
    && req.has('public_splits.net_move'), 'the shorter form is the one a human types by hand');
  ok('the DDL parser accepts a quoted column name', req.has('public_splits.net_move'));
  ok('the DDL parser still ignores alter column', ![...req].some((c) => /phone|not_null/.test(c))
    && req.size === 4, `alter column creates nothing to probe — got ${[...req].join(', ')}`);
  ok('a dropped column leaves the required set', !req.has('public_splits.doomed'),
    'otherwise a future drop column demands a probe for a column that is gone, forever');
  ok('a renamed column follows its new name', !req.has('public_splits.old_name')
    && req.has('public_splits.new_name'));
  const declared = declaredTables('create table if not exists "quoted_tbl" (id uuid);\ncreate table bare_tbl (id uuid);');
  ok('the table parser accepts quoted and if-not-exists-less create table',
    declared.includes('quoted_tbl') && declared.includes('bare_tbl'), declared.join(', '));
}

ok('the watchdog probes book_move_log', /\['book_move_log',\s*'\w+',\s*'table'\]/.test(watchdogSrc));
{
  const probeBlock = (watchdogSrc.match(/const probes = \[([\s\S]*?)\];/) || ['', ''])[1];
  const probedTables = new Set([...probeBlock.matchAll(/\['(\w+)',\s*'\w+',\s*'table'\]/g)].map((m) => m[1]));
  const probedCols = new Set([...probeBlock.matchAll(/\['(\w+)',\s*'(\w+)',\s*'column'\]/g)].map((m) => `${m[1]}.${m[2]}`));
  const PRE_PROBE = new Set([
    'scan_runs', 'api_usage', 'opening_lines', 'injury_updates',
    'sharp_signals', 'power_ratings', 'schedule_spots', 'mlb_context', 'player_usage',
    'prop_snapshots', 'combat_markets', 'combat_news', 'alert_log', 'tennis_markets', 'tennis_fatigue',
    'tennis_matchups', 'nfl_power_ratings', 'nfl_win_totals', 'nfl_schedule_spots',
    'nfl_prop_baselines', 'public_fades', 'combat_derivatives', 'nfl_scoring', 'book_edge_log',
    'nfl_inactives', 'nfl_derivatives', 'nfl_pace',
  ]);
  const allDeclared = SQL_FILES.flatMap(([, sql]) => declaredTables(sql));
  const unprobed = allDeclared.filter((t) => !probedTables.has(t) && !PRE_PROBE.has(t));
  ok('every table the hand-run SQL declares is probed by the watchdog', unprobed.length === 0,
    `add a probe for: ${unprobed.join(', ')} — hand-run DDL is how this repo ships a table nobody created`);
  ok('the closing-line tables are probed', probedTables.has('nfl_closing_lines')
    && probedTables.has('ncaaf_closing_lines'), 'declared only in migrate-research.sql, which this check once did not read');
  // The allowlist is the 2026-11-07 set minus the five tables that have since
  // been probed. It is shrink-only on purpose: the subset assertion below
  // forbids a phantom entry, and the ceiling forbids using it as an escape
  // hatch for the assertion above. (No exact pin — legitimate consolidation
  // shrinks it, and an exact pin would then fail for a non-defect.)
  ok('the pre-probe allowlist holds nothing already probed',
    ![...PRE_PROBE].some((t) => probedTables.has(t)),
    'once a table is probed its allowlist entry is dead weight — remove it');
  ok('the pre-probe allowlist names only declared tables',
    [...PRE_PROBE].every((t) => allDeclared.includes(t)),
    'a phantom entry silences a probe assertion for a table that does not exist');
  ok('the pre-probe allowlist has not grown', PRE_PROBE.size <= 27,
    `${PRE_PROBE.size} entries — do not grow it; add the probe to the watchdog instead`);

  // Rule 1, and the regression that prompted it: retagging a table's existing
  // entry `'column'` retires its table probe in silence. `monitor_scores`,
  // `clv_records` and `line_snapshots` each lost theirs that way, so a dropped
  // table would have been reported as five to seven missing columns and the
  // create-table repair would never have been printed.
  const colTables = new Set([...probedCols].map((c) => c.split('.')[0]));
  const tablelessColProbes = [...colTables].filter((t) => !probedTables.has(t));
  ok('every table with column probes also has a table probe', tablelessColProbes.length === 0,
    `${tablelessColProbes.join(', ')} — without it a missing table reads as N missing columns`);
  const dupTableProbes = [...probeBlock.matchAll(/\['(\w+)',\s*'\w+',\s*'table'\]/g)]
    .map((m) => m[1]).filter((t, i, a) => a.indexOf(t) !== i);
  ok('no table carries two table probes', dupTableProbes.length === 0, dupTableProbes.join(', '));

  // The same pin one level down, and the one that was missing on 2026-11-07:
  // every `alter table … add column` in either file is hand-run DDL, so every
  // one of them can be skipped in Supabase and leave the code reading a column
  // that is not there. `line_movements.gap_min` was skipped for 229 steam runs
  // (D103). There is no allowlist here on purpose — the next forgotten column
  // fails the build.
  // Which files get parsed is itself the thing that failed on 2026-11-07: the
  // cross-check read schema.sql only, so dropping a file from SQL_FILES makes
  // every assertion below pass vacuously. This names the file by one of its
  // columns, so the omission fails rather than going quiet.
  const allRequired = new Set(SQL_FILES.flatMap(([, sql]) => [...requiredColumns(sql)]));
  for (const c of ['research_notes.signals', 'nfl_closing_lines.over_odds', 'ncaaf_closing_lines.under_odds',
    'line_movements.gap_min']) {
    ok(`the cross-check requires ${c}`, allRequired.has(c),
      'hand-run DDL lives in schema.sql AND migrate-research.sql — both must be parsed (D106)');
  }

  for (const [name, sql] of SQL_FILES) {
    const req = requiredColumns(sql);
    // Structural, not a count: if a file's `alter table` statements stop
    // parsing, the subset assertion below passes vacuously and the whole
    // guard goes quiet. This is what catches that.
    ok(`the DDL parser found alter-table columns in ${name}`, req.size > 0,
      'a vacuous subset check is indistinguishable from coverage');
    const unprobedCols = [...req].filter((c) => !probedCols.has(c));
    ok(`every hand-run column in ${name} is probed by the watchdog`, unprobedCols.length === 0,
      `add a probe for: ${unprobedCols.join(', ')} — an unapplied alter table is invisible until a reader selects the column`);
  }
  ok('the line_movements columns from #136 are probed', probedCols.has('line_movements.gap_min')
    && probedCols.has('line_movements.baseline_source'), 'the 229-blind-run column (D103)');
  ok('the research_notes columns are probed', ['signals', 'player', 'stat']
    .every((c) => probedCols.has(`research_notes.${c}`)),
    'backtest selects signals inside a swallowing catch — blind forever if it is absent (D106)');
}

// The repair text has to be runnable. Pasting the whole of schema.sql into the
// Supabase SQL editor cannot work: it runs a paste as one transaction and the
// file carries a placeholder timestamp that deliberately does not cast
// (schema.sql:728), so the paste aborts there and rolls everything back.
ok('schema.sql still carries the uncastable placeholder',
  /'YYYY-MM-DDTHH:MM:SSZ'/.test(schema), 'the reason the repair text says one block at a time');
ok('the schema issue does not tell a human to run scripts/schema.sql',
  !/run scripts\/schema\.sql/.test(codeOnly(watchdogSrc)),
  'that paste aborts on the placeholder and rolls back every statement with it');
ok('the schema issue names the create table block as the repair',
  /create table block individually/.test(watchdogSrc));
ok('the column issue names the one alter table line as the repair',
  /alter table line individually/.test(watchdogSrc));

// A missing table fails every column probe on it too, and the repair for all of
// them is the one create table — so the table verdict must suppress its own
// columns, or one absent table publishes N lines pointing at the wrong fix.
ok('a missing table suppresses its own column probes',
  /deadTables/.test(watchdogSrc) && /deadTables\.has\(p\[0\]\)/.test(watchdogSrc),
  'opp_results absent used to publish three lines, ev_opportunities four');

// Schema issues are the only watchdog lines whose repair is hand-run DDL, and
// nothing else in the app reports them — so they must not be what the 8-row
// cap on the dashboard banner drops first.
{
  const banner = (html.match(/Watchdog status banner[\s\S]{0,1600}/) || [''])[0];
  ok('the watchdog banner sorts schema issues ahead of the cap',
    /sort\(/.test(banner) && /'schema'/.test(banner) && /ordered\.slice\(0,8\)/.test(banner),
    'eight stale-agent lines used to hide the one line a human has to act on');
  ok('the watchdog banner still caps the list', /slice\(0,8\)/.test(banner));
  ok('the watchdog banner still counts every issue, not the capped list',
    /iss\.length\+'\s*issue'/.test(banner), 'the count is the honest total');
}

ok('data-health watches book_move_log by detected_at', /\['book_move_log',\s*'detected_at'\]/.test(dataHealth));
ok('line_movements was NOT added to data-health', !/\['line_movements'/.test(server),
  'an unbounded count on that table is what already times out the page');

// The dedup key is only safe because both timestamp spellings parse to the same
// epoch. Postgres hands back '2026-10-17 12:00:00+00'; we derive '…T12:00:00Z'.
// If this ever stops holding, `n` silently doubles again.
{
  const z = '2026-10-17T12:00:00.500Z';
  const forms = [z.replace('T', ' ').replace('Z', '+00:00'), z.replace('T', ' ').replace('Z', '+00'), z.replace('Z', '+00:00')];
  const bad = forms.filter((f) => Date.parse(f) !== Date.parse(z));
  ok('a Postgres timestamp keys identically to a freshly derived one', bad.length === 0,
    `unparsed: ${bad.join(', ')}`);
}

// ── 11. Shared key numbers — EXECUTED, not grepped ───────────────
// This module has no external dependencies, so unlike the agents it can be
// imported and actually run here. The extraction out of key-number/index.js was
// supposed to be behaviour-preserving, so assert the values and the crossing
// rule rather than just the import line.
const kn = await import('../edge-tracker-agents/src/agents/shared/key-numbers.js');
ok('KEYS are in the calibrated priority order',
  JSON.stringify(kn.KEYS.map((x) => x.k)) === JSON.stringify([3, 7, 4, 6, 14, 17, 10]),
  JSON.stringify(kn.KEYS.map((x) => x.k)));
ok('LAND_PCT keeps the measured 2025 frequencies',
  JSON.stringify(kn.LAND_PCT) === JSON.stringify({ 3: 15.1, 4: 5.5, 6: 4.1, 7: 9.6, 10: 3.7, 14: 4.1, 17: 4 }),
  JSON.stringify(kn.LAND_PCT));
ok('every KEYS entry has a landing frequency', kn.KEYS.every((x) => kn.LAND_PCT[x.k] != null));
{
  const cases = [
    [2.5, 3.5, 3], [3.5, 2.5, 3],        // either direction
    [3, 3.5, null], [3.5, 3, null],      // landing on a key is not crossing it
    [2.5, 7.5, 3],                       // spanning several keys -> the most valuable
    [6.5, 7.5, 7], [3.5, 4.5, 4], [9.5, 10.5, 10], [13.5, 14.5, 14], [16.5, 17.5, 17],
    [1, 2, null], [10.5, 13.5, null],    // no key in between
    [0, 3.5, 3], ['2.5', '3.5', 3],      // a real pick-em, and Postgres numeric-as-string
    // Junk in, null out. Number(null)/Number('')/Number(false) are all 0, which
    // would turn a MISSING line into a pick-em and credit a phantom 3-crossing.
    [null, 3.5, null], [3.5, null, null], [undefined, 3.5, null],
    ['', 3.5, null], [false, 3.5, null], ['x', 3.5, null],
  ];
  const bad = cases.filter(([a, b, want]) => kn.crossedKey(a, b) !== want)
    .map(([a, b, want]) => `${a}->${b} want ${want} got ${kn.crossedKey(a, b)}`);
  ok('crossedKey finds the strictly-between key, highest-value first', bad.length === 0, bad.join('; '));
}
{
  // The spreads-only claim, proven rather than asserted: no NFL/NBA total can
  // cross a football margin key, which is why book-move renormalizes the
  // component away for totals instead of scoring it as a zero.
  const hits = [];
  for (let t = 30; t <= 70; t += 0.5) if (kn.crossedKey(t, t + 1.5) != null) hits.push(t);
  ok('no totals-range move can cross a key number', hits.length === 0, `fired at ${hits.join(', ')}`);
}

// ── 12. Movement baseline persistence ───────────────────────────
// `lastLines` is process-local, so movement detection used to need two
// consecutive fetches by the same process — every redeploy wiped it and the
// next fetch of each key detected nothing (D71). The baseline is now
// rehydrated from our own line_snapshots. Three properties are load-bearing and
// none of them shows up in a passing run: it costs ZERO Odds API credits, the
// read is bounded and rides an index that exists, and a gap wider than the
// bound reseeds instead of emitting a fabricated magnitude.
const oddsSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/odds/index.js'), 'utf8');
const utilsSrc = await readFile(join(root, 'edge-tracker-agents/src/utils/index.js'), 'utf8').catch(() => '');
const envExample = await readFile(join(root, 'edge-tracker-agents/.env.example'), 'utf8').catch(() => '');
// The two consumers of odds' in-memory movement feeds — which one reads which
// key is the invariant, not a detail (D74).
const splitsSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/public-splits/index.js'), 'utf8');
const sharpSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/sharp/index.js'), 'utf8');
const histSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/sharp/history.js'), 'utf8').catch(() => '');
// Comments stripped: both sharp files document WHY they never touch movementsAll.
const sharpCode = codeOnly(sharpSrc) + '\n' + codeOnly(histSrc);
const hydrateFn = (oddsSrc.match(/async function hydrateBaseline[\s\S]*?\n\}\n/) || [''])[0];

ok('the baseline is rehydrated from line_snapshots', /db\.select\('line_snapshots'/.test(hydrateFn),
  'the odds agent already writes those rows every run from odds we have already paid for');
ok('hydration spends nothing — no fetch in its body', !/fetch\(/.test(hydrateFn),
  'the zero-spend property is structural, not a promise; same check as book-move');
ok('the snapshot read matches on game_id AND market',
  /match:\s*\{\s*game_id:[^}]*\bmarket\b[^}]*\}/.test(hydrateFn),
  'without market the line_snapshots_game_idx prefix stops at game_id and Postgres sorts every snapshot row the game ever accumulated');
ok('the read is newest-first and bounded',
  /ascending:\s*false/.test(hydrateFn) && /limit:\s*\w+/.test(hydrateFn),
  'ASC + limit truncates the newest rows; no limit is the unbounded sort this exists to avoid');
ok('hydration never rehydrates by in(game_id, [...])', !/\bin:\s*\{/.test(hydrateFn),
  'ordering across many game_ids cannot use the composite index');
ok('the hydration caps exist', /ODDS_HYDRATE_MAX_GAMES/.test(oddsSrc) && /ODDS_HYDRATE_COLD_MAX/.test(oddsSrc));
ok('the staleness bound defaults to 360 minutes',
  /MOVE_MAX_GAP_MIN\s*=[^;]*ODDS_MOVE_MAX_GAP_MIN[^;]*360/.test(oddsSrc),
  'a line compared across three days conflates an unknown number of moves into one row');
ok('the staleness bound is read so that 0 is honoured',
  /hdrNum\(process\.env\.ODDS_MOVE_MAX_GAP_MIN\)/.test(oddsSrc),
  "`Number('0') || 360` is 360, which defeats the manual check that proves the bound governs");
ok('the emit condition tests the baseline age', /prev\.at/.test(oddsSrc) && /MOVE_MAX_GAP_MIN \* 60_000/.test(oddsSrc));
ok('every baseline entry is stamped', /lastLines\.set\([^)]*at:/.test(oddsSrc),
  'an entry with no age cannot be bounded by anything');
ok('the comparison lives in one exported function', /export function movementFrom/.test(oddsSrc)
  && !/prev\.line !== line/.test(oddsSrc),
  'the old inline comparison in normalize() had no gap guard and no provenance');
ok('baselines are evicted when their game leaves the slate', /lastLines\.delete\(/.test(oddsSrc),
  'the Map was never pruned: ~66 keys per game, ~150 new games a day');
ok('the line_movements insert survives un-run DDL',
  /isMissingColumn\(e\)/.test(oddsSrc) && /extraCols = false/.test(oddsSrc)
  && /gap_min,\s*baseline_source,\s*\.\.\.rest/.test(oddsSrc),
  'PostgREST rejects the WHOLE insert on an unknown column — the D70 failure shape');
ok('only a missing COLUMN latches extraCols off, never a missing table',
  /export function isMissingColumn/.test(oddsSrc) && !/db\.isMissingRelation\(e\)/.test(oddsSrc),
  'isMissingRelation also matches 42P01 — latching on an absent TABLE would keep writing gap_min-less rows once it came back, and the reader rule calls those non-authoritative');
ok('the strip-and-retry leaves no false degradation standing',
  /clearDegraded\('write\|line_movements'\)/.test(oddsSrc),
  'the failed probe already fired reportWriteFailure — unretracted, /data-health calls movement writes broken for 90 min while every row lands');
ok('the baseline counts are reported unconditionally, zeros included',
  /const baselineBit = `baseline \$\{hydr\.games\}\/\$\{hydr\.attempted\}/.test(oddsSrc)
  && /\$\{baselineBit\}/.test(oddsSrc) && /staleBaseline/.test(oddsSrc) && /stale-baseline/.test(oddsSrc),
  'reported only when non-zero, a silent no-op is indistinguishable from the feature working — and keys filled is not the same unit as games hydrated');
ok('a failed hydration read is not recorded as settled',
  /if \(!baselineFailed\.has\(ev\.id\)\) baselineDone\.add/.test(oddsSrc)
  && /if \(failed\) \{ baselineFailed\.add\(gameId\); return; \}/.test(oddsSrc),
  'line_snapshots statement-timeouts (D68); a failure counted as done disables rehydration for that game for the life of the process');
ok('a run that hydrated nothing does not burn the cold allowance',
  /if \(hydr\.attempted > 0 && hydr\.games === 0\) \{\s*\n\s*hydrateFailRuns\+\+;/.test(oddsSrc)
  && /hydrateFailRuns = 0;\s*\n\s*hydratedOnce = true;/.test(oddsSrc),
  'otherwise one timed-out boot read leaves a long-lived process behaving exactly as it did pre-fix, forever');
ok('and "hydrated nothing" includes a run with NOTHING to hydrate',
  /\} else if \(hydr\.games > 0\) \{/.test(oddsSrc),
  'an empty slate, or a run where every game was already settled, fetched and hydrated nothing too — spending the allowance there leaves the first real slate on the steady cap, and clearing the breaker there retracts it with no successful read behind it');
ok('but a PERSISTENT read failure backs off instead of retrying forever',
  /const HYDRATE_FAIL_RUNS = \d+/.test(oddsSrc)
  && /const broken = hydrateFailRuns >= HYDRATE_FAIL_RUNS/.test(oddsSrc)
  && /broken \? HYDRATE_PROBE_GAMES/.test(oddsSrc),
  'not burning the cold allowance means re-spending it every run: 240 timing-out selects before any normalize, on the one table already in distress, with the orchestrator awaiting odds');
ok('the breaker is logged, not silent', /consecutive runs/.test(oddsSrc)
  && /circuit-broken after/.test(oddsSrc),
  'a 5-minute latency spike per run has to be readable in the summary, not inferred');
ok('hydration does not select the hand-migrated last_update column',
  !/fetched_at,last_update/.test(oddsSrc),
  'baselineFromSnapshots never reads it, and PostgREST rejects the WHOLE select on an unknown column — 100% of hydration reads fail where that alter table was never run (D69/D70)');
ok('the steam feed is gap-filtered before it is published',
  /export function steamSafeMovements/.test(oddsSrc)
  && /setIntel\('movements', steamFeed\)/.test(oddsSrc)
  && /const STEAM_MAX_GAP_MIN = Math\.min\(/.test(oddsSrc),
  'sharp reads getIntel(movements) as SIMULTANEITY (3+ books one way = steam), so a rehydrated six-hour drift in that array is published as coordinated money — and flows on into corroborate, public-fade, sharp-divergence and export');
ok('the complete movement feed is published too, under its own key',
  /setIntel\('movementsAll', movements\)/.test(oddsSrc),
  'public-splits asks whether the public\'s own number moved and takes `?? 0`, so a row WITHHELD by the steam filter reads there as a line that did not move — a reverse line move published as a freeze (D74)');
ok('public-splits reads the complete feed, not the steam feed',
  /getIntel\('movementsAll'\)/.test(splitsSrc) && !/getIntel\('movements'\)/.test(splitsSrc),
  'the two consumers ask different questions of the same rows: simultaneity for sharp, did-it-move for public-splits');
ok('sharp still reads the gap-filtered feed',
  /getIntel\('movements'\)/.test(sharpCode) && !/movementsAll/.test(sharpCode),
  'the in-memory feed is merged over history for the window between detection and the insert landing; routing sharp at the complete feed restores the steam corruption #136 fixed — an afternoon of drift at three books republished as coordinated money');

// ── sharp: bounded history reader + the simultaneity test (D92-D94) ──
// The old agent read only the most recent odds run's array and said `no recent
// line movement` for 13,000+ runs. The reader must be BOUNDED (one indexed
// select per game, capped), the test must be INTERSECTION (not a per-row gap
// filter, which at history scale is D77 again), and the empty states must be
// distinguishable from the blind ones — the indistinguishability is what hid
// the bug.
const histFn = (histSrc.match(/export async function readMovementHistory[\s\S]*?\n\}\n/) || [''])[0];
ok('sharp reads bounded history', /db\.select\('line_movements'/.test(histFn) && /match:\s*\{\s*game_id/.test(histFn)
  && /gte:\s*\{\s*detected_at/.test(histFn) && /ascending:\s*false/.test(histFn) && /limit:\s*HIST_ROW_LIMIT/.test(histFn),
  'one select per game riding line_movements_game_idx (game_id, detected_at desc), newest-first, with a limit');
ok('the history read never uses in(game_id, [...])', !/\bin:\s*\{/.test(codeOnly(histSrc)),
  'ordering across many game_ids cannot use the composite index — an unbounded sort on a 530k-row table (D71)');
ok('sharp bounds its slate', /HIST_MAX_GAMES/.test(histSrc) && /\.slice\(0,\s*max\)/.test(histSrc)
  && /selectSlate\(getGames\(\), now, HIST_MAX_GAMES\)/.test(sharpSrc),
  '24 selects per run is the whole query budget; an uncapped slate is 150 on a football Sunday');
ok('steam requires interval intersection', /export function findSteamClusters/.test(histSrc)
  && /lo <= hi/.test(histSrc) && /\$\{r\.direction\}`/.test(histSrc) && /findSteamClusters\(rows/.test(sharpSrc),
  'a per-row gap filter proves each row\'s own baseline was recent, not that three books moved at the same time as each other; direction is in the key, not a post-hoc vote (D58)');
ok('one definition of the simultaneity bound', /import \{ steamSafeMovements \} from '\.\.\/odds\/index\.js'/.test(histSrc)
  && !/\b35\b/.test(histSrc) && /steamSafeMovements\(rows\)/.test(sharpSrc),
  'the bound lives in odds (STEAM_MAX_GAP_MIN, overridable); a restated literal in sharp would drift');
ok('sharp counts null-gap rows', /preFix/.test(histSrc) && /preFix/.test(sharpSrc) && /none carry gap_min/.test(sharpSrc),
  'gap_min null is the pre-fix predicate (D73): never aggregated across, counted and reported — not silently dropped');
ok('sharp distinguishes blind from empty', /blind —/.test(sharpSrc) && /0 movement rows/.test(sharpSrc)
  && /0 simultaneous clusters/.test(sharpSrc) && !/no recent line movement/.test(sharpCode),
  '"nothing moved" and "I cannot see it" rendered the same sentence for 13,000 runs');
ok('sharp never reads the complete feed', !/movementsAll/.test(sharpCode),
  'that feed belongs to public-splits (D74)');
ok('sharp spends nothing', !/\bfetch\s*\(/.test(sharpCode), 'the reader is Postgres only — zero Odds API credits');
ok('a persistent read failure is blocked, not bespoke', /blocked: (streak \? )?BLOCKED_\w+/.test(sharpSrc) && /HIST_FAIL_RUNS/.test(sharpSrc)
  && !/reportDegraded/.test(sharpCode),
  'the orchestrator\'s existing D80 path reports it; a fourth channel would be one more thing to retract');
ok('the history query does not name baseline_source', !/baseline_source/.test(codeOnly(histSrc)),
  'naming a hand-run column in a projection makes PostgREST reject the whole select (D69/D70)');
ok('movementFrom stamps detected_at', /detected_at: new Date\(nowMs\)\.toISOString\(\)/.test(oddsSrc),
  'the in-memory row must carry the same interval the Postgres row does, or the dedupe key is a lie');
ok('sharp runs every 5 minutes', /sharp: \{[^}]*min: 5 \}/.test(await readFile(join(root, 'edge-tracker-agents/src/config/index.js'), 'utf8')),
  'movement only changes when odds fetches; 24 reads/run at 2 min is 720/hour on line_movements');
// Emission and the memory feed are bounded the same way the read is: the
// emitted-set memory evicts with the slate, re-emits only on a GAINED book, and
// a memory row off the slate or outside the window never joins the union.
ok('sharp evicts emission memory with the slate', /if \(!slateIds\.has\(e\.game_id\)\) emitted\.delete\(k\)/.test(sharpSrc),
  'a process-local map keyed on game|market|side|direction grows without bound unless entries leave with the game (D75)');
ok('sharp re-emits only when a cluster gains a book', /entry\.sets\.some\(\(s\) => c\.books\.every\(\(b\) => s\.has\(b\)\)\)/.test(sharpSrc),
  'keying on `hi` wrote a second sharp_signals row naming the same three books on every half-point tick of a live steam');
ok('the memory feed is slate- and window-bounded before the merge', /slateIds\.has\(m\.game_id\) && m\.at >= since/.test(sharpSrc),
  'history is already bounded by the select; a memory row for a game off the slate or older than the window would be an unbounded back door');
ok('the dashboard maps lastResult onto the run it hands the Steam panel', /result:a\.lastResult/.test(html) && /var res=\(run&&run\.result\)\|\|''/.test(html),
  'sigSteamFacts reads run.result; if applyAgentsBag stops mapping /health.lastResult onto it the radar can never fire and every state reads as a zero');
// The two tests that could not be run live on demand: a scripted day through
// the real run() on the 5-minute cadence, and the Steam panel driven with all
// seven summaries plus an old cached payload.
const dayTestSrc = await readFile(join(root, 'edge-tracker-agents/test/sharp-history-day.test.js'), 'utf8').catch(() => '');
ok('sharp is proved across a scripted day', /const RUNS = 72;/.test(dayTestSrc) && /exactly two rows for the whole day/.test(dayTestSrc)
  && /INDEPENDENT oracle/.test(dayTestSrc),
  'the recipe admits a real steam cannot be summoned; the day test is the stand-in and must stay oracle-checked, not reader-checked');
const panelTestSrc = await readFile(join(root, 'edge-tracker-agents/test/sig-steam-panel.test.js'), 'utf8').catch(() => '');
ok('the Steam panel is driven with all seven summaries and the old cached sentence',
  /BLIND = \['noFeed', 'readFailed', 'nullGap'\]/.test(panelTestSrc) && /no recent line movement/.test(panelTestSrc) && /nothing double-escaped/.test(panelTestSrc),
  'the dashboard keys on /^blind —/; a copy edit to any of the seven strings must fail a test, not just read oddly');
ok('the steam bound admits a real mid-tier gap, and is never wider than the emit bound',
  /hdrNum\(process\.env\.ODDS_STEAM_MAX_GAP_MIN\) \?\? 35/.test(oddsSrc)
  && /Math\.min\(\s*\n\s*MOVE_MAX_GAP_MIN,/.test(oddsSrc),
  "MID_MIN is 30 but a real MID gap is 30 + the wake grid (3 min) + the fetch, and gap_min rounds to 1dp — at 30 a refetch 3 seconds late measured 30.1 and was dropped, leaving only strike (4) and near (10). 35 admits MID; a row we refuse to write still cannot be steam");
ok('the steam filter type-checks gap_min before it coerces it',
  /typeof raw !== 'number' && typeof raw !== 'string'/.test(oddsSrc)
  && /gap >= 0 && gap <= STEAM_MAX_GAP_MIN/.test(oddsSrc),
  "Number('  '), Number([]) and Number(false) are all 0 and finite, so any of them would read as a row whose gap is ZERO — the most simultaneous row there is. A negative gap is not a narrow gap either");
ok('hydration does not read h2h', /const BASELINE_MARKETS = \['spreads', 'totals'\]/.test(oddsSrc),
  "h2h outcomes carry no `point`, so every h2h row has a null line and can never produce a baseline entry — book-move's list for the same reason");

ok('schema.sql declares gap_min', /alter table line_movements add column if not exists gap_min/.test(schema));
ok('schema.sql declares baseline_source', /alter table line_movements add column if not exists baseline_source/.test(schema));
ok('schema.sql records what a null gap_min means', /gap_min is null/.test(schema),
  'pre-fix rows are a sample biased by deploy timing — the predicate has to be written down');
// Two assertions the spec asked for are deliberately NOT here, both recorded as
// deviations in docs/specs/persist-movement-baseline.md: "line_movements still
// absent from data-health.js" (data-health has counted it by detected_at since
// 2026-10-17), and a second copy of section 10's `book-move reads snapshots,
// not line_movements` — which stands there, undisturbed, rather than twice.

// ── 13. Blocked-agent reporting ─────────────────────────────────
// `public-splits` returned `skipped — no Claude` with error: null and
// consecutiveFailures: 0 for as long as the deployment had no key, wrote 0 rows
// against 671 total, and read HEALTHY on the watchdog, /data-health and the
// degraded channel alike — because a skip is not a failure. These assertions
// pin the opt-in, the clears, and the one thing that must never happen: a
// credential in a log or a payload.
const weighinSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/combat-weighin/index.js'), 'utf8');
const wdSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/watchdog/index.js'), 'utf8');
const blockedTestSrc = await readFile(join(root, 'edge-tracker-agents/test/agent-blocked.test.js'), 'utf8');

ok('public-splits marks its Claude gate as blocked',
  /if \(!hasClaude\(\)\) return \{[^}]*\bblocked:/.test(splitsSrc),
  'without the field the skip is indistinguishable from an empty slate and nothing reports it — exactly the state that went unnoticed until a /plays payload was read by hand');
ok('combat-weighin marks its Claude gate as blocked',
  /if \(!hasClaude\(\)\) return \{[^}]*\bblocked:/.test(weighinSrc),
  'the only other hasClaude()-gated agent; prop-engine is code-only and nfl-win-totals falls back to a posted table, so these two are the whole opt-in set');

ok('the orchestrator normalises blocked to a string or null',
  /out\.blocked === true \? summary/.test(orchSrc)
  && /typeof out\.blocked === 'string' && out\.blocked\.trim\(\)/.test(orchSrc),
  "`blocked: 1` or `blocked: {}` from a half-written return would otherwise alert with a reason of '1' or '[object Object]'");
ok('the threshold comparison is >=, so blockedRunsMin is the run that REPORTS',
  /r\.consecutiveBlocked >= config\.rules\.blockedRunsMin/.test(orchSrc),
  '`>` makes the default 2 mean "report on the third run" and makes 0 behave exactly like 1 — the off-by-one is invisible in production because nobody counts the runs before the first alert');
ok('blockedSince latches the first run of the streak',
  /if \(!r\.blockedSince\) r\.blockedSince = r\.lastRunAt;/.test(orchSrc),
  'without the guard the detail reads "(7 consecutive runs since <the most recent run>)" — always "now" — destroying the one number a human reads to judge how long the agent has been down');
ok('a change of reason restarts the streak, the clock and the store entry',
  /if \(r\.blockedReason && r\.blockedReason !== blocked\) \{\s*\n\s*r\.consecutiveBlocked = 0;\s*\n\s*r\.blockedSince = null;\s*\n\s*clearDegraded\(blockedKey\);/.test(orchSrc),
  'otherwise an agent blocked once by A then once by B reports "B (2 consecutive runs since <A\'s first run>)" — a count and a start time belonging to a fault that is no longer the problem, which is the opposite of what the temporal filter advertises');
ok('the orchestrator resets AND clearDegradeds on the non-blocked branch',
  /r\.consecutiveBlocked = 0;\s*\n\s*r\.blockedReason = null;\s*\n\s*r\.blockedSince = null;\s*\n\s*clearDegraded\(blockedKey\);/.test(orchSrc),
  'an unretracted reportDegraded latches for the full 90-min TTL and goes on re-alerting an obsolete reason (D73)');
ok('the orchestrator also clears in the catch path',
  /clearDegraded\(`\$\{agent\.name\}\|blocked`\);/.test(orchSrc),
  'the error path owns the reporting from there; a surviving blocked entry double-reports the same agent with a reason that is no longer the problem');
ok('the default threshold is 1 — the first blocked run reports',
  /blockedRunsMin: intEnv\(env\.AGENT_BLOCKED_RUNS_MIN, 1\)/.test(cfgSrc),
  'a blocked return is the agent ASSERTING the condition, and for both opt-ins it is a missing env var that is immutable for the life of the process (hasClaude() ANDs a client built once at module load with a detectModel() called once and never retried) — so a confirming run buys 4h of latency on public-splits and no signal at all');
ok('the threshold is read with intEnv, not num or ||',
  /blockedRunsMin: intEnv\(env\.AGENT_BLOCKED_RUNS_MIN, 1\)/.test(cfgSrc)
  && !/blockedRunsMin: num\(/.test(cfgSrc)
  && !/AGENT_BLOCKED_RUNS_MIN[^)]*\)\s*\|\|/.test(cfgSrc),
  "Number('') is a finite 0, so `num(env.X, 1)` reads an UNSET variable as 0 and `intEnv(env.X, 1) || 1` reads an explicit 0 as 1 — AGENT_BLOCKED_RUNS_MIN=0 is silently ignored either way (D79). The behavioural guard is test/agent-blocked.test.js's child-process read, which this only backs up");
ok('intEnv rejects blank before coercing, and keeps 0',
  /function intEnv\(v, dflt\) \{\s*\n\s*const s = clean\(v\);[\s\S]{0,160}?if \(s === ''\) return dflt;/.test(cfgSrc)
  && /Number\.isInteger\(n\) && n >= 0 \? n : dflt/.test(cfgSrc),
  'the order is the fix: blank-check first, coerce second');
ok('num() itself is untouched', /function num\(v, dflt\) \{\s*\n\s*const n = Number\(v\);\s*\n\s*return Number\.isFinite\(n\) \? n : dflt;/.test(cfgSrc),
  '40+ call sites depend on its current behaviour; intEnv is a sibling, not a replacement');

ok('the degraded key is `${agent.name}|blocked`', /`\$\{agent\.name\}\|blocked`/.test(orchSrc)
  && !/`blocked\|\$\{agent\.name\}`/.test(orchSrc),
  "the watchdog derives the agent from key.split('|')[0], so a `blocked|<agent>` key reports an agent called 'blocked'");
ok('the watchdog gives blocked entries their own type and label',
  /d\.key\.endsWith\('\|blocked'\)/.test(wdSrc) && /type: isBlocked \? 'blocked' : 'data'/.test(wdSrc)
  && /Agent blocked \(\$\{agent\}\)/.test(wdSrc),
  'the shelved signal dashboard filters on type and renders label; "Data integrity (public-splits|blocked)" is the wrong sentence for a missing env var');
ok('the watchdog keeps the data| key prefix for blocked issues', /key: `data\|\$\{d\.key\}`/.test(wdSrc),
  'that string keys the per-day dedup set — renaming it re-alerts every blocked agent once more');

ok('/health carries the durable blocked fields', /blockedRuns: r\.consecutiveBlocked/.test(orchSrc)
  && /blockedReason: r\.blockedReason/.test(orchSrc) && /blockedSince: r\.blockedSince/.test(orchSrc),
  'DEGRADED_TTL_MS is 90 min and public-splits runs every 4h, so the degraded entry flickers out between runs — blockedRuns is the number that never expires');

// The hard constraint of this spec. These are source-text checks over CODE
// ONLY (comments stripped), so documenting the constraint cannot fail the
// build. What they do not cover: a credential arriving through an import, e.g.
// config.anthropic.apiKey, which would pass both greps. That case is pinned
// behaviourally in test/agent-blocked.test.js, which asserts the published
// detail EQUALS a closed template over the agent-authored reason plus two
// numbers — nothing else can be in it — with a sentinel in the environment.
ok('the published reason is a closed template, asserted behaviourally',
  /assert\.equal\(d\.detail,/.test(blockedTestSrc) && /SENTINEL/.test(blockedTestSrc),
  'a source grep cannot see a credential that arrives via an import; the exact-equality assertion on the published detail can');
ok('the reason is authored, never read — no env in the orchestrator',
  !/process\.env\b/.test(codeOnly(orchSrc)),
  'the guarantee that no key value, or prefix of one, can reach a log or a payload is structural: the orchestrator cannot see the variable');
ok('and no credential by any name', !/apiKey/i.test(codeOnly(orchSrc)));
ok('neither opted-in agent interpolates the env value',
  !/process\.env\.ANTHROPIC/.test(codeOnly(splitsSrc)) && !/process\.env\.ANTHROPIC/.test(codeOnly(weighinSrc))
  && /blocked: claudeBlockReason\(\)/.test(splitsSrc)
  && /blocked: claudeBlockReason\(\)/.test(weighinSrc),
  'the reason comes from the shared helper, not an inline string — so there is one place to audit');
// The helper is the single place a credential could enter the reason, so pin its
// shape rather than its wording: exactly two string literals, no template, no
// concatenation, no env or config read. `hasClaude()` ANDs a client against a
// detected model and those fail for different reasons; reporting "not set" for a
// key that IS set sends an operator to `env | grep` and costs them the alert's
// credibility. Wording may change; "cannot carry a value" may not.
{
  const utilsSrc = await readFile(join(root, 'edge-tracker-agents/src/utils/index.js'), 'utf8');
  const body = (utilsSrc.match(/export const claudeBlockReason[\s\S]*?;\n/) || [''])[0];
  ok('claudeBlockReason exists and distinguishes the two causes', body.length > 0
    && /no model was detected/.test(body) && /is not set/.test(body),
    'a key that is set but unusable must not be reported as missing');
  ok('claudeBlockReason cannot carry a value',
    body.length > 0 && !/\$\{/.test(body) && !/\+/.test(body)
    && !/process\.env/.test(body) && !/apiKey/i.test(body),
    'two constant literals only — no template, concatenation, env or config read');
}

// VERIFICATION PASS. The behavioural claim above — "a source grep cannot see a
// credential that arrives via an import, the exact-equality assertion can" —
// was NOT TRUE as first written, and this assertion is what stops it reverting
// to untrue. config.anthropic.apiKey is clean(env.ANTHROPIC_API_KEY) evaluated
// once at config module load, and the test's before() imports config before the
// test body sets its sentinel — so a sentinel written only to process.env
// arrives too late to reach the config object, and a detail built from
// `config.anthropic['api'+'Key']` interpolated the empty string and passed the
// test, both greps here, and the whole suite. Verified by mutation. The fix is
// to seed the LOADED CONFIG's credential fields too; without that line the
// import path — the likeliest one in this codebase, and the only one the greps
// above admit they cannot see — is unguarded.
ok('the credential sentinel is seeded into the loaded config, not just process.env',
  /\[cfg\.anthropic, 'apiKey'\]/.test(blockedTestSrc) && /o\[k\] = SENTINEL/.test(blockedTestSrc),
  "config.anthropic.apiKey is snapshotted at module load, so a process.env-only sentinel is already stale by the time the test runs and a leak through the import reads '' — making the one assertion that covers the import path silently vacuous");
ok('every sink the reason reaches is swept for the sentinel, not just the detail',
  /getWatchdog\(\)/.test(blockedTestSrc) && /orch\.getHealth\(\)\)\.includes\(SENTINEL\)/.test(blockedTestSrc),
  'the detail is one of five sinks — /health, the watchdog issue, reportDegraded, the warn log and blockedReason; asserting only the detail leaves the other four to inference');

// The TTL is the store's, not this feature's, and the two directions of
// wrongness it can produce are a false alarm that outlives the fix and a live
// condition that goes quiet. Both are pinned in their own file because
// DEGRADED_TTL_MS is read once at store load, so a short TTL cannot share a
// process with the timing-insensitive tests.
// Read tolerantly: a bare `await readFile` turns a deleted or renamed test
// file into an ENOENT stack trace that exits before the summary line, which
// reads as "the smoke harness is broken" rather than "this coverage is gone".
// An empty string makes the assertion below fail by name instead.
const ttlTestSrc = await readFile(join(root, 'edge-tracker-agents/test/agent-blocked-ttl.test.js'), 'utf8')
  .catch(() => '');
ok('the blocked × TTL interaction is covered',
  /DEGRADED_TTL_MS/.test(ttlTestSrc) && /re-publishes/.test(ttlTestSrc)
  && /retracts the entry instead of waiting it out/.test(ttlTestSrc),
  'a standing block outlives the 90-min TTL on a 4h agent, so the entry must re-publish on the next run (or the condition goes permanently silent) and must be retracted on recovery rather than left to age out (D73)');
ok('both opted-in agents are driven on BOTH sides of their gate',
  /with no key, both opted-in agents produce the blocked condition end to end/.test(blockedTestSrc)
  && /with the key present, both agents stop reporting and the entry is retracted/.test(blockedTestSrc),
  'the rest of the suite runs stub agents; without these two the only coverage of the real opt-ins is the source grep above, which cannot tell whether the field is reachable or whether it disappears once the key is present');
ok('the opt-in set is asserted against the wired fleet, not just the opted-in files',
  /exactly the agents the specs opted in/.test(blockedTestSrc)
  && /OPTED_IN_ELSEWHERE = \['nfl-line-move'\]/.test(blockedTestSrc)
  && /\[\.\.\.OPTED_IN, \.\.\.OPTED_IN_ELSEWHERE, 'sharp'\]\.sort\(\)/.test(blockedTestSrc),
  '~60 of the ~70 skip sites are benign and must stay silent; an unlisted opt-in is a policy change and notifyAll reaching zero recipients means false positives are the one cost this design cannot absorb. The set is the two Claude-gated agents, nfl-line-move (D95) and sharp (D94).');

// Pins the explicit decision, not an oversight: `public_splits: {today: 0}` is
// equally true on an offseason morning and during a budget pause, so a
// table-level probe cannot tell "broken" from "nothing to do" without the
// per-agent knowledge `blocked` already carries.
// Comments stripped: forbidding the substring in prose would mean a comment in
// data-health.js EXPLAINING why no probe was added there fails the build.
ok('/data-health gained no blocked-agent probe', !/blocked/i.test(codeOnly(dataHealth)),
  'the table count belongs in the diagnosis step after an alert, not in detection — a fourth mechanism was deliberately not built');

// ── 14. Signal dashboard (📡 Signal home tab) ────────────────────
// A tab has to be registered in SEVEN places. Missing any of the five display
// sites gives a launcher tile that renders nothing, or dots/swipe that disagree
// with the sections that exist; missing either of the two loadAgentsData sites
// gives a tile that paints once from cache and then never updates — or worse,
// one whose live refresh repaints the AGENTS tab over it. Each is its own
// assertion so a failure names the site.
const SIGNAL_SPEC = 'awaiting the signal dashboard (docs/specs/signal-dashboard.md)';
const hasSignal = /function\s+renderSignalContent\s*\(/.test(html);
if (!hasSignal) {
  skipAll([
    'HOME_TABS has a signal tile', 'renderHomeScreen dispatches signal',
    'renderSignalView is defined', 'pagedots _ord includes signal',
    'swipe order includes signal', 'loadAgentsData onView includes signal',
    'loadAgentsData rerender includes signal', 'signal block found',
    'no second /plays fetch', 'every empty state has distinct copy',
    'vs_public is never rendered as 0%', 'per-source status is recorded',
    'sigSrc is not persisted into etBagCache', 'backward compatible field access',
    'wide tables scroll in their own container', 'no charting dependency',
    "empty state 'loading' has its own copy", "empty state 'nodata' has its own copy",
    "empty state 'stale' has its own copy", "empty state 'off' has its own copy",
    "empty state 'failed' has its own copy", "the five states' copy lives in sigBanner",
    'the episode card is not duplicated', 'the data-health labels are shared, not copied',
    '/plays serves sharp', '/budget publishes ceilings',
    'the ceilings payload is covered by a test',
    'JetBrains Mono rides the existing fonts link', 'the Signal view paints under one root',
    'HUD atmosphere and chamfers are scoped to the Signal root', 'every HUD rule is under the Signal root',
    'prefers-reduced-motion guards the sweep', 'chip sub-status falls back to a dash',
  ], SIGNAL_SPEC);
} else {

ok('HOME_TABS has a signal tile', /HOME_TABS[\s\S]{0,900}?id:\s*'signal'/.test(html));
ok('renderHomeScreen dispatches signal', /homeTab===['"]signal['"]\s*\)\s*renderSignalView\(\)/.test(html));
ok('renderSignalView is defined', /function\s+renderSignalView\s*\(/.test(html));
ok('pagedots _ord includes signal', /_ord\s*=\s*\[[^\]]*'signal'/.test(html));
ok('swipe order includes signal', /\border\s*=\s*\[[^\]]*'signal'/.test(html));
// The two the spec flags as silent failures: both live inside loadAgentsData,
// and neither shows up as an error — the tab just stops being live.
ok('loadAgentsData onView includes signal', /onView\s*=[\s\S]{0,300}?homeTab===['"]signal['"]/.test(html),
  'without it the live refresh never repaints the dashboard, so it shows the cached bag forever');
ok('loadAgentsData rerender includes signal', /rerender\s*=[\s\S]{0,400}?homeTab===['"]signal['"]\s*\)\s*renderSignalContent\(\)/.test(html),
  "and it must come FIRST in the chain: 'signal' is not 'rec', so the else-arm would repaint the Agents tab into #sport-selector instead");

const sigBlock = html.slice(html.indexOf('function renderSignalContent'), html.indexOf('function agentPlayKey'));

// The Steam radar keys on the agent SAYING it cannot see, not on a sentence
// that no longer exists: `/no recent line movement/` would read NOT FIRING
// forever once sharp stopped emitting it.
const steamFactsFn = (sigBlock.match(/function sigSteamFacts\(\)\{[\s\S]*?\n\}/) || [''])[0];
ok('the Steam radar keys on blind', /notFiring:\/\^blind —\/\.test\(res\)/.test(steamFactsFn)
  && !/no recent line movement/.test(sigBlock),
  'the radar means "the agent says it cannot see", and every one of those summaries starts "blind —"');
ok('the Steam stale bound follows the 5-min cadence', /sharp:600000/.test(html) && /20m \(2× the sharp agent/.test(sigBlock),
  'AGENT_STALE_MS.sharp at 300000 flags a 5-min agent stale between runs, and the banner copy must say the bound it uses');
ok('the NOT FIRING banner quotes the agent, escaped once', /NOT FIRING — the sharp agent reports "'\+res\+'"/.test(sigBlock)
  && !/reports "'\+esc\(res\)/.test(sigBlock),
  'the blind reason is the agent\'s own line, not a fixed sentence about a deleted string; sigBanner escapes the whole text, so a pre-escaped res would render &amp;quot;');
ok('signal block found', sigBlock.length > 2000, `${sigBlock.length} chars`);

// The whole design premise: the dashboard reads the bag the Agents tab already
// fetched. One `fetch(` here is a second 1.36MB /plays download per tab switch.
ok('no second /plays fetch', !/fetch\(/.test(sigBlock),
  'the dashboard must read state.agents* from the existing one-shot bag, never fetch its own');

// Five states, five different sentences. If any two collapse into the same
// words, "nothing happened" and "I cannot see it" are indistinguishable again —
// which is the failure that hid the sharp bug for 13,000+ runs.
for (const [state_, copy] of [
  ['loading', 'Loading —'], ['nodata', 'Feed answered.'], ['stale', 'older than'],
  ['off', 'NOT FIRING'], ['failed', 'Read failed —'],
]) ok(`empty state '${state_}' has its own copy`, sigBlock.includes(copy), `missing: ${copy}`);
ok('every empty state has distinct copy',
  ['Loading —', 'Feed answered.', 'older than', 'NOT FIRING', 'Read failed —'].every((c) => sigBlock.includes(c)));
// All five live in sigBanner, not scattered across the panels, so no panel can
// quietly substitute a gentler phrasing of its own.
const bannerFn = (sigBlock.match(/function sigBanner\(kind,o\)\{[\s\S]*?\n\}/) || [''])[0];
ok('the five states\' copy lives in sigBanner',
  ['Loading —', 'Feed answered.', 'older than', 'NOT FIRING', 'Read failed —'].every((c) => bannerFn.includes(c)),
  'a panel-local rewording is how one of these five stops being distinguishable from the others');

// vs_public_pct is null (not 0) for every book because public_splits has no
// rows. `|| 0` anywhere on that path turns "we cannot measure this" into "this
// measured zero" — the single most load-bearing distinction on the screen.
ok('vs_public is never rendered as 0%',
  /vs_public_n/.test(sigBlock) && /vs_public_pct!=null/.test(sigBlock)
  && !/vs_public_pct\s*\|\|\s*0/.test(sigBlock),
  'a null against-public percentage must render as — with the UNAVAILABLE banner, never as 0%');

// Each backend fetch ends `.catch(() => ({}))` and applyAgentsBag guards every
// assignment with `if (bag.X)`, so a failed read silently preserves the stale
// value. Key presence in `bag`, recorded before applyAgentsBag runs, is the
// only thing that can tell a failure from a success.
const loaderFn = (html.match(/function loadAgentsData\(\)[\s\S]*?\n\}\n/) || [''])[0];
ok('per-source status is recorded', /state\.sigSrc/.test(loaderFn)
  && /applyAgentsBag\(bag\)/.test(loaderFn)
  && loaderFn.indexOf('state.sigSrc') < loaderFn.indexOf('applyAgentsBag(bag)'),
  'sigSrc must be written from key presence in `bag` BEFORE applyAgentsBag consumes it');
// A cached ok:true is a claim about a refresh that has not happened yet.
ok('sigSrc is not persisted into etBagCache',
  !/bag\.sigSrc|sigSrc:/.test(loaderFn) && /etBagCache/.test(loaderFn),
  'sigSrc describes the LAST refresh, so replaying it out of localStorage would assert a successful read that never happened');

// hydrateAgentsCache replays an OLD etBagCache bag into this new code, so any
// field added since a user's last visit is simply absent. This repo has shipped
// bugs from exactly that.
ok('backward compatible field access',
  !/state\.agents\w+\.(length|forEach|map|slice)\b/.test(sigBlock),
  'every state.agents* read must go through (x||[]) — an old cached bag has none of these fields');

ok('wide tables scroll in their own container',
  /\.sigtbl-wrap\{[^}]*overflow-x:\s*auto/.test(html) && /sigtbl-wrap/.test(sigBlock),
  'at 375px the 8-column book table is wider than the viewport by design; the wrapper must scroll so the PAGE never does');

// Comments stripped: the comment that documents sigSpark mentions <svg>, and
// forbidding the substring in prose would fail the build for the explanation.
ok('no charting dependency', (codeOnly(sigBlock).match(/<svg/g) || []).length === 1,
  'the only graphic is the hand-rolled sigSpark polyline — no build step exists to carry a chart library');

ok('the episode card is not duplicated',
  /function\s+sigEpisodeCard\s*\(/.test(html)
  && /\(bm\.live\|\|\[\]\)\.slice\(0,\s*20\)\.forEach\(function\(m\)\{h\+=sigEpisodeCard\(m\);\}\)/.test(html),
  "renderAgentsContent's book-movement block must CALL the helper, not keep its own copy of the markup");
ok('the data-health labels are shared, not copied',
  /^var DH_LBL=/m.test(html) && (html.match(/DH_LBL\[/g) || []).length >= 2,
  'the Health panel and renderDataHealth render the same table list; two copies is two things to forget when a table is added');

// Backend: both fields are additive, and both are the only way the data becomes
// reachable from a client at all.
ok('/plays serves sharp', /sharp:\s*getIntel\('sharp'\)/.test(server),
  "setIntel('sharp', …) is written on every run and was exposed by no endpoint");
ok('/budget publishes ceilings',
  /getOddsCeilings\(\)/.test(server) && /export function getOddsCeilings/.test(oddsSrc),
  'currentCeiling() is module-private, so "3 budget-skips" in the run summary had no reachable explanation');
const ceilTestSrc = await readFile(join(root, 'edge-tracker-agents/test/odds-ceilings-payload.test.js'), 'utf8')
  .catch(() => '');
ok('the ceilings payload is covered by a test',
  /getOddsCeilings/.test(ceilTestSrc) && /POOL fraction/.test(ceilTestSrc) && /denom is null/.test(ceilTestSrc),
  "D61's crossover is the live hazard: sportCap() sums to the entire month, and `denom: null` is a different claim from \"every sport\" (D65)");

// ── 14b. The mission-control skin ────────────────────────────────
// Blake uses the rest of the PWA on his phone every day, so the HUD is a
// property of the Signal view's root (.sighud), never of body: the grid, the
// scanline overlay and the chamfered corners must all hang off that one class.
const fontLinks = html.match(/<link[^>]*fonts\.googleapis\.com[^>]*>/g) || [];
ok('JetBrains Mono rides the existing fonts link',
  fontLinks.length === 1 && /JetBrains\+Mono/.test(fontLinks[0]) && /Courier\+Prime/.test(fontLinks[0]) && /Rajdhani/.test(fontLinks[0]),
  'one stylesheet <link> carries all three faces — a second link is a second render-blocking request, and a <script> would trip the no-src rule');
ok('the Signal view paints under one root', /class="sighud"/.test(sigBlock),
  'every HUD rule is prefixed .sighud, so the markup has to open that root or nothing is styled');
const css = ((html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1]).replace(/\/\*[\s\S]*?\*\//g, '');
// Flat rule list; @media wrappers fall away because `[^{}]+` cannot cross a brace.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
const leaked = rules.filter(([sel, body]) =>
  (/clip-path:/.test(body) || /background-size:\s*28px 28px/.test(body)) && !/^\.sighud\b/.test(sel));
ok('HUD atmosphere and chamfers are scoped to the Signal root',
  leaked.length === 0 && rules.some(([sel, body]) => sel === '.sighud::after' && /repeating-linear-gradient/.test(body))
  && !rules.some(([sel, body]) => /^body\b/.test(sel) && /28px 28px/.test(body)),
  leaked.length ? `leaked: ${leaked.map(([sel]) => sel).join(', ')}` : 'the scanline overlay must be .sighud::after, not body::after');
const unscoped = rules.filter(([sel]) => /\.(sh-|sigep)/.test(sel) && !/^\.sighud\b/.test(sel));
ok('every HUD rule is under the Signal root', unscoped.length === 0,
  unscoped.length ? `unscoped: ${unscoped.map(([sel]) => sel).join(', ')}` : '');
ok('prefers-reduced-motion guards the sweep',
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.sighud \.sh-sweep[^}]*animation:\s*none/.test(css)
  && /\.sighud \.sh-sweep\{[^}]*animation:/.test(css),
  'the radar sweep and the pulse dot must stop for a reduced-motion viewer');
// A chip whose panel has nothing to say shows a dash — never a number.
ok('chip sub-status falls back to a dash',
  /function sigChipStatus\(/.test(sigBlock) && /c\.txt\|\|'—'/.test(sigBlock) && !/txt:\s*['"]0['"]\s*,/.test(sigBlock),
  'a sub-status with no data behind it is —, not a fabricated 0');

}

// ── 15. Derived seasonality for the ceiling denominator ──────────
// A per-sport ceiling is `budget x POOL x share / sumAlloc`, summed over the
// sports IN THE DENOMINATOR — so membership is worth as much as the shares, and
// it used to be decided by today's board plus a hand-coded football month range.
// Four properties are load-bearing and none of them shows up in a passing run:
// the signal costs NOTHING, release is asymmetric with entry, spend no longer
// holds a dead share, and the decision is observable.
const seasonFns = (oddsSrc.match(/export function seasonVerdicts[\s\S]*?\n\}\n/) || [''])[0]
  + (oddsSrc.match(/export function seasonDenominator[\s\S]*?\n\}\n/) || [''])[0];

ok('the season rules are exported as pure functions',
  /export function seasonVerdicts\(activeKeys, state, sports, now, graceDays, footballOn\)/.test(oddsSrc)
  && /export function seasonDenominator\(/.test(oddsSrc),
  'a season boundary cannot be summoned live, so `now` and the feed must both be parameters');
ok('the season path spends nothing — no fetch in it', seasonFns.length > 0 && !/fetch\(/.test(seasonFns),
  'the signal is the /sports call inSeasonKeys ALREADY makes every run (free, unbilled); zero-spend is structural, not a promise');
ok('the only season input is the free /sports read',
  /seasonVerdicts\(\s*\n?\s*active,/.test(oddsSrc) && /const active = await inSeasonKeys\(\)/.test(oddsSrc)
  && (codeOnly(oddsSrc).match(/\/sports\/\$\{sportKey\}\/odds|\/sports\?apiKey/g) || []).length === 2,
  'a new per-sport endpoint per run is the alternative this deliberately did not take');
ok('entry is immediate and release is graced — the asymmetry is explicit',
  /entry\.quiet <= graceDays/.test(oddsSrc) && /reason = 'active-now'/.test(oddsSrc)
  && /const graceDays = \(\) => oddsApi\.seasonGraceDays \?\? 14;/.test(oddsSrc),
  'symmetric membership IS the September bug (D6): football leaves on a Tuesday and every other ceiling inflates');
ok('the release clock counts OBSERVATIONS, not calendar days',
  /quiet: countedToday \? prevQuiet : prevQuiet \+ 1/.test(seasonFns)
  && /quiet: 0, obs: today/.test(seasonFns)
  && /entry\.quiet <= graceDays \|\| idle < graceDays/.test(seasonFns),
  'a calendar clock cannot tell an outage from a season ending: the month exhausts around day 13 at measured demand (D87), so ~17 unwatched days would age every sport out and release the table on ONE observation — D6 by another road');
ok('the season is observed BEFORE the budget-exhausted return',
  /const active = await inSeasonKeys\(\)[\s\S]*?if \(budget\.remaining <= 0\) \{/.test(oddsSrc)
  && /if \(budget\.remaining <= 0\) \{[\s\S]{0,400}?await persistBudget\(\);/.test(oddsSrc),
  '/sports is free, so an exhausted month is no reason to stop watching — and the observation is persisted or it never happened');
ok('an unreadable OR EMPTY feed writes no stamp',
  /const readable = !!activeKeys && activeKeys\.size > 0;/.test(seasonFns)
  && /if \(!readable\) \{[\s\S]{0,400}?continue;/.test(seasonFns)
  && !/if \(!readable\)[\s\S]{0,400}?nextState\[sport\]/.test(seasonFns)
  && /return keys\.size \? keys : null;/.test(oddsSrc),
  'refreshing `last` on a dead feed extends a dead season forever on a flaky network — and an empty Set is TRUTHY, so a 200 carrying [] used to walk past the fail-safe as proof that nothing is in season');
ok('both stamps are judged before the row is trusted',
  /const lastOk = !!prev && \(prev\.last == null \|\| DAY_RE\.test\(prev\.last\)\);/.test(seasonFns)
  && /const seeded = firstOk && lastOk;/.test(seasonFns),
  "a half-written row ({first: '2026-09-06', last: '2026-11'}) took the seeded branch, dropped the unparseable `last`, and dated the release clock from `first` — releasing every quiet sport in one run");
ok('the denominator cannot collapse',
  /const MIN_SUM_ALLOC = 0\.15;/.test(oddsSrc) && /const MAX_SPORT_POOL = 0\.6;/.test(oddsSrc)
  && /Math\.max\(MIN_SUM_ALLOC, raw \|\| 1\)/.test(oddsSrc)
  && /Math\.min\(share, MAX_SPORT_POOL\)/.test(oddsSrc),
  "gating `billed` by the season verdict made the degenerate case currentCeiling's own comment forbids REACHABLE: a thin /sports board listing one league would price it at the entire pool and, being active, let it spend it");
ok('a failing sentinel write becomes loud',
  /seasonWriteFailRuns\+\+/.test(oddsSrc) && /reportDegraded\(SEASON_WRITE_KEY, detail\)/.test(oddsSrc)
  && /clearDegraded\(SEASON_WRITE_KEY\)/.test(oddsSrc),
  'the only symptom of a dead sentinel row is /budget reading `seeding (Nd left)` — which manual check 5 tells the operator to EXPECT on day 1, so an RLS change would disable the feature and look like a clean deploy (#137 shape)');
ok('spend no longer holds a released share', /!inDenom && !v\.out && \(bySport \|\| \{\}\)\[sport\] > 0/.test(oddsSrc),
  '`billed` alone put any sport with ONE credit into the denominator for the rest of the month and never took it out (D86)');
ok('the football month range survives as a backstop',
  /if \(!inSeason && footballOn && football\.includes\(sport\)\) \{/.test(oddsSrc)
  && /reason = 'football-backstop'/.test(oddsSrc),
  "D6's mechanism 1 is generalised, not dropped — it only ever holds a sport IN, which is the tight direction");
ok('the football spend FLOOR is untouched',
  /const footballFloor = footballOn/.test(oddsSrc) && /capOf\(s\) - \(budget\.bySport\[s\] \|\| 0\)/.test(oddsSrc),
  'mechanism 2 is a separately measured protection (D6) and a share-shape question, not a seasonality one');
ok('sportCap is deleted, not merely unused', !/function sportCap/.test(oddsSrc),
  'it handed a RELEASED sport a LOOSER ceiling for being out of season; deleting it closes the D61/D64 reintroduction surface');
ok('a sport outside the denominator is still normalised',
  /nominalCap\(sport, denom\.includes\(sport\) \? denom : \[\.\.\.denom, sport\]\)/.test(oddsSrc),
  'the D65 branch-2 shape — the only remaining fallback');
ok('the season state rides a sentinel api_usage row, with no DDL',
  /provider: 'odds-season', month: 'state'/.test(oddsSrc) && /\.\.\.SEASON_ROW/.test(oddsSrc),
  'hand-applied DDL in this repo has a history of shipping unapplied (D69/D70)');
ok('the sentinel write cannot cost us the month row',
  /}, 'provider,month'\);\s*\} catch \(e\) \{ \/\* ignore \*\/ \}\s*(\/\/[^\n]*\n\s*)*try \{/.test(oddsSrc),
  'one upsert per row, separate try/catch, credit counter first');
ok('/budget publishes the denominator decision, not just its membership',
  /sumAlloc:/.test(oddsSrc) && /graceDays: graceDays\(\)/.test(oddsSrc) && /\n    season,\n/.test(oddsSrc),
  'the live denominator was unknowable from /budget, which is why November had to be modelled (D88)');
ok('the grace is read so that 0 is honoured',
  /ODDS_SEASON_GRACE_DAYS, 14\)/.test(cfgSrc) && /intEnv\(env\.ODDS_SEASON_GRACE_DAYS/.test(cfgSrc),
  "`Number(x) || 14` turns the operator's 0 back into 14 (D80) — and 0 is how a boundary is summoned on demand");
ok('the grace has a production FLOOR, and the pure rules do not',
  /const SEASON_GRACE_FLOOR = 7;/.test(cfgSrc)
  && /Math\.max\(SEASON_GRACE_FLOOR, intEnv\(env\.ODDS_SEASON_GRACE_DAYS, 14\)\)/.test(cfgSrc)
  && !/SEASON_GRACE_FLOOR/.test(oddsSrc),
  'one unbounded env integer was the whole distance between this feature and the September shape: ODDS_SEASON_GRACE_DAYS=1 releases every quiet sport on the next run. The floor belongs in config, not in seasonVerdicts, whose graceDays argument must stay drivable at 0 for the boundary tests');
ok('ODDS_SEASON_GRACE_DAYS is documented where the operator looks',
  /ODDS_SEASON_GRACE_DAYS/.test(envExample) && /ODDS_ALLOC_/.test(envExample),
  'it lived only in code comments and DECISIONS.md, so the one knob that can recreate D6 was invisible to whoever sets the env');
const seasonTests = await Promise.all([
  readFile(join(root, 'edge-tracker-agents/test/odds-season-state.test.js'), 'utf8').catch(() => ''),
  readFile(join(root, 'edge-tracker-agents/test/odds-season-denominator.test.js'), 'utf8').catch(() => ''),
]).then((a) => a.join('\n'));
ok('both directions of the asymmetry are tested, through run() as well as pure',
  /graceDays = 0 releases/.test(seasonTests) && /release lands at exactly graceDays \+ 1/.test(seasonTests)
  && /mod\.default\.run\(\)/.test(seasonTests) && /unreadable/.test(seasonTests),
  'entry, release, the boundary itself and the fail-safe each have to be driven, not asserted in prose');
ok('the outage, the empty board and the collapse are tested too',
  /an unobserved stretch cannot age a sport out/.test(seasonTests)
  && /an EMPTY active set is not a board/.test(seasonTests)
  && /a one-sport denominator cannot be priced at the whole pool/.test(seasonTests)
  && /a half-written row reseeds/.test(seasonTests),
  'each of these four was a path to the September shape, so each needs a test that FAILS when the guard is reverted (D21)');
ok('the pool bound is pinned to computed ceilings, not to an identity',
  /every in-denominator ceiling equals its independently-computed share/.test(seasonTests)
  && !/and not vacuously small/.test(seasonTests),
  "`Sum floor(B x POOL x share_i / sumAlloc) <= B x POOL` is true of ANY denominator by construction — it would have passed unchanged under a mutation that released every sport, which is the one thing it was there to catch");

// ── 15b. The season boundary, simulated — and the guards driven together ──
// The spec concedes the live proof arrives months apart (MLB ~19 Nov, football
// after the Super Bowl). The suite therefore carries a whole simulated season
// through the real run() on a replaced clock, plus the three guards (observation
// counter, denominator bounds, empty-board fail-safe) driven in SEQUENCE rather
// than one at a time. These pin that the coverage exists and keeps its shape.
const seasonSim = await readFile(join(root, 'edge-tracker-agents/test/odds-season-simulation.test.js'), 'utf8').catch(() => '');
const seasonGuards = await readFile(join(root, 'edge-tracker-agents/test/odds-season-guards.test.js'), 'utf8').catch(() => '');
ok('a full season is simulated through run() on a replaced clock',
  /class FakeDate extends RealDate/.test(seasonSim) && /global\.Date = FakeDate/.test(seasonSim)
  && /global\.Date = RealDate/.test(seasonSim) && /mod\.default\.run\(\)/.test(seasonSim),
  'the agent reads `new Date()` itself, so the only deterministic season boundary is a clock the test owns — and one it restores');
ok('the simulation covers the outage, the exhausted month, two rollovers and a restart',
  /OUTAGE_FROM/.test(seasonSim) && /budget exhausted/.test(seasonSim) && /2027-01-01/.test(seasonSim)
  && /\?restart=/.test(seasonSim) && /NOT aged out by the outage/.test(seasonSim),
  'each of these is a way a calendar clock would have released the whole table on one observation (D6 by another road)');
ok('the simulation is checked against an independent oracle, every sport every day',
  /function oracleStep/.test(seasonSim) && /assert\.deepEqual\(s\.denom, s\.oracle/.test(seasonSim),
  'hand-picked checkpoints only catch what was anticipated; the oracle is the spec sentence re-implemented without the row bookkeeping');
ok('NFL is asserted in on every day of its season, by grace and never by the backstop',
  /never by the backstop/.test(seasonSim) && /assert\.notEqual\(s\.season\.NFL\.reason, 'football-backstop'/.test(seasonSim),
  'absent ~4 days in 7 is the exact shape the September bug released; grace alone must hold it or the backstop is load-bearing');
ok('the guards are driven in sequence: partial board, empty board across a rollover, a mid-window blip, a corrupt row',
  /partial board for eight days/i.test(seasonGuards) && /straddling Nov 1/.test(seasonGuards)
  && /appears for one day mid-window/.test(seasonGuards) && /corrupted sentinel row/.test(seasonGuards),
  'each guard landed in its own pass; only a sequence shows whether they wedge, flap or strand together');
ok('flapping is asserted away: alternating presence, alternating readability, twenty runs a day',
  /alternates day by day/.test(seasonGuards) && /alternates readable\/unreadable/.test(seasonGuards)
  && /twenty runs a day/.test(seasonGuards) && /flipsOf/.test(seasonGuards),
  'every flip moves every other ceiling, so the denominator must move only as often as a season does');
ok('the released sport cannot spend, and spend accounting is pinned to 3 credits per call',
  /never accrues spend/.test(seasonSim) && /callsToday\.length \* 3/.test(seasonSim)
  && /used must equal the sum of bySport/.test(seasonSim),
  'the billed gate is the whole fix; the accounting beneath it must be unchanged by it');
ok('every api_usage read in the agents is provider-scoped',
  (() => {
    const reads = (oddsSrc + utilsSrc).match(/db\.select\('api_usage'[^\n]*/g) || [];
    return reads.length >= 3 && reads.every((r) => /provider/.test(r) || /SEASON_ROW/.test(r));
  })(),
  'the sentinel shares the table with the odds month row and the claude row — an unscoped read would render whichever landed last');

if (hasSignal) {
  ok('the PWA reads only the ODDS api_usage row',
    /api_usage\?select=\*&provider=eq\.odds/.test(html),
    'the same table carries provider: claude rows, and now odds-season too — an unfiltered order-by-updated_at read renders whichever landed last as odds usage');
  ok('the Budget panel names WHY each sport is in or out',
    /season=b\.season\|\|null/.test(html) && /sn\?sn\.reason:/.test(html) && /released \('\+esc\(rel\.join/.test(html),
    'membership alone leaves the reader inferring the decision from a share table — exactly how D86 had to be diagnosed');
  ok('the pre-deploy off banner still works',
    /if\(!cl\)tb\+=sigBanner\('off',\{text:'Ceilings unavailable/.test(html),
    'a backend that publishes neither ceilings nor season must still render');
} else {
  skipAll(['the PWA reads only the ODDS api_usage row',
    'the Budget panel names WHY each sport is in or out',
    'the pre-deploy off banner still works'], SIGNAL_SPEC);
}

// ── 16. Open→close for all sports (nfl-line-move, D95) ──────────
// The agent kept its NFL name on purpose (run history, the durable blocked
// fields on /health and INTERVAL_NFL_LINE_MOVE all key on it), so the name is
// no longer evidence of scope. What is: no NFL gate, no fetch(, no read of a
// movement table, and the two blocked reasons as constant literals. Feature-
// detect on `bySport` in the agent so this stays green on a `main` without it.
const LINE_MOVE_SPEC = 'awaiting open→close for all sports (docs/specs/line-move-all-sports.md)';
const lmSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/nfl-line-move/index.js'), 'utf8').catch(() => '');
const lmCode = codeOnly(lmSrc);
const hasAllSports = /bySport/.test(lmSrc);
if (!hasAllSports) {
  skipAll([
    'line-move spends nothing', 'line-move is not NFL-gated', 'line-move does not read movement tables',
    'line-move does not import the odds agent', 'line-move blocked reasons are constant literals',
    'line-move has no bare Number( on possibly-absent values', 'line-move name unchanged everywhere',
    'line-move openers are chunked', 'line-move history read is bounded',
    '/plays serves lineMove at top level', '/plays keeps nflPrep.lineMove',
    'Signal has a close panel', 'the Close panel reads bySport defensively',
    'NFL Prep filters line moves to NFL', 'line-move unit coverage exists', 'the schema block is in schema.sql',
  ], LINE_MOVE_SPEC);
} else {
  ok('line-move spends nothing', !/\bfetch\s*\(/.test(lmCode), 'no Odds API call may appear in this agent');
ok('the schema latch rides every exit of nfl-line-move, not only the main return',
  (lmSrc.match(/withLatch\(/g) || []).length >= 4 && !/return \{ summary: 'skipped — no DB' \}/.test(lmSrc) && !/return \{ summary: 'dormant — empty slate' \}/.test(lmSrc),
  'an early return without `blocked` reads as recovery to the orchestrator and re-fires the watchdog next run');
  ok('line-move is not NFL-gated', !/sport\s*===\s*['"]NFL['"]/.test(lmCode),
    'the sports come from the slate; an NFL gate re-added here would silently darken 11 sports');
  ok('line-move does not read movement tables', !/line_snapshots|line_movements|getIntel\(/.test(lmCode),
    'open→close is openers vs consensus; the 7M-row snapshot table answers a different question');
  ok('line-move does not import the odds agent', !/agents\/odds\/|espn-odds/.test(lmCode),
    'the season table rides in agents/odds; importing it defeats the zero-spend guarantee');
  ok('line-move blocked reasons are constant literals',
    /const OPENERS_BLOCKED = '[^'$]+';/.test(lmCode) && /const SCHEMA_BLOCKED = '[^'$]+';/.test(lmCode)
    && !/BLOCKED = `/.test(lmCode),
    'an interpolated count in the reason makes blockedReason change every run (D80)');
  ok('line-move has no bare Number( on possibly-absent values', !/Number\((o|h|g|r|m)\./.test(lmCode),
    'Number(null) === 0 turns a missing line into a counted 0 move');
  ok('line-move name unchanged everywhere',
    /name: 'nfl-line-move'/.test(lmSrc) && /'nfl-line-move':\s*\{/.test(cfgSrc)
    && /\{name:'nfl-line-move'/.test(html) && /'nfl-line-move':\d+/.test(html),
    'renaming orphans scan_runs history, the blocked fields on /health, the PWA roster and INTERVAL_NFL_LINE_MOVE');
  ok('line-move openers are chunked', /OPENERS_CHUNK = 100/.test(lmCode) && /ids\.slice\(i, i \+ OPENERS_CHUNK\)/.test(lmCode),
    'a 300-game Saturday in one `in:` builds an over-long PostgREST URL');
  ok('line-move history read is bounded',
    /gte: \{ captured_at:/.test(lmCode) && /ascending: false/.test(lmCode) && /HISTORY_LIMIT = 4000/.test(lmCode),
    'one bounded query grouped in JS, not one per sport');
  ok('/plays serves lineMove at top level', /\}, lineMove: getNflLineMove\(\),/.test(server));
  ok('/plays keeps nflPrep.lineMove', /nflPrep: \{[^}]*lineMove: getNflLineMove\(\)/.test(server),
    'an old cached client still reads nflPrep.lineMove');
  if (hasSignal) {
    ok('Signal has a close panel',
      /SIG_PANELS=\[[^\]]*\{id:'close',label:'Close'\}/.test(html) && /function renderSigClose\(/.test(html)
      && /v==='close'\)h\+=renderSigClose\(\)/.test(html) && /function sigCloseFacts\(/.test(html) && /out\.close=/.test(html),
      'panel, facts, chip and dispatch are four separate sites');
    ok('the Close panel reads bySport defensively', /\(lm&&lm\.bySport\)\|\|\[\]/.test(html) && /SIG_CLOSE_BOUND/.test(html),
      'an etBagCache replay has no bySport');
  } else skipAll(['Signal has a close panel', 'the Close panel reads bySport defensively'], SIGNAL_SPEC);
  ok('NFL Prep filters line moves to NFL', /g\.sport==='NFL'\|\|g\.sport==null/.test(html),
    'the 📐 block is on the NFL Prep page; legacy cached rows have no sport');
  const lmTest = await readFile(join(root, 'edge-tracker-agents/test/nfl-line-move.test.js'), 'utf8').catch(() => '');
  ok('line-move unit coverage exists',
    /OPENERS_BLOCKED/.test(lmTest) && /SCHEMA_BLOCKED/.test(lmTest) && /never 0/.test(lmTest) && /<= 100/.test(lmTest),
    'the blocked constants, the null-move trap and the chunk size each have a test');
  const schemaSql = await readFile(join(root, 'edge-tracker-agents/scripts/schema.sql'), 'utf8').catch(() => '');
  ok('the schema block is in schema.sql',
    ['sport', 'open_ml', 'close_ml', 'ml_move'].every((c) => new RegExp(`alter table nfl_line_moves add column if not exists ${c}`).test(schemaSql))
    && /update nfl_line_moves set sport = 'NFL' where sport is null/.test(schemaSql),
    'the DDL is hand-run; the file is the record of what to run');
}
// ── 16. CLV alarm population ────────────────────────────────────
// Production 2026-11-06: "15 plays past close with only one snapshot batch"
// on every run while line_snapshots took 60k rows in three hours. Seven of
// the fifteen were in-game plays (`monitor_scores.live`) that run() never
// read — not even in the projection — so a bet with no close to beat (D37)
// was counted as a coverage failure. The projection and the exclusion are
// pinned together: one without the other is the same bug.
const clvSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/clv-tracker/index.js'), 'utf8');
ok('clv-tracker reads `live` from monitor_scores and keeps in-play bets out of the coverage alarm',
  /db\.select\('monitor_scores', '[^']*\blive\b[^']*'/.test(clvSrc)
  && /if \(p\.live\) \{ inPlay\+\+; continue; \}/.test(clvSrc)
  && /const noClose = unmeasurable - noCloseCapture - noCommence;/.test(clvSrc)
  && /if \(noClose >= ALARM_MIN && !records\.length\)/.test(clvSrc),
  'an in-game play is rejected by capture() as unmeasurable (entry >= close) and, counted into the alarm population, blames snapshot coverage for a bet that could never have had a close (D98)');

const tail = skips.length ? `, ${skips.length} skipped` : '';
console.log(`\n${fails.length ? '✗' : '✓'} smoke: ${pass} passed, ${fails.length} failed${tail}`);
if (skips.length) {
  // Printed even on success: a silent skip is how coverage quietly disappears.
  skips.forEach((sk) => console.log(`  — skipped: ${sk}`));
}
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
