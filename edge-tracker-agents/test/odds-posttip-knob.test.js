// ══════════════════════════════════════════════════════════════
// The two post-tip knobs as the ENV sees them (D107).
//
// `ODDS_POSTTIP_MIN` decides how long a sport with no in-play consumer keeps
// the fast cadence after a tip, and `0` is a legitimate setting there ("drop
// the moment a game tips"). That is precisely why the reader matters: every
// `Number(x)` family reader turns '' and '  ' into a finite 0, so a knob with
// a meaningful zero cannot be read with one. It shipped on the odds agent's
// `hdrNum`, which rejects '' but does NOT clean — so `ODDS_POSTTIP_MIN='  '`
// (one dashboard paste away) read as a deliberate 0 and closed the post-tip
// window for every sport, silently and indistinguishably from someone asking
// for that. It is read with `intEnv` now: clean first, reject blank before
// coercing, keep an explicit 0, refuse a negative.
//
// `ODDS_LIVE_SPORTS` is compared against the UPPER-CASE keys of SPORTS, so
// 'nfl' matched nothing and bought nothing while reading as configured — the
// same normalise-then-validate ODDS_SKIP_SPORTS has always done.
//
// Config snapshots env at module load, so each case imports a fresh instance,
// which is also how the live service sees it.
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEYS = ['ODDS_POSTTIP_MIN', 'ODDS_LIVE_SPORTS', 'NFL_LIVE'];
let n = 0;

// Returns { postTipMin, liveSports, warnings } for one env.
async function configWith(envPatch) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, envPatch);
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let cfg;
  try {
    cfg = (await import(`../src/config/index.js?knob=${n++}`)).default;
  } finally {
    console.warn = realWarn;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return { postTipMin: cfg.oddsApi.postTipMin, liveSports: cfg.oddsApi.liveSports, warnings };
}

// ── ODDS_POSTTIP_MIN ────────────────────────────────────────────
test('unset is the 45-minute default', async () => {
  const c = await configWith({});
  assert.equal(c.postTipMin, 45);
  assert.deepEqual(c.warnings, [], 'an unset knob is not a misconfiguration');
});

test("'' and '  ' are UNSET, not zero — the bug this reader exists for", async () => {
  // This is the whole finding: with hdrNum, '  ' coerced to a finite 0 and
  // every sport lost its post-tip window with nothing said about it.
  for (const v of ['', ' ', '  ', '\t', '\n', '""', "''"]) {
    const c = await configWith({ ODDS_POSTTIP_MIN: v });
    assert.equal(c.postTipMin, 45, `ODDS_POSTTIP_MIN=${JSON.stringify(v)} is blank, so the default stands`);
    assert.deepEqual(c.warnings, [], 'a blank value is unset, which is not worth a warning');
  }
});

test("'0' IS honoured — a meaningful zero is why num() cannot read this", async () => {
  const c = await configWith({ ODDS_POSTTIP_MIN: '0' });
  assert.equal(c.postTipMin, 0, '"drop to MID/IDLE the moment a game tips" is a real setting');
});

test('a non-numeric value is rejected with one warning, not coerced', async () => {
  for (const v of ['abc', '45min', 'true', '4.5']) {
    const c = await configWith({ ODDS_POSTTIP_MIN: v });
    assert.equal(c.postTipMin, 45, `ODDS_POSTTIP_MIN=${JSON.stringify(v)} is not a minute count`);
    assert.equal(c.warnings.length, 1, 'said once, at load');
    assert.match(c.warnings[0], /ODDS_POSTTIP_MIN/, 'and it names the variable so it can be fixed');
  }
});

test('a negative value is REJECTED, not floored — and the warning never echoes it', async () => {
  // Floored at 0 it would silently mean "no post-tip polling at all", which is
  // a different setting from the one asked for; unfloored it would invert
  // `dt >= -tailMs` onto PRE-tip games and stop polling games about to start.
  // Rejected, with the default standing and the fault reported.
  const c = await configWith({ ODDS_POSTTIP_MIN: '-60' });
  assert.equal(c.postTipMin, 45);
  assert.equal(c.warnings.length, 1);
  assert.doesNotMatch(c.warnings[0], /-60/,
    'a config warning names the VARIABLE, never the value — no env value reaches a log (D80)');
});

test('whitespace and quotes around a real value are cleaned, not rejected', async () => {
  assert.equal((await configWith({ ODDS_POSTTIP_MIN: ' 90 ' })).postTipMin, 90);
  assert.equal((await configWith({ ODDS_POSTTIP_MIN: '"90"' })).postTipMin, 90);
});

test('config hands the raw number through; the CLAMP is the odds agent\'s', async () => {
  // Deliberate split: the ceiling is the agent's own full-tail length, which
  // is defined in the agent. Config parses, the agent bounds — and the
  // behaviour is pinned in test/odds-posttip-tail.test.js.
  assert.equal((await configWith({ ODDS_POSTTIP_MIN: '600' })).postTipMin, 600);
});

// ── ODDS_LIVE_SPORTS ────────────────────────────────────────────
test('names are upper-cased and validated against SPORTS; unknowns are dropped with a warning', async () => {
  const c = await configWith({ ODDS_LIVE_SPORTS: 'nfl,NBA,xyz' });
  assert.deepEqual(c.liveSports, ['NFL', 'NBA'],
    "'nfl' is the same sport as 'NFL' — it is compared against g.sport, which is upper-case");
  assert.equal(c.warnings.length, 1, 'one warning for the whole variable, not one per name');
  assert.match(c.warnings[0], /ODDS_LIVE_SPORTS/);
  assert.match(c.warnings[0], /1 of 3/, 'how many were dropped');
  assert.match(c.warnings[0], /NFL/, 'and the known keys, which is what makes it fixable');
  assert.doesNotMatch(c.warnings[0], /xyz/,
    'the dropped name is in the operator own env; a config warning echoes no value (D80)');
});

test('an all-valid list warns about nothing', async () => {
  const c = await configWith({ ODDS_LIVE_SPORTS: 'NCAAB, nba ,NHL' });
  assert.deepEqual(c.liveSports, ['NCAAB', 'NBA', 'NHL']);
  assert.deepEqual(c.warnings, []);
});

test('a list of nothing BUT unknown names is empty, not a silent pass-through', async () => {
  const c = await configWith({ ODDS_LIVE_SPORTS: 'xfl,ufl' });
  assert.deepEqual(c.liveSports, [],
    'before validation these two bought the full 3.5h tail for nobody while reading as configured');
  assert.equal(c.warnings.length, 1);
});

test('the NFL default is validated too, and still mirrors the nfl.live gate', async () => {
  assert.deepEqual((await configWith({ NFL_LIVE: 'true' })).liveSports, ['NFL']);
  assert.deepEqual((await configWith({ NFL_LIVE: '1' })).liveSports, [],
    'bool() would say yes here and nfl.live says no (D102)');
});
