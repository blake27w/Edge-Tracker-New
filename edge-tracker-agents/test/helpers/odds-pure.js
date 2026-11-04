// ══════════════════════════════════════════════════════════════
// Minimal harness for the odds agent's PURE exports (steamSafeMovements,
// movementFrom, baselineFromSnapshots, isMissingColumn).
//
// Why a helper and not the inline `before()` the run-driving tests use: the
// bounds this file exists to exercise (STEAM_MAX_GAP_MIN, MOVE_MAX_GAP_MIN) are
// module-level consts read from process.env at FIRST IMPORT, so one env setting
// needs one module instance, which needs one file. Three near-identical 70-line
// harnesses would be three places to keep in sync; this is one.
//
// Only `db` and `utils` are mocked, and only because they pull packages that
// are absent from this worktree's node_modules. `config`, `store` and
// `games/lines` are the real ones — nothing here depends on their contents, and
// a fake would be a fake for no reason.
// ══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { fakeDb, fakeLogger } from './fake-db.js';

// Call from `before()`, after setting any ODDS_* env var the bounds read.
export async function loadOddsPure() {
  const fdb = fakeDb({});
  mock.module(import.meta.resolve('../../src/db/index.js'), {
    defaultExport: fdb,
    namedExports: { isMissingRelation: fdb.isMissingRelation },
  });
  const fl = fakeLogger();
  mock.module(import.meta.resolve('../../src/utils/index.js'), {
    namedExports: { logger: fl.logger, notifyAll: async () => ({ total: 0 }) },
  });
  const mod = await import('../../src/agents/odds/index.js');
  return { mod, fdb, logs: fl.lines };
}

// A movement row shaped like the ones `movementFrom` produces — only `gap_min`
// matters to the steam filter, but the rest is carried so a test that leaks a
// row into `sharp` would behave the way production does.
export const moveRow = (gap_min) => ({
  sport: 'A', game_id: 'g1', book: 'draftkings', market: 'totals', side: 'Over',
  line_open: 44.5, line_current: 43.5, moved: -1, direction: 'down',
  baseline_source: 'rehydrated', gap_min,
});
