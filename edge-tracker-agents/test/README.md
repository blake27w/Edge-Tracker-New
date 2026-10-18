# Tests

```
npm test
```

**Requires Node 22.3+** (the app itself needs only 20). The suite mocks ES
modules via `node:test`'s `mock.module`, which is behind
`--experimental-test-module-mocks`; the flag is already in the `test` script.
Nothing in `src/` depends on it — production still runs `node src/index.js` on
whatever Node Railway provides.

## What's covered, and why these cases

This suite exists because of five faults found in live production on
2026-10-14/17 that **all reported healthy**: 53 agents at `0 errors` and
`0 consecutive failures`, `/data-health` at `errorsToday: 0`. The orchestrator
marks a run failed only when it *throws*, so every one of them sat behind a
`catch (_)` or a silent `continue`. The tests are chosen to fail if any of
those regress.

| file | covers |
|---|---|
| `clv-tracker.test.js` | close/entry batch selection, the price-aware verdict, in-play exclusion |
| `data-health.test.js` | failed-vs-missing count classification, concurrency, estimate modes, caching |
| `grading.test.js` | queue windowing and ordering, dedupe keeper, alarm precision |
| `degradation-channel.test.js` | the shared reporting machinery and db-layer write reporting |

### The one case to keep if you keep nothing else

`clv-tracker.test.js` → *"close is the newest batch even when the game has more
rows than the query limit"*. The bug it covers was **invisible at small data
volumes**: with fewer than ~1000 snapshot rows for a game the old code was
correct, and only past that did it start comparing against a truncated close
and flagging every record suspect. The fixture deliberately seeds 1600 rows
(200 polls x 8 books) because anything smaller passes against the broken code.

### Writing new cases

`helpers/fake-db.js` records every call, so prefer asserting on the **shape** of
a query — ordering direction, presence of a lower bound, count mode — and not
only on its result. Three of the five faults were query-shape bugs that
returned perfectly valid-looking rows; a test that only checks the returned
data would have passed against every one of them.

Assert that a failure is reported at ERROR level and raised on the degradation
channel, not merely that it was caught. "It didn't crash" was true of all five
faults.

### Not covered

No integration tests — nothing here talks to Supabase or ESPN. The schema
itself is verified separately by applying `scripts/schema.sql` to a throwaway
Postgres (see DECISIONS.md D15/D18/D19); that is a manual step and worth
redoing after any schema change, since a single reserved word made the file
un-runnable for 106 days without anyone noticing.
