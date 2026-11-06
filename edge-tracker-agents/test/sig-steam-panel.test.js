// ══════════════════════════════════════════════════════════════
// The Signal → Steam panel, driven with the sharp agent's seven run summaries.
//
// The dashboard's real functions are lifted out of index.html into a vm
// context (no browser, no server): esc, agentAgo/agentStatus, and the whole
// Signal block from SIG_PANELS to agentPlayKey. What is under test is the copy
// each state produces — the radar (NOT FIRING) must appear for exactly the
// `blind —` summaries, a real zero must read as a zero, an OLD cached payload
// that still says "no recent line movement" must not throw or be dressed up
// as a diagnosis, and nothing may be escaped twice.
// ══════════════════════════════════════════════════════════════
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let ctx;

const SEVEN = {
  dormant: 'dormant — empty slate',
  noFeed: 'blind — no DB and no in-memory feed',
  readFailed: 'blind — history read failed for 24/24 games, 3 consecutive runs · memory-only: 1 steam · 3 rows / 3 gap-eligible',
  nullGap: 'blind — 61 rows in the last 45m, none carry gap_min (writer is stripping it — see odds log)',
  empty: '0 steam · 0 movement rows in the last 45m across 12 games · history+memory',
  noCluster: '0 steam · 128 rows / 41 gap-eligible / 0 simultaneous clusters · 12 games · history+memory',
  success: '3 steam · 128 rows / 41 gap-eligible / 9 markets · 12 games · history+memory · window 45m',
};
const BLIND = ['noFeed', 'readFailed', 'nullGap'];

function slice(html, from, to) {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `index.html lost a marker: ${from} … ${to}`);
  return html.slice(a, b);
}

before(async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const esc = html.split('\n').find((l) => /^function esc\(s\)/.test(l));
  const staleMs = html.split('\n').find((l) => /^var AGENT_STALE_MS=/.test(l));
  const meta = slice(html, 'var AGENTS_META=', 'var AGENT_STALE_MS=');
  const agentFns = slice(html, 'function agentAgo(ts){', '// ── Load data from Supabase');
  const sig = slice(html, 'var SIG_PANELS=', 'function agentPlayKey(');
  assert.ok(esc && staleMs);
  ctx = vm.createContext({
    window: {}, document: {}, console,
    state: {}, $: () => ({ innerHTML: '' }),
    startAgentsPoll() {}, hydrateAgentsCache() {}, loadAgentsData() {}, toast() {},
    Date, Math, String, Number, Object, Array, RegExp, JSON, Promise, isNaN, Infinity, NaN,
  });
  vm.runInContext([esc, meta, staleMs, agentFns, sig].join('\n'), ctx, { filename: 'index.html(sig)' });
});

// A freshly answered /health + /plays bag, as applyAgentsBag maps it.
function setState({ res, sharp = [], at = Date.now(), cached = false, noRun = false }) {
  const s = ctx.state;
  for (const k of Object.keys(s)) delete s[k];
  s.sigSrc = cached ? { plays: {}, health: {} } : { plays: { ok: true, at, okAt: at }, health: { ok: true, at, okAt: at } };
  s.agentsCachedAt = cached ? at - 3600_000 : null;
  s.agentsLastLoad = cached ? null : at;
  s.agentsHealth = noRun ? [] : [{ name: 'sharp', status: 'ok', result: res, error: null, finished_at: new Date(at).toISOString(), duration_ms: 12 }];
  s.agentsSharp = sharp;
  s.agentsBudget = {};
  s.sigView = 'steam';
}
const render = () => ctx.renderSigSteam();
// Spread into this realm: a vm object has the context's Object.prototype and deepEqual is strict about that.
const chip = () => ({ ...ctx.sigChipStatus().steam });
const facts = () => ctx.sigSteamFacts();
const page = () => ctx.renderSignalContent();

test('the radar and NOT FIRING copy appear for exactly the three blind states, and a zero reads as a zero', () => {
  for (const [k, res] of Object.entries(SEVEN)) {
    const sharp = k === 'success' ? [
      { sport: 'NFL', game_id: 'abc123', market: 'totals', side: 'Under', strength: 68, books: ['a', 'b', 'c'], detected_at: new Date().toISOString() },
      { sport: 'NBA', game_id: 'def456', market: 'spreads', side: 'LAL', strength: 60, books: ['a', 'b', 'c'], detected_at: new Date().toISOString() },
      { sport: 'MLB', game_id: 'ghi789', market: 'h2h', side: 'BOS', strength: 61, books: ['a', 'b', 'c', 'd'], detected_at: new Date().toISOString() },
    ] : [];
    setState({ res, sharp });
    const F = facts();
    assert.equal(F.notFiring, BLIND.includes(k), `${k}: notFiring keys on /^blind —/ only`);
    assert.equal(F.res, res);
    let h;
    assert.doesNotThrow(() => { h = render(); page(); }, `${k} renders`);
    assert.equal(/sh-radar/.test(h), BLIND.includes(k), `${k}: the radar is for a blind agent only`);
    assert.equal(/NOT FIRING/.test(h), BLIND.includes(k), `${k}: NOT FIRING copy only when blind`);
    assert.ok(h.includes(ctx.esc(res)), `${k}: the agent's own line is shown`);
    if (BLIND.includes(k)) {
      assert.ok(h.includes('Steam: NOT FIRING — the sharp agent reports &quot;' + ctx.esc(res) + '&quot;'), `${k}: the banner quotes the summary, escaped once`);
      assert.deepEqual(chip(), { txt: 'not firing', cls: 'off' }, k);
    } else if (k === 'success') {
      assert.ok(/STEAM SIGNALS/.test(h) && /ghi789/.test(h), 'signals table');
      assert.ok(!/Feed answered/.test(h));
      assert.deepEqual(chip(), { txt: '3 signals', cls: '' });
    } else {
      assert.ok(/Feed answered\. 0 steam signals right now\./.test(h), `${k}: an honest zero`);
      assert.deepEqual(chip(), { txt: '0 signals', cls: '' }, k);
    }
    assert.ok(!/&amp;(lt|gt|quot|#39|amp);/.test(h), `${k}: nothing double-escaped`);
  }
});

test('the two blind states that mention counts are not mistaken for zeros, and vice versa', () => {
  // The exact family a regex on "0 steam" or on "steam ·" would confuse.
  setState({ res: SEVEN.readFailed });
  assert.equal(facts().notFiring, true, 'memory-only: 1 steam inside a blind summary is still blind');
  setState({ res: SEVEN.empty });
  assert.equal(facts().notFiring, false, 'a zero with its scope is not blind');
});

test('an OLD cached payload still saying "no recent line movement" neither throws nor earns the radar', () => {
  setState({ res: 'no recent line movement', cached: true });
  let h;
  assert.doesNotThrow(() => { h = render(); page(); });
  assert.equal(facts().notFiring, false, 'the deleted sentence is not a blind claim — the radar means "the agent says it cannot see"');
  assert.ok(!/sh-radar/.test(h));
  assert.ok(/Feed answered\. 0 steam signals right now\./.test(h));
  assert.ok(h.includes('no recent line movement'), 'the stale line is still shown as the agent\'s own evidence');
  assert.deepEqual(chip(), { txt: '0 signals', cls: '' });
});

test('a payload with no sharp block and no sharp run: no throw, no radar, no invented zero on the chip', () => {
  setState({ res: '', sharp: undefined, noRun: true });
  ctx.state.agentsSharp = undefined;
  let h;
  assert.doesNotThrow(() => { h = render(); page(); });
  assert.equal(facts().notFiring, false);
  assert.ok(!/sh-radar/.test(h));
  assert.ok(/no status for the sharp agent in this payload/.test(h), 'the card says the run is missing, not that it is healthy');
  assert.ok(/Feed answered\. 0 steam signals/.test(h), 'the feed did answer; it had nothing');
  // Before any refresh and with nothing cached, the panel is loading, not empty.
  setState({ res: '', sharp: undefined, noRun: true });
  ctx.state.sigSrc = {}; ctx.state.agentsLastLoad = null; ctx.state.agentsCachedAt = null; ctx.state.agentsSharp = undefined;
  assert.equal(facts().st, 'loading');
  assert.doesNotThrow(() => { h = render(); page(); });
  assert.ok(/Loading — no cached copy on this device yet\./.test(h));
  assert.deepEqual(chip(), { txt: '—', cls: '' });
});

test('a summary carrying markup is escaped exactly once in the banner, the card and the chip strip', () => {
  const res = 'blind — <b>&"x\'y"</b> history read failed for 1/1 games · memory-only: 0 steam';
  setState({ res });
  const h = render();
  const once = ctx.esc(res);
  assert.ok(h.includes(once), 'escaped once');
  assert.ok(!h.includes('<b>&"'), 'never raw');
  assert.ok(!h.includes(ctx.esc(once)), 'never twice');
  assert.doesNotThrow(() => page());
});

test('stale: signals older than 2× the 5-min cadence are shown as history, and the copy names the bound', () => {
  const old = new Date(Date.now() - 25 * 60_000).toISOString();
  setState({ res: SEVEN.success, sharp: [{ sport: 'NFL', game_id: 'abc', market: 'totals', side: 'Under', strength: 60, books: ['a', 'b', 'c'], detected_at: old }] });
  assert.equal(ctx.SIG_STEAM_BOUND, 1_200_000, '2× AGENT_STALE_MS.sharp (600000)');
  assert.equal(facts().st, 'stale');
  const h = render();
  assert.ok(/older than 20m \(2× the sharp agent&#39;s cadence\)/.test(h), h.match(/Last produced[^<]*/)?.[0]);
  assert.deepEqual(chip(), { txt: '1 signal', cls: 'warn' });
});
