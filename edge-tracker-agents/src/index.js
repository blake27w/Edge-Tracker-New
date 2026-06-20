// ══════════════════════════════════════════════════════════════
// Entry point: detect the Anthropic model, start the orchestrator,
// and serve the dashboard API (/health, /plays, /feed) with CORS for
// the GitHub Pages frontend.
// ══════════════════════════════════════════════════════════════
import http from 'node:http';
import config from './config/index.js';
import db from './db/index.js';
import { detectModel, getFeed, getMetrics, getClaudeUsage, logger } from './utils/index.js';
import orchestrator from './orchestrator/index.js';
import { getGames, getPlays, getPropPlays, getEvPlays, getArbPlays, getBacktest, getStaleLines, getDivergence, getKeyNumbers, getFairLine, getCombatPlays, getNflWinTotals, getNflSchedule, getNflProps, getFadePlays, getClvReport, getCombatDerivs, getWatchdog } from './store/index.js';
import { getOddsBudget } from './agents/odds/index.js';
import { buildWorkbook } from './export/index.js';
import { buildGames } from './games/index.js';
import { listResearch, addResearch, deleteResearch } from './research/index.js';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-research-token, Authorization');
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Research writes require the token (header, Bearer, or ?token=). Blank token = disabled.
function authed(req, url) {
  const t = config.research.token;
  if (!t) return false;
  const h = req.headers['x-research-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || url.searchParams.get('token');
  return h === t;
}

// Minimal MCP (JSON-RPC) endpoint so Claude.ai can push research via a connector.
async function handleMcp(req, res, url) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    return res.write(': edge-tracker-mcp\n\n');
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const msg = await readBody(req);
  const id = msg.id ?? null;
  const reply = (result) => json(res, 200, { jsonrpc: '2.0', id, result });
  const rpcErr = (code, message) => json(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  if (msg.method && msg.method.startsWith('notifications/')) { res.writeHead(202); return res.end(); }
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'edge-tracker-research', version: '1.0.0' } });
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: [{
        name: 'add_research',
        description: 'Save a research note or pick to the Edge Tracker dashboard. Use type "pick" with market+side for a bet you want graded; otherwise it is a note tagged to a game.',
        inputSchema: { type: 'object', properties: {
          type: { type: 'string', enum: ['note', 'pick'], description: 'note (default) or pick' },
          sport: { type: 'string', description: 'e.g. NBA, NFL, MLB' },
          matchup: { type: 'string', description: '"Away @ Home" — needed in this form for picks to grade' },
          game_id: { type: 'string', description: 'optional Edge Tracker game id to tag' },
          body: { type: 'string', description: 'the research / rationale' },
          market: { type: 'string', description: 'pick only: total | ml | spread' },
          side: { type: 'string', description: 'pick only: Over/Under or the team name' },
          line: { type: 'number' }, odds: { type: 'number' }, confidence: { type: 'number' },
        }, required: ['body'] },
      }] });
    case 'tools/call': {
      if (!authed(req, url)) return rpcErr(-32001, 'unauthorized — append ?token=... to the MCP URL');
      if (msg.params?.name !== 'add_research') return rpcErr(-32601, `unknown tool ${msg.params?.name}`);
      try {
        const row = await addResearch({ ...(msg.params.arguments || {}), source: 'chat' });
        return reply({ content: [{ type: 'text', text: `Saved ${row.type} to Edge Tracker${row.matchup ? ` for ${row.matchup}` : ''}.` }] });
      } catch (e) { return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
    }
    default: return rpcErr(-32601, `method not found: ${msg.method}`);
  }
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

  // Research notes & picks API.
  if (url.pathname === '/research') {
    if (req.method === 'GET') {
      const rows = await listResearch({
        game_id: url.searchParams.get('game_id') || undefined,
        sport: url.searchParams.get('sport') || undefined,
        type: url.searchParams.get('type') || undefined,
      });
      return json(res, 200, { research: rows });
    }
    if (req.method === 'POST') {
      if (!authed(req, url)) return json(res, 401, { error: 'unauthorized — set RESEARCH_TOKEN and provide it' });
      try { return json(res, 200, { ok: true, row: await addResearch(await readBody(req)) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    return json(res, 405, { error: 'method not allowed' });
  }
  if (url.pathname.startsWith('/research/') && req.method === 'DELETE') {
    if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' });
    try { await deleteResearch(decodeURIComponent(url.pathname.split('/')[2] || '')); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/mcp') return handleMcp(req, res, url);

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
      return json(res, 200, { plays: getPlays(), props: getPropPlays(), ev: getEvPlays(), arb: getArbPlays(), backtest: getBacktest(), stale: getStaleLines(), divergence: getDivergence(), keyNumbers: getKeyNumbers(), fairLine: getFairLine(), combat: getCombatPlays(), combatDerivs: getCombatDerivs(), fade: getFadePlays(), clv: getClvReport(), nflPrep: { winTotals: getNflWinTotals(), schedule: getNflSchedule(), props: getNflProps() }, watchdog: getWatchdog() });
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
      return json(res, 200, { ...getOddsBudget(), claude: await getClaudeUsage() });
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
