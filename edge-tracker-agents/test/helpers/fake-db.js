// ══════════════════════════════════════════════════════════════
// An in-memory stand-in for src/db, good enough for the query shapes the
// agents actually use: equality `match`, `in`, `gte`/`lte` on timestamps,
// `order`, and `limit`. Records every call so a test can assert on the SHAPE
// of a query (ordering direction, presence of a lower bound) and not just on
// its result — several of the bugs this suite covers were query-shape bugs
// that returned perfectly valid-looking rows.
// ══════════════════════════════════════════════════════════════

export function fakeDb(tables = {}) {
  const calls = { select: [], insert: [], upsert: [], update: [], del: [], count: [] };
  const data = { ...tables };

  const matches = (row, opts) => {
    if (opts.match) for (const [k, v] of Object.entries(opts.match)) if (row[k] !== v) return false;
    if (opts.in) for (const [k, vals] of Object.entries(opts.in)) if (!vals.includes(row[k])) return false;
    if (opts.gte) for (const [k, v] of Object.entries(opts.gte)) if (!(new Date(row[k]) >= new Date(v))) return false;
    if (opts.lte) for (const [k, v] of Object.entries(opts.lte)) if (!(new Date(row[k]) <= new Date(v))) return false;
    return true;
  };

  const api = {
    // Test knobs ─────────────────────────────────────────────────
    calls,
    rows: (t) => data[t] || [],
    setRows: (t, r) => { data[t] = r; },
    // Make a given table's operation fail, to test error paths.
    fail: {},          // e.g. { 'select:line_snapshots': new Error('boom') }

    // src/db surface ─────────────────────────────────────────────
    isConnected: () => true,
    isMissingRelation: (e) => !!e && (['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'].includes(e.code)
      || /does not exist|could not find|schema cache/i.test(e.message || '')),

    async select(table, _cols, opts = {}) {
      calls.select.push({ table, opts });
      if (api.fail[`select:${table}`]) throw api.fail[`select:${table}`];
      let out = (data[table] || []).filter((r) => matches(r, opts));
      if (opts.order) {
        const c = opts.order.column;
        out = [...out].sort((a, b) => {
          const d = new Date(a[c]).getTime() - new Date(b[c]).getTime();
          return opts.order.ascending ? d : -d;
        });
      }
      return opts.limit ? out.slice(0, opts.limit) : out;
    },

    async insert(table, rows) {
      calls.insert.push({ table, rows });
      if (api.fail[`insert:${table}`]) throw api.fail[`insert:${table}`];
      const arr = Array.isArray(rows) ? rows : [rows];
      data[table] = [...(data[table] || []), ...arr];
      return { data: arr, count: arr.length };
    },

    async upsert(table, rows, onConflict) {
      calls.upsert.push({ table, rows, onConflict });
      if (api.fail[`upsert:${table}`]) throw api.fail[`upsert:${table}`];
      return { data: rows, count: rows.length };
    },

    async update(table, patch, match) {
      calls.update.push({ table, patch, match });
      if (api.fail[`update:${table}`]) throw api.fail[`update:${table}`];
      let n = 0;
      for (const r of data[table] || []) if (r.id === match.id) { Object.assign(r, patch); n++; }
      return { count: n };
    },

    async del(table, opts = {}) {
      calls.del.push({ table, opts });
      if (opts.in) for (const [k, vals] of Object.entries(opts.in)) {
        data[table] = (data[table] || []).filter((r) => !vals.includes(r[k]));
      }
      return { ok: true };
    },

    async count(table, opts = {}) {
      const scope = opts.gte ? 'today' : 'total';
      calls.count.push({ table, scope, mode: opts.mode || 'exact', at: Date.now() });
      const f = api.fail[`count:${table}.${scope}`] || api.fail[`count:${table}`];
      if (f) { if (f === 'hang') { await new Promise(() => {}); } throw f; }
      return (data[table] || []).filter((r) => matches(r, opts)).length;
    },
  };
  return api;
}

// A logger that collects instead of printing, so tests can assert that a
// failure was reported at ERROR level rather than buried in a warn.
export function fakeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    logger: {
      info: (a, b) => lines.info.push(`${a}: ${b}`),
      warn: (a, b) => lines.warn.push(`${a}: ${b}`),
      error: (a, b) => lines.error.push(`${a}: ${b}`),
    },
  };
}
