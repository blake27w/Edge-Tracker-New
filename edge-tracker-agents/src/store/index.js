// ══════════════════════════════════════════════════════════════
// In-memory pipeline cache. Agents publish their latest output here
// so downstream agents (signal engine, prop engine) and the HTTP
// endpoints can read fresh data without round-tripping the DB on
// every request. Everything is also persisted to Supabase by the
// agents themselves — this is a fast, ephemeral mirror.
// ══════════════════════════════════════════════════════════════

const store = {
  games: [],          // normalized games from the odds agent (with books/markets)
  injuries: [],       // latest injury_updates
  weather: [],        // latest game_weather
  sharp: [],          // latest sharp_signals
  power: {},          // sport -> { team -> rating }
  splits: [],         // latest public_splits
  schedule: [],       // latest schedule_spots
  mlbContext: [],     // latest mlb_context
  plays: [],          // qualifying plays from the signal engine
  propPlays: [],      // qualifying prop alerts
  tennisGames: [],    // tennis matches (kept separate from team-sport games)
  tennisPlays: [],    // qualifying tennis plays
  evPlays: [],        // +EV / boost opportunities (value vs no-vig fair price)
  arbPlays: [],       // arbitrage + middle opportunities across books
  backtest: null,     // track-record / backtest report (which signals win)
  staleLines: [],     // slow-book / stale-line opportunities (line vs field)
  divergence: [],     // book price-divergence + sharp-side alignment
};

export function setEvPlays(p) { store.evPlays = p || []; }
export function getEvPlays() { return store.evPlays; }

export function setArbPlays(p) { store.arbPlays = p || []; }
export function getArbPlays() { return store.arbPlays; }

export function setBacktest(r) { store.backtest = r; }
export function getBacktest() { return store.backtest; }

export function setStaleLines(p) { store.staleLines = p || []; }
export function getStaleLines() { return store.staleLines; }

export function setDivergence(p) { store.divergence = p || []; }
export function getDivergence() { return store.divergence; }

export function setTennisGames(g) { store.tennisGames = g || []; }
export function getTennisGames() { return store.tennisGames; }
export function setTennisPlays(p) { store.tennisPlays = p || []; }
export function getTennisPlays() { return store.tennisPlays; }

export function setGames(games) { store.games = games || []; }
export function getGames() { return store.games; }

export function setIntel(key, rows) { store[key] = rows || []; }
export function getIntel(key) { return store[key] || []; }

export function setPower(sport, ratings) { store.power[sport] = ratings || {}; }
export function getPower(sport) { return store.power[sport] || {}; }

export function setPlays(plays) { store.plays = plays || []; }
export function getPlays() { return store.plays; }

export function setPropPlays(plays) { store.propPlays = plays || []; }
export function getPropPlays() { return store.propPlays; }

// Signals relevant to a given game_id, across all intel agents.
export function signalsForGame(gameId) {
  const pick = (arr) => (arr || []).filter((r) => r.game_id === gameId);
  return {
    sharp: pick(store.sharp),
    splits: pick(store.splits),
    injuries: pick(store.injuries),
    weather: pick(store.weather),
    schedule: pick(store.schedule),
    mlbContext: pick(store.mlbContext),
  };
}

export default store;
