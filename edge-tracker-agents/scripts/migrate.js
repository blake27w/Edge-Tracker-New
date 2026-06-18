// ══════════════════════════════════════════════════════════════
// Migration helper. Supabase's REST client can't execute arbitrary
// DDL, so this script verifies the connection and reports which
// schema tables already exist vs. are missing, then points you at
// scripts/schema.sql to run in the SQL editor.
// ══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from '../src/db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TABLES = [
  'scan_runs', 'api_usage', 'opening_lines', 'line_snapshots', 'line_movements', 'injury_updates',
  'game_weather', 'sharp_signals', 'power_ratings', 'public_splits', 'schedule_spots',
  'mlb_context', 'player_usage', 'prop_snapshots', 'monitor_scores', 'clv_records',
  'alert_log', 'subscribers',
];

async function main() {
  if (!db.isConnected()) {
    console.error('✗ Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  console.log('Checking schema against Supabase…\n');
  const missing = [];
  for (const t of TABLES) {
    try {
      await db.select(t, 'id', { limit: 1 });
      console.log(`  ✓ ${t}`);
    } catch (e) {
      console.log(`  ✗ ${t} — ${e.message.includes('does not exist') ? 'missing' : e.message}`);
      missing.push(t);
    }
  }
  if (missing.length) {
    console.log(`\n${missing.length} table(s) missing. Run the schema in the Supabase SQL editor:`);
    console.log(`  ${join(__dirname, 'schema.sql')}`);
    // Print the SQL so it can be piped if desired.
    if (process.argv.includes('--print')) {
      console.log('\n' + readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
    } else {
      console.log('  (re-run with --print to dump the SQL to stdout)');
    }
    process.exit(2);
  }
  console.log('\n✓ All tables present.');
}

main().catch((e) => { console.error(e); process.exit(1); });
