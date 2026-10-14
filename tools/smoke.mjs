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
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fails.push(detail ? `${name} — ${detail}` : name);
};

// ── 1. Every inline script parses ────────────────────────────────
// The whole app is inside <script> blocks; one typo takes the page down.
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok('found inline scripts', scripts.length > 0, `matched ${scripts.length}`);
scripts.forEach((src, i) => {
  if (!src.trim()) return;
  try { new Function(src); ok(`script[${i}] parses`, true); }
  catch (e) { ok(`script[${i}] parses`, false, e.message); }
});

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

// ── 6. No new dependencies or external CSS ───────────────────────
ok('no script src= added', !/<script[^>]*\bsrc=/i.test(html), 'app is deliberately dependency-free');

// ── 7. Backend CORS origin matching ──────────────────────────────
// The API admits local dev origins so the PWA is testable before deploy. That
// regex is the only thing standing between "localhost works" and "any host
// ending in localhost works", so pin its behaviour rather than trusting a read.
const server = await readFile(join(root, 'edge-tracker-agents/src/index.js'), 'utf8');
const localRe = (server.match(/const isLocalDev\s*=\s*origin\s*&&\s*(\/.+?\/)\.test\(origin\)/) || [])[1];
ok('isLocalDev origin regex found', !!localRe);
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

console.log(`\n${fails.length ? '✗' : '✓'} smoke: ${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
