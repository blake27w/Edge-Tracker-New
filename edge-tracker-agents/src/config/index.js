// ══════════════════════════════════════════════════════════════
// Central configuration. Reads env, defines sports, budgets, rules.
// ══════════════════════════════════════════════════════════════

const env = process.env;

// Strip surrounding quotes and whitespace that often sneak into env values
// pasted in dashboards (a stray quote or newline in SUPABASE_URL would
// otherwise crash the Supabase client on startup).
function clean(v) {
  if (v == null) return '';
  return String(v).trim().replace(/^['"]+|['"]+$/g, '').trim();
}
function bool(v, dflt = false) {
  if (v == null) return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function list(v, dflt = []) {
  if (!v) return dflt;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// ── Odds API budgeting ──────────────────────────────────────────
// Free tier = 500 req/month. Allocate by sport so MLB never starves the
// rest, and so we don't burn the month in the first week.
const ODDS_TIER_BUDGETS = { free: 500, starter: 20000, pro: 5000000 };
const ODDS_API_TIER = (env.ODDS_API_TIER || 'free').toLowerCase();
const ODDS_MONTHLY_BUDGET = ODDS_TIER_BUDGETS[ODDS_API_TIER] ?? ODDS_TIER_BUDGETS.free;

// Budget allocation across sports (relative caps; out-of-season sports are
// skipped automatically, so in-season ones effectively get more). Sums to 1.0.
const BUDGET_ALLOCATION = {
  MLB: 0.26,
  NBA: 0.14,
  NCAAB: 0.12,
  NHL: 0.10,
  NCAAF: 0.08,
  SOCCER: 0.08,
  NFL: 0.05,
  WNBA: 0.05,
  TENNIS: 0.05,
  UFC: 0.04,
  GOLF: 0.03,
};

// The Odds API sport keys. Soccer covers 7 leagues we care about.
const SPORTS = {
  MLB: { key: 'baseball_mlb', emoji: '⚾', hasTotals: true },
  NBA: { key: 'basketball_nba', emoji: '🏀', hasTotals: true },
  NHL: { key: 'icehockey_nhl', emoji: '🏒', hasTotals: true },
  NFL: { key: 'americanfootball_nfl', emoji: '🏈', hasTotals: true },
  NCAAF: { key: 'americanfootball_ncaaf', emoji: '🏈', hasTotals: true },
  NCAAB: { key: 'basketball_ncaab', emoji: '🏀', hasTotals: true },
  WNBA: { key: 'basketball_wnba', emoji: '🏀', hasTotals: true },
  UFC: { key: 'mma_mixed_martial_arts', emoji: '🥊', hasTotals: false },
  SOCCER: {
    key: 'soccer', emoji: '⚽', hasTotals: true,
    leagues: [
      'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
      'soccer_germany_bundesliga', 'soccer_france_ligue_one',
      'soccer_uefa_champs_league', 'soccer_usa_mls',
    ],
  },
  TENNIS: { key: 'tennis', emoji: '🎾', hasTotals: false, oddsSkip: true },
  GOLF: { key: 'golf', emoji: '⛳', hasTotals: false, oddsSkip: true },
};

const BOOKS = ['fanduel', 'draftkings', 'williamhill_us', 'betmgm', 'pointsbetus', 'betrivers', 'fanatics'];
// Human labels for the books we track (williamhill_us == Caesars on The Odds API).
const BOOK_LABELS = {
  fanduel: 'FanDuel', draftkings: 'DraftKings', williamhill_us: 'Caesars',
  betmgm: 'BetMGM', pointsbetus: 'PointsBet', betrivers: 'BetRivers', fanatics: 'Fanatics',
};

// ── Agent schedules ─────────────────────────────────────────────
// Default interval (minutes) per agent. Claude-backed agents run on the
// slower side to control cost. Override any of them with an env var named
// INTERVAL_<NAME> (dashes → underscores), e.g. INTERVAL_INJURY=45,
// INTERVAL_PUBLIC_SPLITS=60. The orchestrator backs these off further on
// repeated failure (error recovery). Non-Claude agents (odds, sharp,
// schedule-spot, signal) stay fast since they cost nothing per run.
// Odds cadence scales with tier so the monthly request budget lasts:
// free (500/mo) polls slowly; paid tiers poll near real-time. Override with
// INTERVAL_ODDS. Frequent polling is what powers line-movement / steam / RLM
// detection — the free tier is really for testing; use Starter+ for live edges.
const ODDS_MIN_BY_TIER = { free: 180, starter: 5, pro: 2 };
// Timezone for clock-scheduled agents (injury). Game-day report windows are
// local-time concepts, so default to US Eastern.
const SCHEDULE_TZ = env.SCHEDULE_TZ || 'America/New_York';
const AGENT_DEFS = {
  odds: { label: 'Odds Ingestion', emoji: '📡', min: ODDS_MIN_BY_TIER[ODDS_API_TIER] ?? 30 },
  // Injury is free now (ESPN feed), so run it often to catch late scratches /
  // inactives that drop close to game time. Override with INTERVAL_INJURY.
  injury: { label: 'Injury Intelligence', emoji: '🏥', min: 30 },
  weather: { label: 'Weather Intelligence', emoji: '🌦️', min: 45 },
  sharp: { label: 'Sharp Money Detection', emoji: '💰', min: 2 },
  power: { label: 'Power Ratings', emoji: '📊', times: ['08:00'], days: [1, 4] },
  'public-splits': { label: 'Public Betting Splits', emoji: '📈', min: 480 },
  'schedule-spot': { label: 'Schedule Spot', emoji: '🗓️', min: 30 },
  'mlb-context': { label: 'MLB Context (Umpire + Bullpen)', emoji: '⚾', min: 60 },
  signal: { label: 'Signal Engine', emoji: '🧠', min: 2 },
  'prop-engine': { label: 'Prop Engine', emoji: '🎯', min: 15 },
  clv: { label: 'CLV Tracker', emoji: '📉', min: 15 },
  grading: { label: 'Grading Agent', emoji: '✅', min: 30 },
  // Tennis module (Phase 3) — skip cleanly when no tournaments are active.
  'tennis-ingest': { label: 'Tennis Ingestion', emoji: '🎾', min: 1440 },
  'tennis-fatigue': { label: 'Tennis Fatigue & Schedule', emoji: '🎾', min: 30 },
  'tennis-surface': { label: 'Tennis Surface & Style', emoji: '🎾', min: 60 },
  'tennis-signal': { label: 'Tennis Signal Engine', emoji: '🎾', min: 5 },
  'ev-scanner': { label: '+EV / Boost Scanner', emoji: '💸', min: 5 },
  'arb-scanner': { label: 'Arbitrage & Middle Scanner', emoji: '🔒', min: 5 },
  'backtest': { label: 'Backtest / Track Record', emoji: '📊', min: 30 },
};
const AGENTS = {};
for (const [name, d] of Object.entries(AGENT_DEFS)) {
  const envBase = name.toUpperCase().replace(/-/g, '_');
  if (d.times) {
    const times = list(env[`${envBase}_TIMES`], d.times);
    // Optional day-of-week restriction (0=Sun..6=Sat) — e.g. POWER_DAYS=1,4 for Mon/Thu.
    const daysRaw = env[`${envBase}_DAYS`];
    const days = daysRaw
      ? daysRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      : (d.days || null);
    AGENTS[name] = { label: d.label, emoji: d.emoji, times, days, tz: SCHEDULE_TZ, cron: `@ ${times.join(', ')}${days ? ' days ' + days.join('/') : ''} ${SCHEDULE_TZ}` };
  } else {
    const m = Math.max(1, num(env[`INTERVAL_${envBase}`], d.min));
    const cron = m >= 60 ? `0 */${Math.round(m / 60)} * * *` : `*/${m} * * * *`;
    AGENTS[name] = { label: d.label, emoji: d.emoji, intervalMin: m, everyMs: m * 60_000, cron };
  }
}

const config = {
  dryRun: bool(env.DRY_RUN, false),

  supabase: {
    url: clean(env.SUPABASE_URL),
    key: clean(env.SUPABASE_SERVICE_ROLE_KEY) || clean(env.SUPABASE_KEY),
  },

  anthropic: {
    apiKey: clean(env.ANTHROPIC_API_KEY),
    // Probe order: modern models first (best results if the key supports them),
    // then the legacy fallback chain specified in the build brief.
    // Cheapest-capable first to control cost (Haiku ≈ 5× cheaper than Opus).
    // Override with ANTHROPIC_MODELS to prefer a stronger model.
    models: list(env.ANTHROPIC_MODELS, [
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-3-5-sonnet-20241022',
      'claude-3-haiku-20240307',
    ]),
    // Resolved at startup by detectModel().
    model: null,
  },

  oddsApi: {
    key: clean(env.ODDS_API_KEY),
    tier: ODDS_API_TIER,
    monthlyBudget: ODDS_MONTHLY_BUDGET,
    allocation: BUDGET_ALLOCATION,
    base: 'https://api.the-odds-api.com/v4',
  },

  twilio: {
    sid: env.TWILIO_ACCOUNT_SID || '',
    token: env.TWILIO_AUTH_TOKEN || '',
    from: env.TWILIO_FROM || '',
    enabled: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM),
    fallbackNumbers: list(env.ALERT_NUMBERS, []),
  },

  // Email alerts (free via Gmail/any SMTP). Works alongside or instead of SMS.
  email: {
    host: clean(env.SMTP_HOST),
    port: num(env.SMTP_PORT, 465),
    user: clean(env.SMTP_USER),
    pass: env.SMTP_PASS || '',           // app password — don't strip quotes/spaces blindly
    from: clean(env.SMTP_FROM) || clean(env.SMTP_USER),
    to: list(env.ALERT_EMAILS, []),
    enabled: !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.ALERT_EMAILS),
  },

  server: {
    port: num(env.PORT, 8080),
    corsOrigins: list(env.CORS_ORIGINS, ['https://blake27w.github.io']),
  },

  // ── Business rules ──
  rules: {
    confidenceFloor: num(env.CONFIDENCE_FLOOR, 70),
    unitDollars: num(env.UNIT_DOLLARS, 12),
    // DEFAULT TO UNDERS. An Over on a game total takes a -10 confidence penalty.
    overTotalPenalty: 10,
    // Unit sizing by raw score.
    sizing: [
      { min: 85, mult: 1.5, label: '1.5u' },
      { min: 75, mult: 1.0, label: '1u' },
      { min: 70, mult: 0.5, label: '0.5u' },
    ],
    // Error recovery: after this many consecutive failures, back off the interval.
    maxConsecutiveFailures: 3,
    backoffMultiplier: 4,
    // Alert if an agent has been failing for this long.
    downAlertMs: 30 * 60_000,
  },

  SPORTS,
  BOOKS,
  BOOK_LABELS,
  AGENTS,
};

// Unit sizing helper shared by signal engine + grading.
export function unitFor(score) {
  for (const tier of config.rules.sizing) {
    if (score >= tier.min) {
      return { mult: tier.mult, label: tier.label, dollars: Math.round(tier.mult * config.rules.unitDollars * 100) / 100 };
    }
  }
  return { mult: 0, label: 'skip', dollars: 0 };
}

export default config;
