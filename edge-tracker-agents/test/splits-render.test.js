// ══════════════════════════════════════════════════════════════
// The Splits tab's renderer, lifted out of index.html into a vm context (the
// sig-steam-panel pattern): esc, agentAgo, the sig* helpers and the whole
// Splits block from SPLIT_SPORTS to renderSplitsBoard.
//
// What is under test is the HONESTY INVARIANT under adversarial payloads: for
// every book selection the percentage cells are byte-identical (the switcher
// changes lines and chips only, D53/D101); the market-wide label appears iff
// a non-consensus book is selected; an OLD cached bag (no books[].key, no
// splits_meta, no openers, no public-splits health entry) renders without
// throwing and without a 0%; the five states paint the right banner over
// whatever is cached; blockedReason is quoted verbatim, escaped once. Then
// the switcher's edge cases, the 30-s repaint's DOM preservation against a
// fake host that implements exactly the DOM surface the code touches, and a
// timing of 150 cards × 11 books.
// ══════════════════════════════════════════════════════════════
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = Date.parse('2026-11-06T20:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
let ctx, html, host, ls, bookInit, agentsWrites;

function slice(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `index.html lost a marker: ${from} … ${to}`);
  return src.slice(a, b);
}

// The DOM surface renderSplitsContent/splitsDomSave/splitsDomRestore touch,
// and nothing more: innerHTML (a set replaces every node — fresh objects,
// closed, scrolled to 0, as a browser would), querySelectorAll for the
// per-game <details>, querySelector for the chip row.
function fakeHost() {
  const h = { _html: '', details: [], row: null, writes: 0 };
  Object.defineProperty(h, 'innerHTML', {
    get() { return h._html; },
    set(v) {
      h._html = v; h.writes++;
      h.details = [...v.matchAll(/<details class="sh-books" data-game="([^"]*)"/g)].map((m) => ({ id: m[1], open: false, getAttribute: (k) => (k === 'data-game' ? m[1] : null) }));
      h.row = /class="sp-books"/.test(v) ? { scrollLeft: 0 } : null;
    },
  });
  h.querySelectorAll = (sel) => (sel === 'details.sh-books[data-game]' ? h.details : []);
  h.querySelector = (sel) => (sel === '.sp-books' ? h.row : null);
  return h;
}
function fakeStorage({ throwOnRead = false, throwOnWrite = false, value = null } = {}) {
  const s = { value, reads: 0, writes: 0 };
  s.getItem = () => { s.reads++; if (throwOnRead) throw new Error('SecurityError: private mode'); return s.value; };
  s.setItem = (k, v) => { s.writes++; if (throwOnWrite) throw new Error('QuotaExceededError'); s.value = v; };
  return s;
}

before(async () => {
  html = await readFile(join(root, 'index.html'), 'utf8');
  const line = (re) => { const l = html.split('\n').find((x) => re.test(x)); assert.ok(l, `index.html lost ${re}`); return l; };
  const esc = line(/^function esc\(s\)/);
  const staleMs = line(/^var AGENT_STALE_MS=/);
  const sigSgn = line(/^function sigSgn\(/);
  const agentFns = slice(html, 'function agentAgo(ts){', '// ── Load data from Supabase');
  const sigFns = slice(html, 'function sigState(', '// The only hand-rolled graphic');
  const splits = slice(html, 'var SPLIT_SPORTS=', '// ── NFL team schedules');
  // The state-literal initialiser for the book selection, lifted verbatim.
  const initLine = line(/^\s*splitsBook:\(function\(\)\{/);
  bookInit = initLine.slice(initLine.indexOf('(function(){'), initLine.lastIndexOf('})()') + 4);
  host = fakeHost();
  ls = fakeStorage();
  agentsWrites = [];
  ctx = vm.createContext({
    window: {}, document: {}, console,
    state: {}, $: (id) => (id === 'sport-selector' ? host : { innerHTML: '' }),
    get localStorage() { return ls; },
    startAgentsPoll() {}, hydrateAgentsCache() {}, loadAgentsData() {}, toast() {},
    // The Plays → 📊 Splits chip host: what renderAgentsContent does with the
    // board — one innerHTML replacement, no save/restore (characterised below).
    renderAgentsContent() { const h = '<div>plays</div>' + ctx.renderSplitsBoard(); agentsWrites.push(h); host.innerHTML = h; },
    Date, Math, String, Number, Object, Array, RegExp, JSON, Promise, isNaN, Infinity, NaN, parseInt, parseFloat,
  });
  vm.runInContext([esc, staleMs, agentFns, sigFns, sigSgn, splits].join('\n'), ctx, { filename: 'index.html(splits)' });
  // Pin the clock inside the realm too (agentAgo / sigState read Date.now()).
  const RealDate = Date;
  ctx.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
});

const KEYS = ['draftkings', 'fanduel', 'betmgm'];
const LABELS = { draftkings: 'DraftKings', fanduel: "Fan<Duel> & 'Co'", betmgm: 'BetMGM' };
const book = (key, i) => ({ key, book: LABELS[key], updated: iso(NOW), ml_home: -150 - i * 5, ml_away: 130 + i * 5, spread_line: -3.5 - i * 0.5, spread_price: -110, total_line: 220.5 + i, over_price: -110, under_price: -110 });
const srow = (market, side, public_side, bets, handle, extra = {}) => ({
  market, side, public_side, bets_pct: bets, handle_pct: handle, divergence: bets != null && handle != null ? handle - bets : null,
  rlm: null, freeze: null, pileon: false, net_move: null, fetched_at: iso(NOW - 10 * 60_000), ...extra,
});
function mkGame(id, { sport = 'NBA', splits, kick = 180, books = KEYS } = {}) {
  return {
    game_id: id, sport, home: "Home O'Neil & Sons", away: `Away <${id}>`, matchup: 'x', commence_time: iso(NOW + kick * 60_000), live: kick <= 0,
    open: { spread: -3, total: 218, ml: -140 }, current: { spread: -4, total: 221, ml: -160 },
    splits: splits || [srow('spread', 'Home -3.5', 'home', 71, 58, { rlm: true, net_move: -1 }), srow('total', 'Over', 'over', 64, null), srow('ml', 'AwayML', 'away', 55, 61)],
    splits_at: iso(NOW - 10 * 60_000), books: books.map(book),
  };
}
function setState({ games, meta = { source: 'memory', at: iso(NOW - 10 * 60_000), rows: 3, offslate: 0, db_error: false, truncated: false }, ok = true, health, system = null, live = [], openers, sport = 'all', bookSel = 'consensus', board, homeTab = 'splits' }) {
  const s = ctx.state;
  for (const k of Object.keys(s)) delete s[k];
  s.homeScreen = true; s.homeTab = homeTab;
  s.sigSrc = { splits: ok == null ? {} : { ok, at: NOW, okAt: ok ? NOW : NOW - 3600_000 }, health: { ok: true, at: NOW, okAt: NOW } };
  s.agentsLastLoad = NOW; s.agentsCachedAt = null;
  s.agentsSplitsBoard = board !== undefined ? board : { count: games.length, games, ...(meta ? { splits_meta: meta } : {}) };
  s.agentsHealth = health !== undefined ? health : [{ name: 'public-splits', status: 'ok', blockedReason: null, blockedRuns: 0, blockedSince: null, finished_at: iso(NOW - 10 * 60_000) }];
  s.agentsSystem = system;
  s.agentsBookMoves = openers === null ? undefined : { live, openers: openers || {} };
  s.splitsSport = sport; s.splitsBook = bookSel;
}
const render = () => { ctx.renderSplitsContent(); return host.innerHTML; };
// The percentage cells, row by row, in document order: the whole
// <span class="sp-pct">…</span> up to the row's closing </div>.
const pctCells = (h) => h.split('<div class="sp-row">').slice(1).map((r) => { const i = r.indexOf('<span class="sp-pct">'); return i < 0 ? '' : r.slice(i, r.indexOf('</div>', i)); });
const lineCells = (h) => h.split('<div class="sp-row">').slice(1).map((r) => (r.match(/<span class="sp-ln">([\s\S]*?)<\/span>/) || [])[1] || '');
const count = (h, s) => h.split(s).length - 1;
const cards = (h) => count(h, 'class="sigep sp-card"');
const banners = (h) => [...h.matchAll(/<div class="sh-banner (\w+)">/g)].map((m) => m[1]);

beforeEach(() => { host = fakeHost(); ls = fakeStorage(); agentsWrites.length = 0; });

// ── Scenario 2: the honesty invariant ─────────────────────────
test('percentage cells are byte-identical for every book selection; the market-wide label appears iff a non-consensus book on the slate is selected', () => {
  const games = [mkGame('g1'), mkGame('g2', { splits: [srow('spread', 'Away +3', 'away', null, null), srow('total', 'Under', 'under', 0, 100)] }), mkGame('g3', { splits: [], kick: -30 })];
  const openers = { g1: { draftkings: { spread: -3, total: 219, ml: -145 }, fanduel: { spread: -3.5 } }, g2: { betmgm: { total: 220 } } };
  const live = [{ game_id: 'g1', book: 'draftkings', market: 'spreads', moved: -1, reasons: ['led field', 'crossed 3'] }, { game_id: 'g1', book: 'fanduel', market: 'totals', moved: 0.5, reasons: [] }];
  const seen = {};
  for (const sel of ['consensus', ...KEYS, 'caesars', '']) {
    setState({ games, openers, live, bookSel: sel });
    const h = render();
    assert.equal(cards(h), 3);
    seen[sel] = { pct: pctCells(h), lines: lineCells(h) };
    assert.equal(seen[sel].pct.length, 9, 'three rows per card');
    const onSlate = KEYS.includes(sel);
    assert.equal(count(h, 'splits are market-wide — '), onSlate ? 3 : 0, `label for ${JSON.stringify(sel)}`);
    assert.equal(count(h, 'open (first seen) → now'), onSlate ? 3 : 0);
    if (onSlate) {
      assert.ok(h.includes(`splits are market-wide — ${ctx.esc(LABELS[sel])}'s own counts are not captured`), 'the label carries the escaped label');
      assert.ok(!h.includes('Fan<Duel>'), 'never raw'); assert.ok(!h.includes('&amp;lt;'), 'never escaped twice');
    }
  }
  for (const sel of Object.keys(seen)) assert.deepEqual(seen[sel].pct, seen.consensus.pct, `percentage cells differ for ${JSON.stringify(sel)} — the switcher must never touch a percentage`);
  // …while the LINES do change for a book on the slate, and only there.
  assert.notDeepEqual(seen.draftkings.lines, seen.consensus.lines);
  assert.deepEqual(seen.caesars.lines, seen.consensus.lines, 'an unknown key falls back to consensus lines');
  assert.deepEqual(seen[''].lines, seen.consensus.lines);
  // Chips appear only for the selected book's own episodes, on SPREAD/TOTAL only.
  setState({ games, openers, live, bookSel: 'draftkings' });
  const dk = render();
  assert.equal(count(dk, 'sp-chip move'), 2, 'led field + crossed 3 on g1 SPREAD');
  setState({ games, openers, live, bookSel: 'fanduel' });
  assert.equal(count(render(), 'sp-chip move'), 1, 'the reasons-less episode falls back to "+0.5 move"');
  assert.ok(render().includes('+0.5 move'));
  setState({ games, openers, live, bookSel: 'consensus' });
  assert.equal(count(render(), 'sp-chip move'), 0);
});

test('a zero published is a zero painted; a null is — and never 0%; the complement is derived only from a reading', () => {
  const games = [mkGame('g1', { splits: [srow('spread', 'Home', 'home', 0, 100), srow('total', 'Over', 'over', null, null), srow('ml', 'AwayML', 'away', 55, null)] })];
  setState({ games });
  const h = render();
  const [sp, tot, ml] = pctCells(h);
  assert.ok(sp.includes('0%') && sp.includes('100%'), `a real 0 reads as 0: ${sp}`);
  assert.ok(!/\b0%/.test(tot), `null → —, never 0%: ${tot}`);
  const sides = (c) => c.replace(/<span class="sp-flags">[\s\S]*$/, '');
  assert.equal(count(sides(tot), '—'), 4, 'both sides, both numbers');
  assert.ok(tot.includes('net —'), 'net_move null → net —, in the flags');
  assert.ok(ml.includes('55%') && ml.includes('45%'), 'bets complement derived from the reading');
  assert.equal(count(ml, '—'), 2, 'handle null on BOTH sides — the complement of a null is not 100');
  assert.ok(!/\b0%/.test(ml));
  // Divergence emphasis: only when both numbers exist, only one side, ≥ 5.
  assert.equal(count(sp, ' hot'), 1, 'home 0/100: away side is 100 bets / 0 handle → not hot; home 0 bets / 100 handle → hot');
  assert.equal(count(tot, ' hot'), 0); assert.equal(count(ml, ' hot'), 0);
});

test('an old cached bag — no books[].key, no open/current, no splits_meta, no openers, no public-splits health entry — renders without throwing and without a 0%', () => {
  const games = [mkGame('g1'), mkGame('g2')].map((g) => {
    const { open, current, splits_at, ...rest } = g;
    rest.books = rest.books.map(({ key, ...b }) => b);
    rest.splits = rest.splits.map(({ public_side, fetched_at, divergence, net_move, ...s }) => ({ ...s, bets_pct: s.bets_pct == null ? null : s.bets_pct }));
    return rest;
  });
  setState({ games, meta: null, health: [], openers: null, bookSel: 'draftkings' });
  const h = render();
  assert.equal(cards(h), 2);
  assert.equal(count(h, '<button class="on" onclick="splitsSetBook'), 1, 'Consensus alone is on');
  assert.equal(count(h, 'onclick="splitsSetBook'), 1, 'no keys → no book chips');
  assert.ok(!/\b0%/.test(h), 'no 0% anywhere');
  for (const l of lineCells(h)) assert.equal(l.replace(/<[^>]+>/g, '').trim(), '— → —', `open — → now —: ${l}`);
  assert.ok(h.includes('source <b>—</b>'), 'the strip has no source word to show');
  assert.ok(h.includes('batch <b>—</b> · every 4h'));
  assert.ok(!h.includes('restored from Postgres'));
  assert.ok(!h.includes('splits are market-wide'), 'no key on the slate → selection falls back to consensus → no label');
  // Still renders the percentages it has.
  assert.ok(pctCells(h)[0].includes('71%') && pctCells(h)[0].includes('29%'));
});

test('states: failed (route) and failed (db fallback) paint OVER cached cards; source null/none with 0 rows → nodata; off quotes blockedReason verbatim, escaped once; stale past 8h', () => {
  const games = [mkGame('g1')];
  // Route failed: banner first, cards still there.
  setState({ games, ok: false });
  let h = render();
  assert.deepEqual(banners(h), ['failed']);
  assert.ok(h.indexOf('sh-banner failed') < h.indexOf('sp-card'), 'banner over the cards');
  assert.equal(cards(h), 1);
  assert.ok(h.includes('/splits did not answer'));
  // Route answered, its DB read failed: the DB-read wording, over the cards.
  setState({ games, meta: { source: null, at: null, rows: 0, offslate: 0, db_error: true, truncated: false } });
  h = render();
  assert.deepEqual(banners(h), ['failed']);
  assert.ok(h.includes('public_splits fallback read failed'));
  assert.equal(cards(h), 1);
  assert.ok(h.includes('source <b class="off">none</b>'), 'the strip paints the failed read red');
  // No rows anywhere, no failure: nodata.
  const empty = [mkGame('g1', { splits: [] })];
  setState({ games: empty, meta: { source: null, at: null, rows: 0, offslate: 0, db_error: false, truncated: false } });
  h = render();
  assert.deepEqual(banners(h), ['nodata']);
  assert.ok(h.includes('0 public-split rows for this slate'));
  assert.equal(count(h, 'no split for this game'), 1);
  assert.ok(!/\b0%/.test(h));
  setState({ games: empty, meta: { source: 'none', at: null, rows: 0 } });
  assert.deepEqual(banners(render()), ['nodata']);
  // db source: strip says so.
  setState({ games, meta: { source: 'db', at: iso(NOW - 60 * 60_000), rows: 3, offslate: 2, db_error: false, truncated: true } });
  h = render();
  assert.deepEqual(banners(h), []);
  assert.ok(h.includes('restored from Postgres after a restart') && h.includes('DB read capped at 300 rows'));
  // off: verbatim, escaped exactly once, over the cards; the D81 cap only for the no-model reason.
  const reason = 'ANTHROPIC_API_KEY is set but no model was detected at boot: "credits" & <b>x</b> \'q\'';
  setState({ games, health: [{ name: 'public-splits', status: 'ok', blockedReason: reason, blockedRuns: 7, blockedSince: iso(NOW - 26 * 3600_000) }] });
  h = render();
  assert.deepEqual(banners(h), ['off']);
  assert.ok(h.includes('NOT FIRING — public-splits is blocked: &quot;' + ctx.esc(reason) + '&quot; (7 runs since 1d ago)'), h.match(/sh-banner off[^]*?<\/div>/)[0]);
  assert.equal(count(h, ctx.esc(reason)), 1);
  assert.ok(!h.includes('<b>x</b>') && !h.includes('&amp;lt;') && !h.includes('&amp;quot;'), 'escaped once, never twice, never raw');
  assert.ok(h.includes('(D81)'), 'the credits cap');
  assert.equal(cards(h), 1, 'lines still paint');
  setState({ games, health: [{ name: 'public-splits', status: 'ok', blockedReason: 'quota exhausted', blockedRuns: 1, blockedSince: null }] });
  h = render();
  assert.ok(h.includes('&quot;quota exhausted&quot; (1 runs since —)') && !h.includes('(D81)'));
  // off via the degraded channel when health has no reason.
  setState({ games, health: [], system: { degraded: [{ key: 'public-splits|blocked', detail: 'blocked <now>', at: iso(NOW - 3600_000) }] } });
  h = render();
  assert.deepEqual(banners(h), ['off']);
  assert.ok(h.includes('&quot;blocked &lt;now&gt;&quot; (— runs since 1h ago)'));
  // stale: 9h-old batch.
  setState({ games, meta: { source: 'memory', at: iso(NOW - 9 * 3600_000), rows: 3 } });
  h = render();
  assert.deepEqual(banners(h), ['stale']);
  assert.ok(h.includes('older than 8h (2× the 4-hour public-splits cadence)'));
  assert.equal(cards(h), 1);
  // failed wins over off: a failed read is a failed read.
  setState({ games, ok: false, health: [{ name: 'public-splits', blockedReason: 'x' }] });
  assert.deepEqual(banners(render()), ['failed']);
  // loading: nothing cached, no answer yet.
  setState({ games: [], board: null, ok: null });
  h = render();
  assert.deepEqual(banners(h), ['loading']);
  assert.equal(cards(h), 0);
});

test('adversarial strings in sides, teams, labels and game ids are escaped once and never executed', () => {
  const g = mkGame('g<1>"', { splits: [srow('spread', '<img src=x onerror=alert(1)>', null, 60, 55), srow('total', "Over' onclick='x", 'over', 70, 72, { rlm: true, freeze: true, pileon: true })] });
  g.books[0].book = '<script>bad()</script>';
  g.books[0].key = 'dk"';
  setState({ games: [g], openers: { 'g<1>"': {} }, bookSel: 'dk"' });
  const h = render();
  assert.ok(!/<img|<script/.test(h), 'no raw tag survives — the < is escaped, so onerror= is inert text');
  assert.ok(!/\sonerror=/.test(h.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'onerror only ever appears inside the escaped side text');
  assert.ok(!h.includes("onclick='x"), 'a resolved side (over) paints its label, not its raw text; the raw text never lands in an attribute');
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the unresolved side is shown under its own (escaped) label');
  assert.ok(h.includes('data-game="g&lt;1&gt;&quot;"'));
  assert.ok(h.includes("splits are market-wide — &lt;script&gt;bad()&lt;/script&gt;'s own counts"));
  assert.ok(!h.includes('&amp;lt;'), 'never twice');
  assert.ok(h.includes('RLM') && h.includes('FREEZE') && h.includes('PILE-ON'));
});

// ── Scenario 3: the switcher's edge cases ─────────────────────
test('a selected book that leaves the slate falls back to Consensus for the paint but is NOT overwritten in storage — it returns with the book (characterised)', () => {
  const games = [mkGame('g1', { books: ['draftkings', 'fanduel'] })];
  setState({ games, bookSel: 'betmgm' });
  ls.value = '"betmgm"';
  let h = render();
  assert.ok(h.includes('class="on" onclick="splitsSetBook(\'consensus\')"'), 'Consensus chip is on');
  assert.equal(count(h, 'splits are market-wide'), 0);
  assert.equal(ctx.state.splitsBook, 'betmgm', 'the state keeps the preference');
  assert.equal(ls.writes, 0, 'a render never writes storage'); assert.equal(ls.value, '"betmgm"');
  setState({ games: [mkGame('g1')], bookSel: 'betmgm' });
  h = render();
  assert.ok(h.includes('class="on" onclick="splitsSetBook(\'betmgm\')"'), 'the book is back → the selection is back');
  assert.equal(count(h, 'splits are market-wide'), 1);
});

test('localStorage that throws on read or write: the selection initialiser yields consensus, splitsSetBook still switches and repaints', () => {
  const init = (storage) => vm.runInContext(bookInit, vm.createContext({ localStorage: storage, JSON }));
  assert.equal(init(fakeStorage({ throwOnRead: true })), 'consensus');
  assert.equal(init(fakeStorage({ value: null })), 'consensus');
  assert.equal(init(fakeStorage({ value: '"fanduel"' })), 'fanduel');
  assert.equal(init(fakeStorage({ value: 'not json' })), 'consensus', 'a raw string from an older build parses to nothing → consensus');
  assert.equal(init(fakeStorage({ value: '""' })), 'consensus');
  // Throwing write.
  ls = fakeStorage({ throwOnWrite: true });
  setState({ games: [mkGame('g1')], bookSel: 'consensus' });
  render();
  const writes = host.writes;
  assert.doesNotThrow(() => ctx.splitsSetBook('fanduel'));
  assert.equal(ctx.state.splitsBook, 'fanduel');
  assert.equal(ls.writes, 1, 'the write was attempted');
  assert.equal(host.writes, writes + 1, 'and the repaint happened anyway');
  assert.ok(host.innerHTML.includes('class="on" onclick="splitsSetBook(\'fanduel\')"'));
  // A working store persists the JSON string.
  ls = fakeStorage();
  ctx.splitsSetBook('betmgm');
  assert.equal(ls.value, '"betmgm"');
  ctx.splitsSetBook('consensus');
  assert.equal(ls.value, '"consensus"');
});

test('a book with openers for spreads but not h2h: the ML row reads — → its own now, never the consensus opener', () => {
  const games = [mkGame('g1')];
  setState({ games, openers: { g1: { draftkings: { spread: -3 } } }, bookSel: 'draftkings' });
  const [sp, tot, ml] = lineCells(render()).map((l) => l.replace(/<[^>]+>/g, '').trim());
  assert.equal(sp, '-3 → -3.5');
  assert.equal(tot, '— → 220.5', 'no total opener for the book → —, not the consensus 218');
  assert.equal(ml, '— → -150', 'no h2h opener for the book → —, not the consensus -140');
  setState({ games, openers: { g1: { draftkings: { spread: -3 } } }, bookSel: 'consensus' });
  assert.deepEqual(lineCells(render()).map((l) => l.replace(/<[^>]+>/g, '').trim()), ['-3 → -4', '218 → 221', '-140 → -160']);
  // A book on the slate whose row lacks a line: — on both ends.
  const g = mkGame('g1'); g.books[1].spread_line = null; g.books[1].ml_home = null;
  setState({ games: [g], openers: {}, bookSel: 'fanduel' });
  assert.deepEqual(lineCells(render()).map((l) => l.replace(/<[^>]+>/g, '').trim()), ['— → —', '— → 221.5', '— → —']);
  // The chip counts: games with a per-book opener for that book.
  setState({ games: [mkGame('g1'), mkGame('g2')], openers: { g1: { draftkings: { spread: -3 }, fanduel: {} }, g2: { draftkings: { ml: -1 } } } });
  const h = render();
  assert.ok(h.includes("splitsSetBook('draftkings')\">DraftKings<small>2 open</small>"));
  assert.ok(h.includes("splitsSetBook('fanduel')\">Fan&lt;Duel&gt; &amp; &#39;Co&#39;<small>1 open</small>"), 'an empty object still counts as "has an opener entry" (characterised)');
  assert.ok(h.includes("splitsSetBook('betmgm')\">BetMGM<small>0 open</small>"));
});

// ── Scenario 4: DOM preservation across the 30-s repaint ───────
test('open <details> survive the poll per game, a closed one stays closed, a departed game does not throw, the chip row scroll is restored', () => {
  const two = [mkGame('g1'), mkGame('g2')];
  setState({ games: two });
  render();
  assert.deepEqual(host.details.map((d) => d.id), ['g1', 'g2']);
  host.details[0].open = true;        // the user opens g1
  host.row.scrollLeft = 300;          // and scrolls the chip row
  render();                           // the poll lands
  assert.deepEqual(host.details.map((d) => [d.id, d.open]), [['g1', true], ['g2', false]]);
  assert.equal(host.row.scrollLeft, 300);
  host.details[0].open = false;       // closes it
  render();
  assert.deepEqual(host.details.map((d) => d.open), [false, false], 'stays closed');
  host.details[1].open = true;
  ctx.splitsSetSport('NBA');          // a chip tap repaints through the same path
  assert.deepEqual(host.details.map((d) => [d.id, d.open]), [['g1', false], ['g2', true]]);
  assert.equal(host.row.scrollLeft, 300);
  setState({ games: [mkGame('g1')] }); // g2 leaves the slate
  assert.doesNotThrow(render);
  assert.deepEqual(host.details.map((d) => [d.id, d.open]), [['g1', false]]);
  setState({ games: [mkGame('g1'), mkGame('g2')] }); // and comes back: its open flag was remembered
  render();
  assert.deepEqual(host.details.map((d) => [d.id, d.open]), [['g1', false], ['g2', true]], 'the module-level map remembers a departed game (characterised; harmless)');
  // A host with no chip row (e.g. loading) and a null host: no throw.
  setState({ games: [], board: null, ok: null });
  assert.doesNotThrow(render);
  assert.doesNotThrow(() => { ctx.splitsDomSave(null); ctx.splitsDomRestore(null); });
});

test('CHARACTERISED: the Plays → 📊 Splits chip path (renderAgentsContent) repaints without the save/restore — an open <details> snaps shut there', () => {
  // Source-level: the real renderAgentsContent delegates to renderSplitsBoard
  // and replaces innerHTML with no splitsDomSave/Restore around it.
  const fn = slice(html, 'function renderAgentsContent(){', '\nfunction ', );
  assert.ok(/renderSplitsBoard\(\)/.test(fn), 'the chip is painted by renderAgentsContent');
  assert.ok(/\$\('sport-selector'\)\.innerHTML=h;\n\}$/.test(fn.trimEnd() + '\n}') || /\$\('sport-selector'\)\.innerHTML=h;/.test(fn));
  assert.ok(!/splitsDomSave|splitsDomRestore/.test(fn), 'NOT given the save/restore (builder note) — current behaviour, reported not fixed');
  // Behavioural, with the stub that does what the real one does:
  setState({ games: [mkGame('g1')], homeTab: 'plays' });
  ctx.renderAgentsContent();
  host.details[0].open = true;
  ctx.splitsSetSport('all');          // repaints via renderAgentsContent
  assert.equal(agentsWrites.length, 2);
  assert.equal(host.details[0].open, false, 'snaps shut on the Plays host — the Splits tab host keeps it open');
  setState({ games: [mkGame('g1')], homeTab: 'splits' });
  ctx.renderSplitsContent(); host.details[0].open = true; ctx.splitsSetSport('all');
  assert.equal(host.details[0].open, true);
});

// ── Scenario 6: 150 cards × 11 books ──────────────────────────
test('150 cards × 11 books render in bounded time on both the consensus and a book view (timed; the vm has no layout, so this is string-building cost only)', (t) => {
  const keys = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbet', 'betrivers', 'wynnbet', 'unibet', 'bovada', 'betonline', 'lowvig'];
  for (const k of keys) LABELS[k] = LABELS[k] || k;
  const games = Array.from({ length: 150 }, (_, i) => mkGame(`g${i}`, { books: keys, kick: 30 + i, sport: ['NBA', 'NFL', 'NHL', 'MLB'][i % 4] }));
  const openers = Object.fromEntries(games.map((g) => [g.game_id, Object.fromEntries(keys.map((k, j) => [k, { spread: -3 - j, total: 200 + j, ml: -120 - j }]))]));
  const live = [];
  for (let i = 0; i < 600; i++) live.push({ game_id: `g${i % 150}`, book: keys[i % keys.length], market: i % 2 ? 'spreads' : 'totals', moved: 1, reasons: ['led field'] });
  const time = (sel) => {
    setState({ games, openers, live, bookSel: sel });
    render();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) render();
    return Number(process.hrtime.bigint() - t0) / 5e6;
  };
  const c = time('consensus'), b = time('draftkings');
  t.diagnostic(`render 150×11: consensus ${c.toFixed(1)} ms, book ${b.toFixed(1)} ms per paint (${(host.innerHTML.length / 1024).toFixed(0)} KB)`);
  assert.equal(cards(host.innerHTML), 150);
  assert.ok(c < 1000 && b < 1000, `too slow for a 30-s poll: ${c} / ${b} ms`);
});
