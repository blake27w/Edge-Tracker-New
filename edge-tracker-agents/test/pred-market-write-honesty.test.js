// ══════════════════════════════════════════════════════════════
// A rejected pred_market_edges batch must be REPORTED, not warned about.
//
// The companion of pred-market-price-type.test.js. That one fixes the cause
// (`price integer` could not hold a half-point consensus median); this one
// fixes the reason it took nine lost runs to notice: the insert's catch warned
// and the run summary still read `9 exchange edges`, which is the count BUILT.
// The only trace was the `write|pred_market_edges` degraded key.
//
// PostgREST applies a batch insert as one statement, so the loss is always the
// whole run — there is no partial-write case to count here, unlike the chunked
// line_snapshots write this follows (D99). What must hold is that the summary
// and `data` say so, and that the loss logs at error: a warn in a 100-entry
// ring buffer is how the first nine runs disappeared.
// ══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

const HOME = 'Boston Celtics', AWAY = 'Miami Heat';
const game = {
  sport: 'NBA', game_id: 'g-nba-1', home: HOME, away: AWAY,
  commence_time: '2026-11-07T23:00:00Z',
  books: {
    dk: { label: 'DK', markets: { [`h2h:${HOME}`]: { price: 120 }, [`h2h:${AWAY}`]: { price: -140 } } },
    fd: { label: 'FD', markets: { [`h2h:${HOME}`]: { price: 131 }, [`h2h:${AWAY}`]: { price: -150 } } },
  },
};
const polyPayload = [{
  outcomes: JSON.stringify([HOME, AWAY]),
  outcomePrices: JSON.stringify(['0.50', '0.50']),
  volumeNum: 250000,
}];

const logs = { info: [], warn: [], error: [] };
const realFetch = global.fetch;
let res;

before(async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('polymarket')) return { ok: true, json: async () => polyPayload };
    return { ok: true, json: async () => ({ markets: [] }) };
  };
  mock.module(import.meta.resolve('../src/config/index.js'), {
    defaultExport: { predictionMarkets: true, dryRun: false },
  });
  // The live rejection, verbatim from db.insert's rethrow shape.
  mock.module(import.meta.resolve('../src/db/index.js'), {
    defaultExport: {
      async insert() {
        throw new Error('insert pred_market_edges: invalid input syntax for type integer: "125.5"');
      },
    },
  });
  mock.module(import.meta.resolve('../src/store/index.js'), {
    namedExports: { getGames: () => [game], setPredMarket: () => {} },
  });
  mock.module(import.meta.resolve('../src/utils/index.js'), {
    namedExports: {
      logger: {
        info: (...a) => logs.info.push(a.join(' ')),
        warn: (...a) => logs.warn.push(a.join(' ')),
        error: (...a) => logs.error.push(a.join(' ')),
      },
    },
  });
  const agent = (await import('../src/agents/pred-market/index.js')).default;
  res = await agent.run();
});
after(() => { global.fetch = realFetch; mock.reset(); });

test('a failed pred_market_edges insert is reported as lost, not as success', () => {
  assert.equal(res.data.edges, 1, 'the scripted slate must still produce one edge');
  assert.equal(res.data.written, 0, 'nothing landed, so `written` must be 0');
  assert.equal(res.data.lost, 1, 'the whole batch is lost — `lost` must say so');
  assert.match(res.summary, /1 exchange edges \(0 written, 1 lost/,
    `the summary must name the loss, not just the count built — got ${JSON.stringify(res.summary)}`);
  assert.equal(logs.error.length, 1, 'a lost batch logs exactly once, at error level');
  assert.match(logs.error[0], /invalid input syntax for type integer/,
    'the error must carry the database message that explains the loss');
  assert.deepEqual(logs.warn, [], 'a lost write must not be downgraded to warn');
});
