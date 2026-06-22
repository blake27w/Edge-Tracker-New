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
import { getGames, getPlays, getPropPlays, getEvPlays, getArbPlays, getBacktest, getStaleLines, getDivergence, getKeyNumbers, getFairLine, getCombatPlays, getNflWinTotals, getNflSchedule, getNflProps, getNflTotals, getNflInactives, getNflLineMove, getNflDerivs, getNflPace, getPredMarket, getFadePlays, getClvReport, getCombatDerivs, getBookEdges, getWatchdog } from './store/index.js';
import { getOddsBudget } from './agents/odds/index.js';
import { buildWorkbook } from './export/index.js';
import { buildGames } from './games/index.js';
import { listResearch, addResearch, deleteResearch } from './research/index.js';
import { median } from './agents/shared/odds-math.js';

// ── CORS ────────────────────────────────────────────────────────
// Allow the configured origins (CORS_ORIGINS env, default GitHub Pages) plus
// any *.vercel.app domain, so the dashboard works on Vercel prod + preview
// deploys (random preview subdomains) without re-listing each one. These are
// public read endpoints, so allowing Vercel-hosted frontends is low-risk.
function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = config.server.corsOrigins;
  const okOrigin = origin && (allowed.includes('*') || allowed.includes(origin) || /\.vercel\.app$/.test(origin));
  if (okOrigin) {
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

// Full dossier for one graded opportunity: the result, every book that was off
// (with its mispricing window), the open→close line history, and the play row.
async function buildOpportunity(url) {
  const q = (k) => url.searchParams.get(k) || undefined;
  const game_id = q('game_id'), market = q('market'), side = q('side'), type = q('type');
  if (!game_id || !market) return { error: 'game_id and market required' };
  const eq = (m) => { const o = { game_id, market }; if (side) o.side = side; if (m && type) o.type = type; return o; };

  const result = (await db.select('opp_results', '*', { match: eq(true), order: { column: 'graded_at', ascending: false }, limit: 1 }))[0] || null;
  let edges = [];
  try { edges = await db.select('book_edge_log', '*', { match: eq(true), order: { column: 'detected_at', ascending: true }, limit: 60 }); } catch (_) { /* none */ }
  const play = (await db.select('monitor_scores', '*', { match: eq(false), limit: 1 }))[0] || null;

  // Open→close consensus line/price history from snapshots for this game/market/side.
  const snapMarket = market === 'ml' ? 'h2h' : market === 'total' ? 'totals' : market === 'spread' ? 'spreads' : market;
  let snaps = [];
  try { snaps = await db.select('line_snapshots', 'book,line,price,fetched_at', { match: { game_id, market: snapMarket, ...(side ? { side } : {}) }, order: { column: 'fetched_at', ascending: true }, limit: 1000 }); } catch (_) { /* none */ }
  const byTs = new Map();
  for (const s of snaps) { (byTs.get(s.fetched_at) || byTs.set(s.fetched_at, []).get(s.fetched_at)).push(s); }
  let history = [...byTs.keys()].sort().map((t) => {
    const rows = byTs.get(t);
    const lines = rows.map((r) => Number(r.line)).filter(Number.isFinite);
    const prices = rows.map((r) => Number(r.price)).filter(Number.isFinite);
    return { at: t, line: lines.length ? median(lines) : null, price: prices.length ? Math.round(median(prices)) : null, books: rows.length };
  });
  if (history.length > 24) { const step = Math.ceil(history.length / 24); const out = []; for (let i = 0; i < history.length; i += step) out.push(history[i]); if (out[out.length - 1] !== history[history.length - 1]) out.push(history[history.length - 1]); history = out; }

  // Per-book breakdown — each book's LAST line/price for this side, best-for-the-
  // bettor first (so the stale/off-market book is on top), with its gap vs the
  // closing consensus. Always available from snapshots even when book_edge_log
  // has no episode for this (older) play.
  const lastByBook = new Map();
  for (const s of snaps) lastByBook.set(s.book, s); // snaps are asc by time → last wins
  const close = history.length ? history[history.length - 1] : null;
  const books = [...lastByBook.values()].map((s) => ({
    book: s.book, line: s.line, price: s.price,
    line_gap: (close && close.line != null && s.line != null) ? Math.round((s.line - close.line) * 10) / 10 : null,
    price_gap: (close && close.price != null && s.price != null) ? s.price - close.price : null,
  })).sort((a, b) => ((b.line ?? -1e9) - (a.line ?? -1e9)) || ((b.price ?? -1e9) - (a.price ?? -1e9)));

  return { result, edges, books, play, history };
}

// Individual episodes behind one Book-Edges cell (book × sport × market × type),
// each joined to its graded result.
async function buildBookEdgeDetail(url) {
  const book = url.searchParams.get('book') || undefined;
  if (!book) return { error: 'book required' };
  const match = { book };
  for (const k of ['sport', 'market', 'type']) { const v = url.searchParams.get(k); if (v) match[k] = v; }
  let eps = [];
  try { eps = await db.select('book_edge_log', '*', { match, order: { column: 'detected_at', ascending: false }, limit: 60 }); } catch (_) { /* none */ }
  let res = [];
  try { res = await db.select('opp_results', 'type,game_id,market,side,matchup,status,pnl', { limit: 8000 }); } catch (_) { /* none */ }
  const rmap = new Map();
  for (const r of res) rmap.set(`${r.type}|${r.game_id}|${r.market}|${r.side}`, r);
  return { episodes: eps.map((e) => {
    const r = rmap.get(`${e.type}|${e.game_id}|${e.market}|${e.side}`);
    return { game_id: e.game_id, matchup: r ? r.matchup : null, sport: e.sport, market: e.market, side: e.side, book: e.book, type: e.type, outlier_line: e.outlier_line, consensus_line: e.consensus_line, pts: e.pts, window_sec: e.window_sec, detected_at: e.detected_at, corrected_at: e.corrected_at, status: r ? r.status : null, pnl: r ? r.pnl : null };
  }) };
}

// Individual plays that carried one signal id, each with its CLV + result.
async function buildSignalDetail(url) {
  const id = url.searchParams.get('id') || undefined;
  if (!id) return { error: 'id required' };
  let clvRows = [];
  try { clvRows = await db.select('clv_records', 'game_id,bet_market,side,clv,beat_close', { match: { suspect: false }, limit: 8000 }); } catch (_) { /* none */ }
  const clvMap = new Map();
  for (const c of clvRows) clvMap.set(`${c.game_id}|${c.bet_market}|${c.side}`, c);
  let plays = [];
  try { plays = await db.select('monitor_scores', 'sport,game_id,matchup,market,side,line,signals,status,pnl,score,scored_at,observational', { match: { qualified: true }, order: { column: 'scored_at', ascending: false }, limit: 8000 }); } catch (_) { /* none */ }
  const FIGHT = new Set(['UFC', 'BOXING']);
  const out = [];
  for (const p of plays) {
    if (p.observational && FIGHT.has(p.sport)) continue;
    const ids = Array.isArray(p.signals) ? p.signals.map((s) => s && s.id) : [];
    if (!ids.includes(id)) continue;
    const c = clvMap.get(`${p.game_id}|${p.market}|${p.side}`);
    out.push({ sport: p.sport, matchup: p.matchup, market: p.market, side: p.side, line: p.line, score: p.score, status: p.status, pnl: p.pnl, scored_at: p.scored_at, clv: c ? c.clv : null, beat_close: c ? c.beat_close : null });
    if (out.length >= 60) break;
  }
  return { plays: out };
}

// Graded plays behind one "What Works" breakdown bucket (dim+key), e.g.
// dim=confidence key="80–89", dim=sport key="NBA", dim=signal key=<label>.
async function buildPlaysDetail(url) {
  const dim = url.searchParams.get('dim'), key = url.searchParams.get('key');
  if (!dim || key == null) return { error: 'dim and key required' };
  let rows = [];
  try { rows = await db.select('monitor_scores', 'sport,matchup,market,side,line,player,score,t1_count,tier,signals,status,pnl,graded_at,observational', { in: { status: ['win', 'loss', 'push'] }, order: { column: 'graded_at', ascending: false }, limit: 5000 }); }
  catch (e) { return { error: e.message }; }
  rows = rows.filter((r) => !r.observational);
  const confB = (r) => { const s = Number(r.score) || 0; return s >= 90 ? '90+' : s >= 80 ? '80–89' : s >= 70 ? '70–79' : '<70'; };
  const t1B = (r) => { const t = Number(r.t1_count) || 0; return t >= 3 ? '3+ T1' : `${t} T1`; };
  const sigL = (r) => (Array.isArray(r.signals) ? r.signals.map((x) => x && (x.label || x.id)).filter(Boolean) : []);
  const match = (r) => {
    if (dim === 'sport') return r.sport === key;
    if (dim === 'market') return r.market === key;
    if (dim === 'tier') return r.tier === key;
    if (dim === 'confidence') return confB(r) === key;
    if (dim === 't1') return t1B(r) === key;
    if (dim === 'signal') return sigL(r).includes(key);
    return false;
  };
  const plays = rows.filter(match).slice(0, 80).map((r) => ({ sport: r.sport, matchup: r.matchup, market: r.market, side: r.side, line: r.line, player: r.player, score: r.score, status: r.status, pnl: r.pnl, graded_at: r.graded_at }));
  return { plays };
}

// Data-health: per-table rows written today + total, and agent errors today.
// A "today: 0" on an in-season table is the at-a-glance "data isn't flowing" tell.
async function buildDataHealth() {
  const day = new Date(); day.setUTCHours(0, 0, 0, 0);
  const since = day.toISOString();
  const specs = [
    ['line_snapshots', 'fetched_at'], ['monitor_scores', 'scored_at'], ['clv_records', 'recorded_at'],
    ['opp_results', 'graded_at'], ['ev_opportunities', 'fetched_at'], ['line_signals', 'fetched_at'],
    ['book_edge_log', 'detected_at'], ['sharp_signals', 'detected_at'], ['injury_updates', 'fetched_at'],
    ['game_weather', 'fetched_at'], ['public_splits', 'fetched_at'],
  ];
  const tables = [];
  for (const [t, ts] of specs) {
    let today = null, total = null;
    try { today = await db.count(t, { gte: { [ts]: since } }); } catch (_) { /* table optional */ }
    try { total = await db.count(t); } catch (_) { /* table optional */ }
    tables.push({ table: t, today, total });
  }
  let errorsToday = null;
  try { errorsToday = await db.count('scan_runs', { match: { status: 'error' }, gte: { started_at: since } }); } catch (_) { /* none */ }
  return { tables, errorsToday, dbConnected: db.isConnected(), since, generated: new Date().toISOString() };
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
      return json(res, 200, { plays: getPlays(), props: getPropPlays(), ev: getEvPlays(), arb: getArbPlays(), backtest: getBacktest(), stale: getStaleLines(), divergence: getDivergence(), keyNumbers: getKeyNumbers(), fairLine: getFairLine(), combat: getCombatPlays(), combatDerivs: getCombatDerivs(), fade: getFadePlays(), clv: getClvReport(), bookEdges: getBookEdges(), nflPrep: { winTotals: getNflWinTotals(), schedule: getNflSchedule(), props: getNflProps(), totals: getNflTotals(), inactives: getNflInactives(), lineMove: getNflLineMove(), derivatives: getNflDerivs(), pace: getNflPace() }, predMarket: getPredMarket(), watchdog: getWatchdog() });
    case '/opportunity':
      try { return json(res, 200, await buildOpportunity(url)); }
      catch (e) { logger.error('opportunity', e.message); return json(res, 500, { error: 'opportunity failed', detail: e.message }); }
    case '/book-edges-detail':
      try { return json(res, 200, await buildBookEdgeDetail(url)); }
      catch (e) { logger.error('book-edges-detail', e.message); return json(res, 500, { error: 'detail failed', detail: e.message }); }
    case '/signal-detail':
      try { return json(res, 200, await buildSignalDetail(url)); }
      catch (e) { logger.error('signal-detail', e.message); return json(res, 500, { error: 'detail failed', detail: e.message }); }
    case '/plays-detail':
      try { return json(res, 200, await buildPlaysDetail(url)); }
      catch (e) { logger.error('plays-detail', e.message); return json(res, 500, { error: 'detail failed', detail: e.message }); }
    case '/data-health':
      try { return json(res, 200, await buildDataHealth()); }
      catch (e) { logger.error('data-health', e.message); return json(res, 500, { error: 'data-health failed', detail: e.message }); }
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
