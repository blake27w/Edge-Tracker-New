// ══════════════════════════════════════════════════════════════
// Central configuration. Reads env, defines sports, budgets, rules.
// ══════════════════════════════════════════════════════════════

const env = process.env;

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

// Budget allocation: MLB 40%, NBA 20%, NHL 20%, everything else shares 20%.
const BUDGET_ALLOCATION = {
  MLB: 0.40,
  NBA: 0.20,
  NHL: 0.20,
  NFL: 0.05,
  UFC: 0.03,
  SOCCER: 0.05,
  TENNIS: 0.04,
  GOLF: 0.03,
};

// The Odds API sport keys. Soccer covers 7 leagues we care about.
const SPORTS = {
  MLB: { key: 'baseball_mlb', emoji: '⚾', hasTotals: true },
  NBA: { key: 'basketball_nba', emoji: '🏀', hasTotals: true },
  NHL: { key: 'icehockey_nhl', emoji: '🏒', hasTotals: true },
  NFL: { key: 'americanfootball_nfl', emoji: '🏈', hasTotals: true },
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

// ── Agent schedules (cron) ──────────────────────────────────────
// Each agent has a base interval. The orchestrator may back these off on
// repeated failure (error recovery).
const AGENTS = {
  odds: { label: 'Odds Ingestion', emoji: '📡', cron: '*/5 * * * *', everyMs: 5 * 60_000 },
  injury: { label: 'Injury Intelligence', emoji: '🏥', cron: '*/5 * * * *', everyMs: 5 * 60_000 },
  weather: { label: 'Weather Intelligence', emoji: '🌦️', cron: '*/15 * * * *', everyMs: 15 * 60_000 },
  sharp: { label: 'Sharp Money Detection', emoji: '💰', cron: '*/2 * * * *', everyMs: 2 * 60_000 },
  power: { label: 'Power Ratings', emoji: '📊', cron: '*/10 * * * *', everyMs: 10 * 60_000 },
  'public-splits': { label: 'Public Betting Splits', emoji: '📈', cron: '*/10 * * * *', everyMs: 10 * 60_000 },
  'schedule-spot': { label: 'Schedule Spot', emoji: '🗓️', cron: '*/30 * * * *', everyMs: 30 * 60_000 },
  'mlb-context': { label: 'MLB Context (Umpire + Bullpen)', emoji: '⚾', cron: '*/30 * * * *', everyMs: 30 * 60_000 },
  signal: { label: 'Signal Engine', emoji: '🧠', cron: '*/5 * * * *', everyMs: 5 * 60_000 },
  'prop-engine': { label: 'Prop Engine', emoji: '🎯', cron: '*/10 * * * *', everyMs: 10 * 60_000 },
  clv: { label: 'CLV Tracker', emoji: '📉', cron: '*/10 * * * *', everyMs: 10 * 60_000 },
  grading: { label: 'Grading Agent', emoji: '✅', cron: '*/30 * * * *', everyMs: 30 * 60_000 },
};

const config = {
  dryRun: bool(env.DRY_RUN, false),

  supabase: {
    url: env.SUPABASE_URL || '',
    key: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY || '',
  },

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    // Probe order: modern models first (best results if the key supports them),
    // then the legacy fallback chain specified in the build brief.
    models: list(env.ANTHROPIC_MODELS, [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-haiku-20240307',
    ]),
    // Resolved at startup by detectModel().
    model: null,
  },

  oddsApi: {
    key: env.ODDS_API_KEY || '',
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
