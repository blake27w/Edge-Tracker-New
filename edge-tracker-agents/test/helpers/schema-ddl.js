// ══════════════════════════════════════════════════════════════
// Read column types straight out of scripts/schema.sql, so a test can check a
// row an agent actually emits against the DDL that will receive it.
//
// Nothing in this repo applies schema.sql (D69/D70) — it is the written record
// of what was hand-run — which is exactly why the declaration and the row have
// to be compared by a test: Postgres is the only other thing that compares
// them, and it does so in production, on a whole batch, at once (D104).
//
// On vacuity. "Every column declared integer receives an integer" passes
// trivially when the list of integer columns is empty, and after D104 that is
// the literal state of `pred_market_edges` — the fix made its last integer
// column numeric. So `ints.length > 0` is not available as a universal guard
// (it would make a clean table unprovable). What IS available, and is what the
// guard has to be, is pinning the PARSE: assertDeclared() names the columns the
// caller's reasoning depends on, so a reformatted `create table` block, a
// renamed table or a typo'd regex fails loudly instead of yielding an empty
// list that every downstream assertion then agrees with.
// ══════════════════════════════════════════════════════════════
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SCHEMA = new URL('../../scripts/schema.sql', import.meta.url);

export const readSchema = () => readFileSync(SCHEMA, 'utf8');

// Column name → declared type for one `create table` block in schema.sql,
// plus any later `alter table … add column` for the same table.
export function declaredColumns(sql, table) {
  const block = new RegExp(`create table if not exists ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
  assert.ok(block, `no create table block for ${table} in schema.sql`);
  const cols = {};
  for (const raw of block[1].split('\n')) {
    const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '');
    if (!line || /^(primary|unique|foreign|constraint|check)\b/i.test(line)) continue;
    const m = /^([a-z_][a-z0-9_]*)\s+(.+)$/i.exec(line);
    if (m) cols[m[1]] = m[2].trim().toLowerCase();
  }
  const alter = new RegExp(`alter table ${table} add column if not exists ([a-z_][a-z0-9_]*)\\s+([^;]+);`, 'gi');
  for (const m of sql.matchAll(alter)) cols[m[1]] = m[2].trim().toLowerCase();
  assert.ok(Object.keys(cols).length > 0, `parsed 0 columns out of ${table} — the parse is broken, not the table empty`);
  return cols;
}

// The anti-vacuity guard. Every column named here must have come out of the
// parse with a non-empty declared type; without it an empty or half-read `cols`
// satisfies every "each integer column got an integer" assertion by matching
// nothing at all.
export function assertDeclared(cols, table, names) {
  const missing = names.filter((c) => !cols[c]);
  assert.deepEqual(missing, [],
    `schema.sql parse for ${table} did not yield ${missing.join(', ')} — the DDL parse is vacuous, not the table clean`);
}

// The columns of `cols` declared as some integer type. May legitimately be
// empty (see the vacuity note above); callers guard with assertDeclared, and
// callers whose table is known to keep an integer column assert on the length.
export function integerColumns(cols) {
  return Object.keys(cols).filter((c) => /^(integer|int|int4|bigint|int8|smallint|int2)\b/.test(cols[c]));
}

// Which of `row`'s values would be rejected by an integer column, described so
// the failure message names the column, its declared type and the value.
export function integerViolations(cols, ints, row) {
  return ints
    .filter((c) => row[c] != null && !Number.isInteger(row[c]))
    .map((c) => `${c} (declared ${cols[c]}) got ${JSON.stringify(String(row[c]))}`);
}
