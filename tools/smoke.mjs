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
ok('data-health watches book_move_log', /book_move_log/.test(server));

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
ok('data-health watches book_move_log by detected_at', /\['book_move_log',\s*'detected_at'\]/.test(server));
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

const tail = skips.length ? `, ${skips.length} skipped` : '';
console.log(`\n${fails.length ? '✗' : '✓'} smoke: ${pass} passed, ${fails.length} failed${tail}`);
if (skips.length) {
  // Printed even on success: a silent skip is how coverage quietly disappears.
  skips.forEach((sk) => console.log(`  — skipped: ${sk}`));
}
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
