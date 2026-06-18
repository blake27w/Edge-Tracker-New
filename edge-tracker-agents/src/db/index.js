// ══════════════════════════════════════════════════════════════
// Supabase client wrapper. Thin helpers over @supabase/supabase-js
// so agents don't each re-implement insert/upsert/select patterns.
// ══════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';
import config from '../config/index.js';

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

function ensure() {
  if (!client) throw new Error('Supabase not configured (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
  return client;
}

// Insert rows (array or single). Returns inserted rows.
export async function insert(table, rows) {
  if (config.dryRun || !client) return { skipped: true, count: Array.isArray(rows) ? rows.length : 1 };
  const { data, error } = await ensure().from(table).insert(rows).select();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
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
  if (error) throw new Error(`upsert ${table}: ${error.message}`);
  return { data, count: data?.length ?? 0 };
}

// Update rows matching a filter object (equality only).
export async function update(table, patch, match) {
  if (config.dryRun || !client) return { skipped: true };
  let q = ensure().from(table).update(patch);
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const { data, error } = await q.select();
  if (error) throw new Error(`update ${table}: ${error.message}`);
  return { data, count: data?.length ?? 0 };
}

// Delete rows. opts: { match (equality), in ({col: [vals]}) }
export async function del(table, opts = {}) {
  if (config.dryRun || !client) return { skipped: true };
  let q = ensure().from(table).delete();
  if (opts.match) for (const [k, v] of Object.entries(opts.match)) q = q.eq(k, v);
  if (opts.in) for (const [k, vals] of Object.entries(opts.in)) q = q.in(k, vals);
  const { error } = await q;
  if (error) throw new Error(`delete ${table}: ${error.message}`);
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

export default { isConnected, insert, upsert, update, del, select };
