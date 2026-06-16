// ══════════════════════════════════════════════════════════════
// Run a single agent once and print its result.
//   node scripts/test-agent.js odds
//   node scripts/test-agent.js signal
// Agents that depend on upstream data (signal, prop-engine) work best
// after running `odds` (and the intel agents) first in the same process,
// so this also accepts multiple names run in order:
//   node scripts/test-agent.js odds sharp public-splits signal
// ══════════════════════════════════════════════════════════════
import { detectModel } from '../src/utils/index.js';

const MODULES = {
  odds: () => import('../src/agents/odds/index.js'),
  injury: () => import('../src/agents/injury/index.js'),
  weather: () => import('../src/agents/weather/index.js'),
  sharp: () => import('../src/agents/sharp/index.js'),
  power: () => import('../src/agents/power/index.js'),
  'public-splits': () => import('../src/agents/public-splits/index.js'),
  'schedule-spot': () => import('../src/agents/schedule-spot/index.js'),
  'mlb-context': () => import('../src/agents/mlb-context/index.js'),
  signal: () => import('../src/agents/signal-engine/index.js'),
  'prop-engine': () => import('../src/agents/prop-engine/index.js'),
  clv: () => import('../src/agents/clv-tracker/index.js'),
  grading: () => import('../src/agents/grading/index.js'),
};

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.log('Usage: node scripts/test-agent.js <agent> [<agent>...]');
    console.log('Agents:', Object.keys(MODULES).join(', '));
    process.exit(1);
  }
  await detectModel();
  for (const name of names) {
    const loader = MODULES[name];
    if (!loader) { console.error(`Unknown agent: ${name}`); continue; }
    const mod = (await loader()).default;
    console.log(`\n▶ Running ${name}…`);
    const t = Date.now();
    try {
      const out = await mod.run();
      console.log(`✓ ${name} (${Date.now() - t}ms): ${out?.summary || 'done'}`);
      if (out?.data) console.log('  data:', JSON.stringify(out.data));
    } catch (e) {
      console.error(`✗ ${name} failed: ${e.message}`);
    }
  }
  process.exit(0);
}

main();
