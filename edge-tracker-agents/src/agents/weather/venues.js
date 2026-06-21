// ══════════════════════════════════════════════════════════════
// Stadium coordinates + roof type, keyed by the home-team name exactly
// as The Odds API returns it. Used by the weather agent to query a free
// forecast API by lat/long. dome:true = fixed/retractable roof we treat
// as weather-neutral (no wind signal). Coordinates are approximate
// (2-decimal precision is plenty for a forecast).
//
// cf = APPROXIMATE compass bearing (degrees from N) from home plate toward
// center field, for OUTDOOR MLB parks. Lets the weather agent classify wind
// as blowing IN (suppresses runs → Under), OUT (boosts → Over, a no-play for
// us), or ACROSS (neutral). Bearings are best-effort; the wind logic is
// fail-safe — an unknown/across reading produces NO directional signal rather
// than a wrong one. NFL parks omit cf (high wind hurts passing/kicking either
// way, so the NFL signal stays direction-agnostic).
// ══════════════════════════════════════════════════════════════
export const VENUES = {
  // ── MLB ── (cf = home-plate→CF bearing, approx; omitted/null = unknown)
  'Arizona Diamondbacks': { lat: 33.45, lon: -112.07, dome: true, venue: 'Chase Field' },
  'Atlanta Braves': { lat: 33.89, lon: -84.47, dome: false, cf: 25, venue: 'Truist Park' },
  'Baltimore Orioles': { lat: 39.28, lon: -76.62, dome: false, cf: 30, venue: 'Camden Yards' },
  'Boston Red Sox': { lat: 42.35, lon: -71.10, dome: false, cf: 45, venue: 'Fenway Park' },
  'Chicago Cubs': { lat: 41.95, lon: -87.66, dome: false, cf: 32, venue: 'Wrigley Field' },
  'Chicago White Sox': { lat: 41.83, lon: -87.63, dome: false, cf: 45, venue: 'Rate Field' },
  'Cincinnati Reds': { lat: 39.10, lon: -84.51, dome: false, cf: 60, venue: 'Great American Ball Park' },
  'Cleveland Guardians': { lat: 41.50, lon: -81.69, dome: false, cf: 0, venue: 'Progressive Field' },
  'Colorado Rockies': { lat: 39.76, lon: -104.99, dome: false, cf: 0, venue: 'Coors Field' },
  'Detroit Tigers': { lat: 42.34, lon: -83.05, dome: false, cf: 30, venue: 'Comerica Park' },
  'Houston Astros': { lat: 29.76, lon: -95.36, dome: true, venue: 'Daikin Park' },
  'Kansas City Royals': { lat: 39.05, lon: -94.48, dome: false, cf: 0, venue: 'Kauffman Stadium' },
  'Los Angeles Angels': { lat: 33.80, lon: -117.88, dome: false, cf: 45, venue: 'Angel Stadium' },
  'Los Angeles Dodgers': { lat: 34.07, lon: -118.24, dome: false, cf: 25, venue: 'Dodger Stadium' },
  'Miami Marlins': { lat: 25.78, lon: -80.22, dome: true, venue: 'loanDepot park' },
  'Milwaukee Brewers': { lat: 43.03, lon: -87.97, dome: true, venue: 'American Family Field' },
  'Minnesota Twins': { lat: 44.98, lon: -93.28, dome: false, cf: 95, venue: 'Target Field' },
  'New York Mets': { lat: 40.76, lon: -73.85, dome: false, cf: 30, venue: 'Citi Field' },
  'New York Yankees': { lat: 40.83, lon: -73.93, dome: false, cf: 25, venue: 'Yankee Stadium' },
  'Athletics': { lat: 38.58, lon: -121.51, dome: false, cf: null, venue: 'Sutter Health Park' },
  'Oakland Athletics': { lat: 38.58, lon: -121.51, dome: false, cf: null, venue: 'Sutter Health Park' },
  'Philadelphia Phillies': { lat: 39.91, lon: -75.17, dome: false, cf: 15, venue: 'Citizens Bank Park' },
  'Pittsburgh Pirates': { lat: 40.45, lon: -80.01, dome: false, cf: 60, venue: 'PNC Park' },
  'San Diego Padres': { lat: 32.71, lon: -117.16, dome: false, cf: 0, venue: 'Petco Park' },
  'San Francisco Giants': { lat: 37.78, lon: -122.39, dome: false, cf: 90, venue: 'Oracle Park' },
  'Seattle Mariners': { lat: 47.59, lon: -122.33, dome: false, cf: 0, venue: 'T-Mobile Park' },
  'St. Louis Cardinals': { lat: 38.62, lon: -90.19, dome: false, cf: 60, venue: 'Busch Stadium' },
  'Tampa Bay Rays': { lat: 27.98, lon: -82.51, dome: false, cf: null, venue: 'Steinbrenner Field' },
  'Texas Rangers': { lat: 32.75, lon: -97.08, dome: true, venue: 'Globe Life Field' },
  'Toronto Blue Jays': { lat: 43.64, lon: -79.39, dome: true, venue: 'Rogers Centre' },
  'Washington Nationals': { lat: 38.87, lon: -77.01, dome: false, cf: 30, venue: 'Nationals Park' },

  // ── NFL ──
  'Arizona Cardinals': { lat: 33.53, lon: -112.26, dome: true, venue: 'State Farm Stadium' },
  'Atlanta Falcons': { lat: 33.75, lon: -84.40, dome: true, venue: 'Mercedes-Benz Stadium' },
  'Baltimore Ravens': { lat: 39.28, lon: -76.62, dome: false, venue: 'M&T Bank Stadium' },
  'Buffalo Bills': { lat: 42.77, lon: -78.79, dome: false, venue: 'Highmark Stadium' },
  'Carolina Panthers': { lat: 35.23, lon: -80.85, dome: false, venue: 'Bank of America Stadium' },
  'Chicago Bears': { lat: 41.86, lon: -87.62, dome: false, venue: 'Soldier Field' },
  'Cincinnati Bengals': { lat: 39.10, lon: -84.52, dome: false, venue: 'Paycor Stadium' },
  'Cleveland Browns': { lat: 41.51, lon: -81.70, dome: false, venue: 'Huntington Bank Field' },
  'Dallas Cowboys': { lat: 32.75, lon: -97.09, dome: true, venue: 'AT&T Stadium' },
  'Denver Broncos': { lat: 39.74, lon: -105.02, dome: false, venue: 'Empower Field' },
  'Detroit Lions': { lat: 42.34, lon: -83.05, dome: true, venue: 'Ford Field' },
  'Green Bay Packers': { lat: 44.50, lon: -88.06, dome: false, venue: 'Lambeau Field' },
  'Houston Texans': { lat: 29.68, lon: -95.41, dome: true, venue: 'NRG Stadium' },
  'Indianapolis Colts': { lat: 39.76, lon: -86.16, dome: true, venue: 'Lucas Oil Stadium' },
  'Jacksonville Jaguars': { lat: 30.32, lon: -81.64, dome: false, venue: 'EverBank Stadium' },
  'Kansas City Chiefs': { lat: 39.05, lon: -94.48, dome: false, venue: 'Arrowhead Stadium' },
  'Las Vegas Raiders': { lat: 36.09, lon: -115.18, dome: true, venue: 'Allegiant Stadium' },
  'Los Angeles Chargers': { lat: 33.95, lon: -118.34, dome: true, venue: 'SoFi Stadium' },
  'Los Angeles Rams': { lat: 33.95, lon: -118.34, dome: true, venue: 'SoFi Stadium' },
  'Miami Dolphins': { lat: 25.96, lon: -80.24, dome: false, venue: 'Hard Rock Stadium' },
  'Minnesota Vikings': { lat: 44.97, lon: -93.26, dome: true, venue: 'U.S. Bank Stadium' },
  'New England Patriots': { lat: 42.09, lon: -71.26, dome: false, venue: 'Gillette Stadium' },
  'New Orleans Saints': { lat: 29.95, lon: -90.08, dome: true, venue: 'Caesars Superdome' },
  'New York Giants': { lat: 40.81, lon: -74.07, dome: false, venue: 'MetLife Stadium' },
  'New York Jets': { lat: 40.81, lon: -74.07, dome: false, venue: 'MetLife Stadium' },
  'Philadelphia Eagles': { lat: 39.90, lon: -75.17, dome: false, venue: 'Lincoln Financial Field' },
  'Pittsburgh Steelers': { lat: 40.45, lon: -80.02, dome: false, venue: 'Acrisure Stadium' },
  'San Francisco 49ers': { lat: 37.40, lon: -121.97, dome: false, venue: "Levi's Stadium" },
  'Seattle Seahawks': { lat: 47.60, lon: -122.33, dome: false, venue: 'Lumen Field' },
  'Tampa Bay Buccaneers': { lat: 27.98, lon: -82.50, dome: false, venue: 'Raymond James Stadium' },
  'Tennessee Titans': { lat: 36.17, lon: -86.77, dome: false, venue: 'Nissan Stadium' },
  'Washington Commanders': { lat: 38.91, lon: -76.86, dome: false, venue: 'Northwest Stadium' },
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg) {
  if (deg == null || !Number.isFinite(deg)) return null;
  return COMPASS[Math.round(deg / 22.5) % 16];
}

// Classify wind relative to a park's center-field bearing.
//   fromDeg  = direction the wind blows FROM (Open-Meteo convention, deg from N)
//   cfBearing = home-plate→CF bearing (deg from N)
// Wind coming FROM the CF direction blows IN toward home (suppresses runs);
// wind from behind home plate blows OUT to CF (boosts runs). Strict thresholds
// keep an approximate bearing from producing a confident-but-wrong call.
// Returns 'in' | 'out' | 'across' | 'unknown'.
export function windEffect(fromDeg, cfBearing) {
  if (fromDeg == null || !Number.isFinite(fromDeg) || cfBearing == null || !Number.isFinite(cfBearing)) return 'unknown';
  // diff = angular distance between where the wind comes FROM and the CF bearing.
  // 0 → wind comes from CF, blowing IN toward home (suppresses runs).
  // 180 → wind comes from behind home, blowing OUT to CF (boosts runs).
  const diff = Math.abs(((fromDeg - cfBearing + 540) % 360) - 180);
  if (diff <= 40) return 'in';
  if (diff >= 140) return 'out';
  return 'across';
}
