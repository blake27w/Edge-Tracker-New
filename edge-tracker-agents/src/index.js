// ══════════════════════════════════════════════════════════════
// Entry point: detect the Anthropic model, start the orchestrator,
// and serve the dashboard API (/health, /plays, /feed) with CORS for
// the GitHub Pages frontend.
// ══════════════════════════════════════════════════════════════
import http from 'node:http';
import config from './config/index.js';
import db from './db/index.js';
import { detectModel, getFeed, getMetrics, logger } from './utils/index.js';
import orchestrator from './orchestrator/index.js';
import { getGames, getPlays, getPropPlays, getEvPlays } from './store/index.js';
import { getOddsBudget } from './agents/odds/index.js';
import { buildWorkbook } from './export/index.js';
import { buildGames } from './games/index.js';

// ── CORS ────────────────────────────────────────────────────────
function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = config.server.corsOrigins;
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (allowed.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function systemHealth() {
  const m = getMetrics();
  let oddsBudget;
  try { oddsBudget = getOddsBudget(); } catch (_) { oddsBudget = null; }
  return {
    oddsApi: oddsBudget,
    oddsRequestsRemaining: oddsBudget ? oddsBudget.remaining : null,
    anthropicModel: config.anthropic.model,
    anthropicCallsToday: m.anthropicCalls,
    smsSentToday: m.smsSent,
    emailsSentToday: m.emailsSent,
    gamesMonitored: getGames().length,
    dbConnected: db.isConnected(),
  };
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');

  // Excel export — builds a multi-sheet .xlsx from Supabase and downloads it.
  if (url.pathname === '/export' || url.pathname === '/export.xlsx') {
    try {
      const wb = await buildWorkbook();
      const buf = await wb.xlsx.writeBuffer();
      const fname = `edge-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fname}"`,
      });
      return res.end(Buffer.from(buf));
    } catch (e) {
      logger.error('export', e.message);
      return json(res, 500, { error: 'export failed', detail: e.message });
    }
  }

  switch (url.pathname) {
    case '/':
    case '/health':
      return json(res, 200, {
        ok: true,
        time: new Date().toISOString(),
        model: config.anthropic.model,
        agents: orchestrator.getHealth(),
        system: systemHealth(),
      });
    case '/plays':
      return json(res, 200, { plays: getPlays(), props: getPropPlays(), ev: getEvPlays() });
    case '/games': {
      try {
        const board = await buildGames(url.searchParams.get('sport') || '');
        return json(res, 200, board);
      } catch (e) {
        logger.error('games', e.message);
        return json(res, 500, { error: 'games failed', detail: e.message });
      }
    }
    case '/feed':
      return json(res, 200, { feed: getFeed() });
    case '/budget':
      return json(res, 200, getOddsBudget());
    default:
      return json(res, 404, { error: 'not found' });
  }
});

async function main() {
  logger.info('startup', `Edge Tracker Agents booting (tier=${config.oddsApi.tier}, dryRun=${config.dryRun})`);
  if (!db.isConnected()) logger.warn('startup', 'Supabase not configured — running with in-memory store only.');

  // Start the HTTP server FIRST so the /health healthcheck passes immediately,
  // before the (potentially slow) Anthropic model detection runs. Otherwise a
  // slow probe can blow the platform healthcheck timeout and fail the deploy.
  server.listen(config.server.port, () => {
    logger.info('startup', `API listening on :${config.server.port} (CORS: ${config.server.corsOrigins.join(', ')})`);
  });

  await detectModel();
  orchestrator.start();
}

function shutdown(sig) {
  logger.info('startup', `${sig} received — shutting down`);
  orchestrator.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((e) => { logger.error('startup', e.stack || e.message); process.exit(1); });
