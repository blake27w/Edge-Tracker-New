// ══════════════════════════════════════════════════════════════
// `oddsApi.liveSports` — who keeps the full post-tip polling tail (D102).
//
// The list is what the odds agent charges three hours of STRIKE-cadence
// polling for after every tip, so its NFL default has to agree with whether
// the nfl.live agent is actually running. That agent's own gate is
//
//     String(process.env.NFL_LIVE || '').toLowerCase() === 'true'
//
// and this default MIRRORS it character for character — deliberately NOT
// config's own bool(), which also accepts 1/true/yes/on. With bool(),
// `NFL_LIVE=1` would buy the full tail for a consumer that stays disabled:
// the cost of the tail paid, none of the value. The two predicates must agree
// or the spend has no reader.
//
// Config is read per import here (a fresh instance per env value) because it
// snapshots env at module load, which is also how the live service sees it.
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const KEYS = ['NFL_LIVE', 'ODDS_LIVE_SPORTS'];
let n = 0;

async function liveSportsWith(envPatch) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, envPatch);
  const cfg = (await import(`../src/config/index.js?live=${n++}`)).default;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return cfg.oddsApi.liveSports;
}

test('no NFL_LIVE at all means no sport keeps the full tail', async () => {
  assert.deepEqual(await liveSportsWith({}), []);
});

test("NFL_LIVE=true enables the NFL tail — the consumer is running", async () => {
  assert.deepEqual(await liveSportsWith({ NFL_LIVE: 'true' }), ['NFL']);
  assert.deepEqual(await liveSportsWith({ NFL_LIVE: 'TRUE' }), ['NFL'], 'the mirrored predicate lowercases');
});

test("NFL_LIVE=' true ' matches NEITHER — the mirror includes not trimming", async () => {
  // nfl.live does not trim, so neither does this. A dashboard-pasted space
  // leaves the agent off, and the tail has to be off with it. Trimming here
  // would be an improvement that silently DISAGREES with the consumer, which
  // is the whole failure this mirror exists to prevent. Fix it in both files
  // or neither.
  assert.deepEqual(await liveSportsWith({ NFL_LIVE: ' true ' }), []);
});

test("NFL_LIVE=1 does NOT — bool() would say yes here, nfl.live says no", async () => {
  // This is the mutation that matters: swapping the predicate for bool() turns
  // every one of these into ['NFL'] and pays for a tail nothing reads.
  for (const v of ['1', 'yes', 'on', 'True!', 'false', '0', 'off', '']) {
    assert.deepEqual(await liveSportsWith({ NFL_LIVE: v }), [],
      `NFL_LIVE=${JSON.stringify(v)} leaves nfl.live disabled, so it must leave the tail short too`);
  }
});

test('the predicate is still a character-for-character mirror of the nfl.live gate', () => {
  // A source-level assertion on purpose: the two are in different files with no
  // shared helper, and the failure mode is silent (a tail paid for, nothing
  // reading it). If one side is refactored, this fails and names the other.
  const PREDICATE = /String\(\s*(?:process\.)?env\.NFL_LIVE \|\| ''\s*\)\.toLowerCase\(\) === 'true'/;
  const agent = readFileSync(new URL('../src/agents/nfl.live/nfl-live-index.js', import.meta.url), 'utf8');
  const cfg = readFileSync(new URL('../src/config/index.js', import.meta.url), 'utf8');
  assert.match(agent, PREDICATE, 'nfl.live still gates on === \'true\'');
  assert.match(cfg, PREDICATE, 'and config mirrors it rather than using bool()');
  assert.doesNotMatch(cfg, /NFL_LIVE_ON = bool\(/, 'bool() accepts 1/yes/on and would disagree with the agent');
});

test('ODDS_LIVE_SPORTS overrides the default entirely, in both directions', async () => {
  assert.deepEqual(await liveSportsWith({ ODDS_LIVE_SPORTS: 'NCAAB' }), ['NCAAB'],
    'a sport gets the tail the day it gets a live consumer, with no code change');
  assert.deepEqual(await liveSportsWith({ ODDS_LIVE_SPORTS: 'NCAAB, NBA ,NHL' }), ['NCAAB', 'NBA', 'NHL'],
    'comma-separated and trimmed, same as every other list() knob');
  assert.deepEqual(await liveSportsWith({ ODDS_LIVE_SPORTS: 'NCAAB', NFL_LIVE: 'true' }), ['NCAAB'],
    'an explicit list replaces the NFL default — it does not merge with it');
  assert.deepEqual(await liveSportsWith({ ODDS_LIVE_SPORTS: '', NFL_LIVE: 'true' }), ['NFL'],
    'but an empty value is not a list of zero sports, it is "unset" (list() semantics)');
});
