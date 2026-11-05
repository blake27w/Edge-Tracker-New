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
// The two consumers of odds' in-memory movement feeds — which one reads which
// key is the invariant, not a detail (D74).
const splitsSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/public-splits/index.js'), 'utf8');
const sharpSrc = await readFile(join(root, 'edge-tracker-agents/src/agents/sharp/index.js'), 'utf8');
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
  /getIntel\('movements'\)/.test(sharpSrc) && !/movementsAll/.test(sharpSrc),
  'routing sharp at the complete feed restores the steam corruption this branch fixed — an afternoon of drift at three books republished as coordinated money');
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
ok('the opt-in set is asserted against the wired fleet, not just the two files',
  /exactly the two agents the spec opted in/.test(blockedTestSrc),
  '~60 of the ~70 skip sites are benign and must stay silent; a third opt-in is a policy change and notifyAll reaching zero recipients means false positives are the one cost this design cannot absorb');

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

const tail = skips.length ? `, ${skips.length} skipped` : '';
console.log(`\n${fails.length ? '✗' : '✓'} smoke: ${pass} passed, ${fails.length} failed${tail}`);
if (skips.length) {
  // Printed even on success: a silent skip is how coverage quietly disappears.
  skips.forEach((sk) => console.log(`  — skipped: ${sk}`));
}
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
