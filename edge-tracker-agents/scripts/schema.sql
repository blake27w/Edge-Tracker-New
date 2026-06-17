-- ════════════════════════════════════════════════════════════════
-- Edge Tracker — backend agent schema
-- Run in the Supabase SQL editor (or via scripts/migrate.js).
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.
-- ════════════════════════════════════════════════════════════════
create extension if not exists pgcrypto;

-- ── Agent health: one row per agent run ─────────────────────────
create table if not exists scan_runs (
  id              uuid primary key default gen_random_uuid(),
  agent           text not null,
  status          text not null default 'running',   -- running | ok | error
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  duration_ms     integer,
  result          text,                               -- human summary, e.g. "42 snapshots, 3 movements"
  result_data     jsonb,
  games_monitored integer default 0,
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists scan_runs_agent_idx on scan_runs (agent, started_at desc);

-- ── Odds API request budget (persists across restarts) ──────────
create table if not exists api_usage (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null default 'odds',
  month       text not null,                          -- YYYY-MM
  used        integer not null default 0,
  budget      integer not null default 0,
  by_sport    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  unique (provider, month)
);

-- ── Odds snapshots ──────────────────────────────────────────────
create table if not exists line_snapshots (
  id            uuid primary key default gen_random_uuid(),
  sport         text not null,
  game_id       text not null,
  commence_time timestamptz,
  home          text,
  away          text,
  book          text not null,
  market        text not null,                        -- h2h | spreads | totals
  side          text,
  line          numeric,
  price         integer,
  fetched_at    timestamptz not null default now()
);
create index if not exists line_snapshots_game_idx on line_snapshots (game_id, market, fetched_at desc);
create index if not exists line_snapshots_sport_idx on line_snapshots (sport, fetched_at desc);

-- Opening lines: the first consensus line we record per game/market. Captured
-- with ignore-on-conflict so the opener never changes once set.
create table if not exists opening_lines (
  id          uuid primary key default gen_random_uuid(),
  game_id     text not null,
  market      text not null,                        -- total | spread | ml
  line        numeric,
  side        text,
  captured_at timestamptz not null default now(),
  unique (game_id, market)
);

create table if not exists line_movements (
  id            uuid primary key default gen_random_uuid(),
  sport         text not null,
  game_id       text not null,
  market        text not null,
  book          text,
  side          text,
  line_open     numeric,
  line_current  numeric,
  moved         numeric,
  price_open    integer,
  price_current integer,
  direction     text,                                 -- up | down
  detected_at   timestamptz not null default now()
);
create index if not exists line_movements_game_idx on line_movements (game_id, detected_at desc);

-- ── Intelligence agents ─────────────────────────────────────────
create table if not exists injury_updates (
  id          uuid primary key default gen_random_uuid(),
  sport       text not null,
  game_id     text,
  team        text,
  player      text,
  status      text,                                   -- OUT | DOUBTFUL | QUESTIONABLE | GTD | ACTIVE
  detail      text,
  impact      text,                                   -- high | medium | low
  source      text,
  fetched_at  timestamptz not null default now()
);
create index if not exists injury_updates_sport_idx on injury_updates (sport, fetched_at desc);

create table if not exists game_weather (
  id           uuid primary key default gen_random_uuid(),
  sport        text not null,
  game_id      text,
  home         text,
  away         text,
  venue        text,
  dome         boolean default false,
  temp_f       numeric,
  wind_mph     numeric,
  wind_dir     text,
  precip       text,
  conditions   text,
  total_impact text,                                  -- under | over | neutral
  fetched_at   timestamptz not null default now()
);
create index if not exists game_weather_game_idx on game_weather (game_id, fetched_at desc);

create table if not exists sharp_signals (
  id          uuid primary key default gen_random_uuid(),
  sport       text not null,
  game_id     text not null,
  market      text,
  side        text,
  signal_type text,                                   -- steam | rlm | reverse | resistance
  strength    numeric,
  detail      text,
  books       jsonb,
  detected_at timestamptz not null default now()
);
create index if not exists sharp_signals_game_idx on sharp_signals (game_id, detected_at desc);

create table if not exists power_ratings (
  id         uuid primary key default gen_random_uuid(),
  sport      text not null,
  team       text not null,
  rating     numeric,
  off_rating numeric,
  def_rating numeric,
  notes      text,
  updated_at timestamptz not null default now(),
  unique (sport, team)
);

-- ── Public betting splits (Agent 8) ─────────────────────────────
create table if not exists public_splits (
  id           uuid primary key default gen_random_uuid(),
  sport        text not null,
  game_id      text not null,
  market       text,                                  -- spread | total | ml
  side         text,
  bets_pct     numeric,
  handle_pct   numeric,
  line_open    numeric,
  line_current numeric,
  divergence   numeric,                               -- handle_pct - bets_pct (positive = sharp side)
  rlm          boolean default false,                 -- reverse line movement vs heavy public
  source       text,
  fetched_at   timestamptz not null default now()
);
create index if not exists public_splits_game_idx on public_splits (game_id, fetched_at desc);

-- ── Schedule spots (Agent 9) ────────────────────────────────────
create table if not exists schedule_spots (
  id         uuid primary key default gen_random_uuid(),
  sport      text not null,
  game_id    text not null,
  team       text,
  spot_type  text,                                    -- b2b | long_road | getaway | short_week | travel
  detail     text,
  tier       integer default 2,                       -- 2 or 3 (never a standalone qualifier)
  factors    jsonb,
  fetched_at timestamptz not null default now()
);
create index if not exists schedule_spots_game_idx on schedule_spots (game_id, fetched_at desc);

-- ── MLB context: umpire + bullpen (Agent 10) ────────────────────
create table if not exists mlb_context (
  id                  uuid primary key default gen_random_uuid(),
  game_id             text not null,
  home                text,
  away                text,
  ump_name            text,
  ump_ou_tendency     text,                           -- over | under | neutral
  ump_k_tendency      text,
  home_bullpen_fatigue text,                          -- high | medium | low
  away_bullpen_fatigue text,
  total_lean          text,                           -- under | over | neutral
  notes               text,
  fetched_at          timestamptz not null default now()
);
create index if not exists mlb_context_game_idx on mlb_context (game_id, fetched_at desc);

-- ── Prop engine (Agent 11) ──────────────────────────────────────
create table if not exists player_usage (
  id           uuid primary key default gen_random_uuid(),
  sport        text not null,
  player_id    text,
  player       text,
  team         text,
  stat_type    text,
  snap_pct     numeric,
  target_share numeric,
  carry_share  numeric,
  rz_usage     numeric,
  season       text,
  updated_at   timestamptz not null default now()
);
create index if not exists player_usage_player_idx on player_usage (player_id, stat_type);

create table if not exists prop_snapshots (
  id         uuid primary key default gen_random_uuid(),
  sport      text not null,
  game_id    text,
  player_id  text,
  player     text,
  stat_type  text,
  line       numeric,
  side       text,
  price      integer,
  book       text,
  trigger    text,                                    -- injury | weather | shop | workload
  fetched_at timestamptz not null default now()
);
create index if not exists prop_snapshots_player_idx on prop_snapshots (player_id, stat_type, fetched_at desc);

-- ── Signal engine output: qualifying plays ──────────────────────
create table if not exists monitor_scores (
  id                   uuid primary key default gen_random_uuid(),
  sport                text not null,
  game_id              text not null,
  matchup              text,
  market               text,                          -- total | spread | ml | prop
  side                 text,
  line                 numeric,
  raw_score            numeric,
  score                numeric,                        -- after Over penalty
  confidence           numeric,
  tier                 text,
  unit_mult            numeric,
  unit_dollars         numeric,
  t1_count             integer default 0,
  signals              jsonb,
  qualified            boolean default false,
  over_penalty_applied boolean default false,
  status               text default 'pending',        -- pending | win | loss | push | dismissed
  result_score         text,
  pnl                  numeric,
  scored_at            timestamptz not null default now(),
  graded_at            timestamptz
);
create index if not exists monitor_scores_game_idx on monitor_scores (game_id, scored_at desc);
create index if not exists monitor_scores_qual_idx on monitor_scores (qualified, status, scored_at desc);

-- ── CLV tracking ────────────────────────────────────────────────
create table if not exists clv_records (
  id          uuid primary key default gen_random_uuid(),
  sport       text not null,
  game_id     text not null,
  bet_market  text,
  side        text,
  line_logged numeric,
  odds_logged integer,
  line_close  numeric,
  odds_close  integer,
  clv         numeric,
  beat_close  boolean,
  recorded_at timestamptz not null default now()
);
create index if not exists clv_records_game_idx on clv_records (game_id, recorded_at desc);

-- ── Alerts (SMS history feeds the dashboard) ────────────────────
create table if not exists alert_log (
  id         uuid primary key default gen_random_uuid(),
  type       text not null default 'sms',             -- sms | system
  channel    text,
  recipients integer default 0,
  body       text,
  sport      text,
  game_id    text,
  status     text default 'sent',
  sent_at    timestamptz not null default now()
);
create index if not exists alert_log_sent_idx on alert_log (sent_at desc);

-- ── Subscribers ─────────────────────────────────────────────────
create table if not exists subscribers (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  phone      text not null,
  active     boolean default true,
  created_at timestamptz not null default now(),
  unique (phone)
);
