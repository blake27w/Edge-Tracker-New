# nfl-live — install (5 edits, all in the GitHub web UI)

Repo: `blake27w/Edge-Tracker-New`. Railway auto-deploys on every commit to `main`.

## 1. Add the agent file
`edge-tracker-agents/src/agents/` → **Add file → Create new file**
Filename box: `nfl-live/index.js` (typing the slash creates the folder)
Paste the contents of `nfl-live-index.js`. Commit.

## 2. Register the schedule — `edge-tracker-agents/src/config/index.js`
Find this line (~line 154):
```js
  'nfl-inactives': { label: 'NFL Inactives-Speed', emoji: '🚑', min: 10 },
```
Add directly below it:
```js
  // In-game NFL edges; self-gates to live games, $0 extra Odds API. NFL_LIVE=true to enable.
  'nfl-live': { label: 'NFL Live In-Game', emoji: '🔴', min: 1 },
```

## 3. Register the agent — `edge-tracker-agents/src/orchestrator/index.js`
Find (~line 50):
```js
import nflInactives from '../agents/nfl-inactives/index.js';
```
Add below it:
```js
import nflLive from '../agents/nfl-live/index.js';
```
Then in the `const AGENTS = [` block, change `nflInactives,` to `nflInactives, nflLive,`.

## 4. Expose to the app — `edge-tracker-agents/src/index.js`
In the `/plays` response (~line 430), find `weatherChanges: getIntel('weatherChange'),` and add right after it:
```js
nflLive: getIntel('nflLive'),
```

## 5. Railway variable
Railway → service → Variables → New Variable → `NFL_LIVE` = `true` → Deploy.
Optional: `ODDS_STRIKE_MIN` = `2` on game days (live odds refresh every 2 min instead of 4; ~2× NFL credits during games only).

## 6. App — `index.html` (repo root, GitHub Pages)
a) In `AGENTS_META`, after the `'nfl-inactives'` entry add:
```js
  {name:'nfl-live',icon:'🔴',label:'NFL Live In-Game',cadence:'60s (live games)'},
```
b) In `AGENT_STALE_MS` add: `'nfl-live':180000,`

c) In `applyAgentsBag`, find the line starting `if(bag.bePlays){state.agentsFade=` and add to the end of that block:
```js
if(bag.bePlays)state.agentsNflLive=bag.bePlays.nflLive||[];
```

d) In the `▶ Now` board (`if(pv==='action'){`), after the `(state.agentsWeatherChange||[]).forEach(` block add:
```js
  (state.agentsNflLive||[]).forEach(function(l){ if(!l.qualified)return; items.push({prio:0,kind:'🔴 LIVE',ct:l.commence_time,tag:(l.signals&&l.signals[0]?l.signals[0].label:'')+' · '+(l.game_clock||'')+' · '+(l.live_score||''),matchup:l.matchup,sport:'NFL',edge:(l.score||0)*10,gid:l.game_id,mk:l.market,sd:l.side,
    bet:l.side+(l.line!=null?' '+l.line:'')+(l.price!=null?' '+fp(l.price):'')+(l.book?' @ '+l.book:'')+' · '+l.tier+' $'+l.unit_dollars}); });
```

## Verify (Thursday, LAR/SF)
Open the backend URL → Cmd+F `nfl-live`. Pregame: `no live NFL games`. After kickoff: `1 live · N flags`. App → Plays → ▶ Now shows 🔴 LIVE rows. Track record splits live vs pregame automatically.

## Test now without a game
Terminal (optional): `cd edge-tracker-agents && node scripts/test-agent.js nfl-live` — should print `disabled` or `no live NFL games`.
