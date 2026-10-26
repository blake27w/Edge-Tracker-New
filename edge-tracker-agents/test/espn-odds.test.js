// ══════════════════════════════════════════════════════════════
// consensusOf — how a stored closing line is chosen from ESPN's books.
//
// Pure function over an array, so this needs no fake-db and no mocks. It is
// pinned here because two of its properties are load-bearing elsewhere:
//
//   • the live-provider filter is the D4 trap — ESPN quotes an in-play number
//     alongside the close (52.5 close vs 39.5 live on ORE/MSU 2024), and
//     letting one through silently corrupts every total in the table;
//   • single-book games must come back byte-identical to the old
//     most-populated-record heuristic, because that is what makes #132 safe to
//     merge against 601 NFL and 2260 NCAAF already-stored rows. Measured
//     across 24 games (2024/2025/2026) as exactly one non-live book each.
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consensusOf, num } from '../src/agents/shared/espn-odds.js';

// ESPN shape, trimmed to what consensusOf reads.
const book = (name, spread, overUnder, extra = {}) => ({
  provider: { name },
  spread, overUnder,
  overOdds: extra.over ?? null,
  underOdds: extra.under ?? null,
  homeTeamOdds: { spreadOdds: extra.homeSpread ?? null },
  awayTeamOdds: { spreadOdds: extra.awaySpread ?? null },
});
// Mirrors what the history agents pass in — deliberately uses the same `num`,
// because a bare isFinite guard here would reintroduce the null→0 bug the
// agents just had.
const pull = (e) => ({ total: num(e.overUnder), spreadHome: num(e.spread) });

test('one non-live book is returned verbatim, named by that book', () => {
  const r = consensusOf([book('ESPN BET', -2.5, 43.5, { over: -105, under: -115 })], pull);
  assert.equal(r.spreadHome, -2.5);
  assert.equal(r.total, 43.5);
  assert.equal(r.overOdds, -105);
  assert.equal(r.underOdds, -115);
  assert.equal(r.books, 1);
  assert.equal(r.provider, 'ESPN BET');
});

test('live providers are excluded — the in-play total never reaches the row', () => {
  // The real ORE/MSU 2024 pair: close 52.5, live 39.5.
  const r = consensusOf([
    book('ESPN BET', -21.5, 52.5),
    book('ESPN Bet - Live Odds', -21.5, 39.5),
  ], pull);
  assert.equal(r.total, 52.5, 'live total must not be averaged in');
  assert.equal(r.books, 1, 'the live entry is not a book');
  assert.equal(r.provider, 'ESPN BET');
});

test('a game of only live quotes yields nothing rather than a fabricated close', () => {
  assert.equal(consensusOf([book('Caesars - Live Odds', -3, 44)], pull), null);
});

test('each field medians independently, so a book quoting one field still counts', () => {
  // Third book has no total; its spread must still vote.
  const r = consensusOf([
    book('A', -7, 44),
    book('B', -7.5, 45),
    book('C', -10.5, null),
  ], pull);
  assert.equal(r.spreadHome, -7.5, 'median of -10.5,-7.5,-7');
  assert.equal(r.total, 44.5, 'median of 44,45 — the book with no total does not drag it');
  assert.equal(r.books, 3);
});

test('an outlier book is outvoted rather than able to win on field count', () => {
  // The 2023 case: one Caesars entry at -7.5 against two at -10.5.
  const r = consensusOf([
    book('Caesars Sportsbook', -7.5, 47.5),
    book('Caesars (Colorado)', -10.5, 47.5),
    book('Caesars (New Jersey)', -10.5, 47.5),
  ], pull);
  assert.equal(r.spreadHome, -10.5);
  assert.equal(r.provider, 'median of 3 books');
});

test('lines stay on the 0.5 grid so pushes remain possible', () => {
  const r = consensusOf([book('A', -10, 44), book('B', -10.5, 45)], pull);
  // Math.abs: -10 % 0.5 is -0, which strict-equals neither 0 nor itself usefully.
  assert.equal(Math.abs(r.spreadHome % 0.5), 0, `${r.spreadHome} is not a real line`);
  assert.equal(Math.abs(r.total % 0.5), 0, `${r.total} is not a real line`);
});

test('prices are whole American odds, never fractional', () => {
  const r = consensusOf([
    book('A', -3, 44, { over: -110, under: -110 }),
    book('B', -3, 44, { over: -105, under: -115 }),
  ], pull);
  assert.ok(Number.isInteger(r.overOdds), `${r.overOdds} is not whole`);
  assert.ok(Number.isInteger(r.underOdds), `${r.underOdds} is not whole`);
});

test('a missing price stays missing instead of becoming 0', () => {
  // Number(null) === 0 and 0 is finite — the trap that turned absent prices
  // into an impossible American price of 0 in clv-tracker.
  const r = consensusOf([book('A', -3, 44)], pull);
  assert.equal(r.overOdds, null);
  assert.equal(r.homeSpreadOdds, null);
});

test('entries with neither field are not counted as books', () => {
  const r = consensusOf([book('A', -3, 44), book('Empty', null, null)], pull);
  assert.equal(r.books, 1);
  assert.equal(r.provider, 'A');
});

test('no entries at all yields null, not a zeroed row', () => {
  assert.equal(consensusOf([], pull), null);
  assert.equal(consensusOf(undefined, pull), null);
});
