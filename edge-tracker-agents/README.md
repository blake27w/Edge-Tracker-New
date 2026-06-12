# Edge Tracker — Backend Agents

A Node.js service that runs the Edge Tracker monitoring agents on schedules,
writes to Supabase, and exposes a small JSON API the in-app **🤖 Agents** tab
reads. Designed to deploy to Railway via the included `Dockerfile`.

## Agents

| Agent | Cadence | What it does |
|---|---|---|
| 📡 Odds Ingestion | 5 min | Pulls odds from The Odds API (budgeted), snapshots lines, detects movement |
| 🏥 Injury Intelligence | 5 min | Injury news via Claude web search; flags OUT starters for the Prop Engine |
| 🌦️ Weather Intelligence | 15 min | Outdoor forecasts; 15+ mph wind → Under lean |
| 💰 Sharp Money Detection | 2 min | Steam / coordinated cross-book moves |
| 📊 Power Ratings | 10 min | Claude team strength ratings for the slate |
| 📈 Public Betting Splits (Agent 8) | 10 min | bets% vs handle% divergence, RLM vs 70%+ public (**T1**) |
| 🗓️ Schedule Spot (Agent 9) | 30 min | B2Bs, road trips, day-after-night (T2/T3, zero API cost) |
| ⚾ MLB Context (Agent 10) | 30 min | Home-plate umpire O/U + bullpen fatigue (T2/T3 totals) |
| 🧠 Signal Engine | 5 min | Master scorer — applies the Under bias, emits qualifying plays |
| 🎯 Prop Engine (Agent 11) | 10 min | Injury- and weather-triggered prop alerts |
| 📉 CLV Tracker | 10 min | Closing-line value on qualifying plays |
| ✅ Grading Agent | 30 min | Final scores → win/loss/push → P&L (verified record) |

## Betting philosophy (encoded in the Signal Engine)

- **Default to Unders on game totals.** An Over total takes a **-10 confidence
  penalty** and must have **2+ Tier-1 signals** to qualify.
- Spreads, moneylines, and player props are exempt from the bias.
- Confidence floor 70; 1+ Tier-1 signal required to qualify.
- Unit sizing: 85+ → 1.5u ($18), 75–84 → 1u ($12), 70–74 → 0.5u ($6).

## Setup

```bash
cp .env.example .env      # fill in Supabase + API keys
npm install
npm run migrate           # checks which schema tables exist
#   → if any are missing, paste scripts/schema.sql into the Supabase SQL editor
npm start
```

### Model detection

On startup the service probes `ANTHROPIC_MODELS` (modern models first, then the
legacy `claude-sonnet-4-20250514 → claude-3-5-sonnet-20241022 → claude-3-haiku-20240307`
chain) and uses the first your key can call. Web search is enabled automatically
on models that support it.

### Odds API budgeting

The free tier (500 req/mo) is allocated MLB 40% / NBA 20% / NHL 20% / rest 20%,
persisted in `api_usage`, reconciled against the API's `x-requests-remaining`
header, and gated per sport. Out-of-season sports are skipped. Set
`ODDS_API_TIER=free|starter|pro`.

## API

| Endpoint | Returns |
|---|---|
| `GET /health` | All agent statuses, last run/duration/result/error, system health |
| `GET /plays` | Current qualifying plays + prop alerts |
| `GET /feed` | Last 100 log entries |
| `GET /budget` | Odds API budget detail |

CORS is allowed for `CORS_ORIGINS` (defaults to the GitHub Pages domain).

## Testing

```bash
node scripts/test-agent.js odds sharp public-splits signal   # run a pipeline slice
node scripts/test-alerts.js "+15557654321"                   # test SMS (optional)
```

## Error recovery

After 3 consecutive failures an agent's interval is backed off (×4, capped at
1h); it restores on the next success. If an agent is down 30+ minutes the
service sends one SMS alert and logs it to `alert_log`.

## Deploy (Railway)

Push this directory to the agent repo, create a Railway service from the
`Dockerfile`, set the env vars from `.env.example`, and Railway will use the
`/health` healthcheck in `railway.json`.

> The frontend reads directly from Supabase (`scan_runs`, `monitor_scores`,
> `alert_log`, `line_snapshots`) and can optionally also hit `/health`, `/plays`,
> and `/feed` on this service.
