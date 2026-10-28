-- ════════════════════════════════════════════════════════════════
-- /data-health count indexes — SAFE migration for a POPULATED database
--
-- WHY THIS FILE EXISTS, SEPARATE FROM schema.sql
--
-- schema.sql creates these with a plain `create index`, which is correct for a
-- fresh/empty database and must stay that way (it has to run inside the
-- Supabase SQL editor's transaction). But a plain `create index` takes a
-- SHARE lock on the table, which BLOCKS every insert for as long as the build
-- takes. On production `line_snapshots` — large enough that an exact count(*)
-- times out — that means the odds agent silently drops snapshots mid-build,
-- which would corrupt the CLV data those snapshots feed.
--
-- `concurrently` builds without blocking writes. It cannot run inside a
-- transaction block, which is exactly why it can't live in schema.sql:
--   ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block
-- The Supabase SQL editor wraps a multi-statement script in a transaction, so
-- pasting this whole file there fails.
--
-- HOW TO RUN
--
--   Preferred — psql, which does not wrap statements in a transaction:
--     psql "$SUPABASE_DB_URL" -f scripts/migrate-data-health-indexes.sql
--   (connection string: Supabase dashboard → Project Settings → Database →
--   Connection string → URI. Use the direct connection, not the pooler:
--   pgbouncer in transaction mode cannot run `concurrently` either.)
--
--   Otherwise — Supabase SQL editor, ONE STATEMENT AT A TIME. Paste a single
--   `create index concurrently ...;` line, run it, wait for it to finish, then
--   the next. Each is independently safe and idempotent.
--
-- ORDER OF OPERATIONS: run THIS file first, then schema.sql. The `if not
-- exists` in schema.sql then finds every index already present and does
-- nothing, so the blocking path is never taken.
--
-- Safe to re-run. Each statement is `if not exists`.
-- ════════════════════════════════════════════════════════════════

-- Each of these tables is counted by /data-health with a bare
-- `<ts_col> >= midnight` filter. Their timestamps previously appeared only as
-- the TRAILING column of a composite index (e.g. line_snapshots
-- (game_id, market, fetched_at desc)), which Postgres cannot use for a filter
-- on the timestamp alone — verified against a 400k-row table: Parallel Seq
-- Scan 16.2ms → Bitmap Index Scan 3.9ms, and the gap widens with table size
-- because the seq scan is O(table) while the index scan is O(matching rows).

-- Biggest first: these are the ones that actually hurt.
create index concurrently if not exists line_snapshots_fetched_idx   on line_snapshots   (fetched_at desc);
create index concurrently if not exists injury_updates_fetched_idx   on injury_updates   (fetched_at desc);
create index concurrently if not exists line_signals_fetched_idx     on line_signals     (fetched_at desc);
create index concurrently if not exists sharp_signals_detected_idx   on sharp_signals    (detected_at desc);
create index concurrently if not exists book_edge_log_detected_idx   on book_edge_log    (detected_at desc);
create index concurrently if not exists ev_opportunities_fetched_idx on ev_opportunities (fetched_at desc);
create index concurrently if not exists opp_results_graded_idx       on opp_results      (graded_at desc);
create index concurrently if not exists game_weather_fetched_idx     on game_weather     (fetched_at desc);

-- Small tables; included for completeness and so schema.sql finds them present.
create index concurrently if not exists monitor_scores_scored_idx    on monitor_scores   (scored_at desc);
create index concurrently if not exists clv_records_recorded_idx     on clv_records      (recorded_at desc);
create index concurrently if not exists public_splits_fetched_idx    on public_splits    (fetched_at desc);
create index concurrently if not exists scan_runs_status_started_idx on scan_runs        (status, started_at desc);
-- Added 2026-10-17 after auditing agent summaries against their data: the
-- /data-health spec list went from 11 tables to all 44 that agents write to
-- (public_splits sat broken for 106 days and was caught only because it
-- happened to be one of the original eleven). These six are the newly-counted
-- tables whose timestamp was, again, only the TRAILING column of a composite
-- index — same unusable shape as the original twelve. The rest of the new
-- tables are small reference tables (a few hundred rows, one per team/game)
-- where a seq scan is free and an index would be 27 more things to migrate.
create index concurrently if not exists line_movements_detected_idx on line_movements (detected_at desc);
create index concurrently if not exists opening_lines_captured_idx   on opening_lines  (captured_at desc);
create index concurrently if not exists prop_snapshots_fetched_idx   on prop_snapshots (fetched_at desc);
create index concurrently if not exists fair_line_log_fetched_idx    on fair_line_log  (fetched_at desc);
create index concurrently if not exists schedule_spots_fetched_idx   on schedule_spots (fetched_at desc);
create index concurrently if not exists tennis_markets_fetched_idx   on tennis_markets (fetched_at desc);


-- ── Afterwards ──────────────────────────────────────────────────────
-- 1) A `concurrently` build that is interrupted leaves an INVALID index behind,
--    which the planner ignores (so you'd silently keep the seq scans). Check:
--
--      select c.relname
--        from pg_index i join pg_class c on c.oid = i.indexrelid
--       where not i.indisvalid;
--
--    Drop any row this returns (`drop index concurrently <name>;`) and re-run
--    that one statement.
--
-- 2) /data-health serves the big tables' totals from the planner estimate
--    (PostgREST count=estimated → reltuples), which is only as fresh as the
--    last ANALYZE. Autovacuum normally keeps it current; seed it once now so
--    the first response isn't estimating from stale stats:
--
--      analyze line_snapshots;
--      analyze injury_updates;
