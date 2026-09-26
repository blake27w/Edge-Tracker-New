-- Run in Supabase → SQL Editor
alter table research_notes add column if not exists signals jsonb;
alter table research_notes add column if not exists player text;
alter table research_notes add column if not exists stat text;

-- NFL closing-line history table (nfl-history agent)
create table if not exists nfl_closing_lines (
  event_id          text primary key,
  season            integer, week integer, seasontype integer,
  date              timestamptz, slot text, primetime boolean,
  home text, away text, home_score integer, away_score integer, divisional boolean,
  close_spread_home numeric, close_total numeric, provider text,
  fav text, fav_size numeric, fav_covered boolean, home_covered boolean, total_result text
);
create index if not exists nfl_closing_lines_season_idx on nfl_closing_lines (season, week);

-- NCAAF closing-line history + AP ranks (ncaaf-history agent)
create table if not exists ncaaf_closing_lines (
  event_id text primary key, season integer, week integer, seasontype integer,
  date timestamptz, slot text, primetime boolean,
  home text, away text, home_score integer, away_score integer, neutral boolean, conference_game boolean,
  home_rank integer, away_rank integer, ranked_teams integer,
  close_spread_home numeric, close_total numeric, provider text,
  fav text, fav_size numeric, fav_covered boolean, home_covered boolean, total_result text,
  ranked_fav boolean, ranked_dog boolean
);
create index if not exists ncaaf_closing_lines_season_idx on ncaaf_closing_lines (season, week);

-- ── Closing prices (2026-09-26) ─────────────────────────────────
-- The line alone can't be turned into a return: 52.9% is +3.3% at -105,
-- +1.0% at -110 and -1.0% at -115. ESPN returns these in the same payload.
alter table nfl_closing_lines   add column if not exists over_odds        numeric;
alter table nfl_closing_lines   add column if not exists under_odds       numeric;
alter table nfl_closing_lines   add column if not exists home_spread_odds numeric;
alter table nfl_closing_lines   add column if not exists away_spread_odds numeric;

alter table ncaaf_closing_lines add column if not exists over_odds        numeric;
alter table ncaaf_closing_lines add column if not exists under_odds       numeric;
alter table ncaaf_closing_lines add column if not exists home_spread_odds numeric;
alter table ncaaf_closing_lines add column if not exists away_spread_odds numeric;
