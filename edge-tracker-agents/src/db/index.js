// ══════════════════════════════════════════════════════════════
// Supabase client wrapper. Thin helpers over @supabase/supabase-js
// so agents don't each re-implement insert/upsert/select patterns.
// ══════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';
import config from '../config/index.js';
import { reportDegraded } from '../store/index.js';

let client = null;
if (config.supabase.url && config.supabase.key) {
  try {
    client = createClient(config.supabase.url, config.supabase.key, {
      auth: { persistSession: false },
    });
  } catch (e) {
    // A malformed SUPABASE_URL throws here — log it loudly but DO NOT crash the
    // process, or the whole service fails to boot (and the deploy is marked failed).
    console.error(`[db] Supabase client init failed — check SUPABASE_URL format (got "${config.supabase.url}"): ${e.message}`);
    client = null;
  }
}

export const isConnected = () => !!client;

// ── Failed writes must not be able to hide ──────────────────────────
// 92 call sites across the agents wrap their DB writes in
// `catch (e) { logger.warn(...) }`. A warn doesn't fail the run, so an agent
// whose entire output fails to persist still reports success with 0 errors —
// and a WARN line scrolls past in a log nobody reads.
//
// `public_splits` is the proof: `freeze` is a reserved keyword, so the ALTER
// adding it was a syntax error that aborted schema.sql from 2026-07-03, the
// column never existed, and every insert has failed ever since. The agent
// reported "3 splits · 2 freeze" and 0 failures for 103 days while the table
// sat at 671 rows with 0 written today.
//
// Reporting here covers every one of those call sites at once. The error is
// still rethrown unchanged, so no control flow changes — this only makes the
// failure visible to the watchdog.
function reportWriteFailure(op, table, error) {
  const missing = isMissingRelation(error);
  reportDegraded(`write|${table}`, missing
    ? `${op} ${table} failing — schema out of date (${error.message}); run scripts/schema.sql`
    : `${op} ${table} failing — ${error.message}`);
}

function ensure() {
  if (!client) throw new Error('Supabase not configured (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
  return client;
}

// Insert rows (array or single). Returns inserted rows.
export async function insert(table, rows) {
  if (config.dryRun || !client) return { skipped: true, count: Array.isArray(rows) ? rows.length : 1 };
  const { data, error } = await ensure().from(table).insert(rows).select();
  if (error) { reportWriteFailure('insert', table, error); throw new Error(`insert ${table}: ${error.message}`); }
  return { data, count: data?.length ?? 0 };
}

// Upsert rows on a conflict target. options.ignoreDuplicates keeps the first
// row (used for opening-line capture — never overwrite the recorded opener).
export async function upsert(table, rows, onConflict, options = {}) {
  if (config.dryRun || !client) return { skipped: true, count: Array.isArray(rows) ? rows.length : 1 };
  const opts = {};
  if (onConflict) opts.onConflict = onConflict;
  if (options.ignoreDuplicates) opts.ignoreDuplicates = true;
  const q = ensure().from(table).upsert(rows, Object.keys(opts).length ? opts : undefined).select();
  const { data, error } = await q;
  if (error) { reportWriteFailure('upsert', table, error); throw new Error(`upsert ${table}: ${error.message}`); }
  return { data, count: data?.length ?? 0 };
}

// Update rows matching a filter object (equality only).
export async function update(table, patch, match) {
  if (config.dryRun || !client) return { skipped: true };
  let q = ensure().from(table).update(patch);
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const { data, error } = await q.select();
  if (error) { reportWriteFailure('update', table, error); throw new Error(`update ${table}: ${error.message}`); }
  return { data, count: data?.length ?? 0 };
}

// Delete rows. opts: { match (equality), in ({col: [vals]}) }
export async function del(table, opts = {}) {
  if (config.dryRun || !client) return { skipped: true };
  let q = ensure().from(table).delete();
  if (opts.match) for (const [k, v] of Object.entries(opts.match)) q = q.eq(k, v);
  if (opts.in) for (const [k, vals] of Object.entries(opts.in)) q = q.in(k, vals);
  const { error } = await q;
  if (error) { reportWriteFailure('delete', table, error); throw new Error(`delete ${table}: ${error.message}`); }
  return { ok: true };
}

// Generic select. opts: { match, in, gte, lte, order, limit }
export async function select(table, columns = '*', opts = {}) {
  if (!client) return [];
  let q = ensure().from(table).select(columns);
  if (opts.match) for (const [k, v] of Object.entries(opts.match)) q = q.eq(k, v);
  if (opts.in) for (const [k, vals] of Object.entries(opts.in)) q = q.in(k, vals);
  if (opts.gte) for (const [k, v] of Object.entries(opts.gte)) q = q.gte(k, v);
  if (opts.lte) for (const [k, v] of Object.entries(opts.lte)) q = q.lte(k, v);
  if (opts.order) q = q.order(opts.order.column, { ascending: !!opts.order.ascending });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`select ${table}: ${error.message}`);
  return data || [];
}

// PostgREST/Postgres signals for "this relation or column isn't there" as
// opposed to "the query failed". Callers need the difference: a missing table
// is a migration to run, a timeout is a performance bug. Conflating them is
// how a failing count got reported as an absent one.
const MISSING_CODES = new Set(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205']);
export function isMissingRelation(e) {
  if (!e) return false;
  if (e.code && MISSING_CODES.has(e.code)) return true;
  return /does not exist|could not find|schema cache|undefined table|undefined column/i.test(e.message || '');
}

// Count rows (no row data fetched).
// opts: { match (equality), gte, mode }
//   mode: 'exact' (default) — a true COUNT(*), i.e. a full scan on a big table.
//         'estimated'       — planner estimate (reltuples) for large tables,
//                             exact for small ones. Orders of magnitude cheaper.
//         'planned'         — always the planner estimate.
// Errors carry `.code` and `.missing` so callers can tell a missing table from
// a statement timeout instead of swallowing both.
export async function count(table, opts = {}) {
  if (!client) return null;
  const mode = opts.mode || 'exact';
  let q = ensure().from(table).select('*', { count: mode, head: true });
  if (opts.match) for (const [k, v] of Object.entries(opts.match)) q = q.eq(k, v);
  if (opts.gte) for (const [k, v] of Object.entries(opts.gte)) q = q.gte(k, v);
  const { count: c, error } = await q;
  if (error) {
    const err = new Error(`count ${table}: ${error.message}`);
    err.code = error.code;
    err.missing = isMissingRelation(error);
    throw err;
  }
  return c;
}

export default { isConnected, insert, upsert, update, del, select, count, isMissingRelation };
