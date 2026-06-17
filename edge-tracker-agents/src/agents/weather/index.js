// ══════════════════════════════════════════════════════════════
// Weather Intelligence — pulls game-time forecasts from Open-Meteo
// (free, no API key) by stadium lat/long. Replaces the old Claude
// web-search version: $0 per call and more accurate (exact wind at the
// venue vs. reading weather sites). Dome/retractable parks are flagged
// neutral without any network call.
//
// Wind is the headline edge: 15+ mph outdoors → Under lean (and the
// Prop Engine uses it for QB passing-yard Unders).
// ══════════════════════════════════════════════════════════════
import db from '../../db/index.js';
import { logger } from '../../utils/index.js';
import { getGames, setIntel } from '../../store/index.js';
import { VENUES, compass } from './venues.js';

// Only sports we have venue coordinates for (and where weather matters).
const WEATHER_SPORTS = new Set(['MLB', 'NFL']);

async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    hourly: 'temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,precipitation_probability',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', timezone: 'GMT', forecast_days: '2',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  return res.json();
}

// Pick the hourly index nearest the game's start time.
function nearestHour(times, commenceMs) {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const ms = Date.parse(t.length === 16 ? `${t}:00Z` : `${t}Z`);
    const diff = Math.abs(ms - commenceMs);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

function lean({ dome, wind, temp }) {
  if (dome) return 'neutral';
  if (wind >= 15) return 'under';
  if (temp != null && temp <= 40 && wind >= 10) return 'under';
  return 'neutral';
}

async function run() {
  const games = getGames().filter((g) => WEATHER_SPORTS.has(g.sport));
  if (!games.length) return { summary: 'no outdoor games on the slate' };

  const now = new Date().toISOString();
  const rows = [];
  let calls = 0, domes = 0, windy = 0, unmatched = 0;

  for (const g of games) {
    const v = VENUES[g.home];
    if (!v) { unmatched++; continue; }

    const base = {
      sport: g.sport, game_id: g.game_id, home: g.home, away: g.away,
      venue: v.venue, fetched_at: now,
    };

    if (v.dome) {
      domes++;
      rows.push({ ...base, dome: true, temp_f: null, wind_mph: null, wind_dir: null, precip: null, conditions: 'Dome / roof closed', total_impact: 'neutral' });
      continue;
    }

    try {
      const fc = await fetchForecast(v.lat, v.lon);
      calls++;
      const h = fc.hourly || {};
      const idx = nearestHour(h.time || [], Date.parse(g.commence_time || now));
      const temp = num(h.temperature_2m?.[idx]);
      const wind = num(h.wind_speed_10m?.[idx]) ?? 0;
      const dir = compass(num(h.wind_direction_10m?.[idx]));
      const precip = num(h.precipitation?.[idx]);
      const pop = num(h.precipitation_probability?.[idx]);
      const impact = lean({ dome: false, wind, temp });
      if (impact === 'under') windy++;
      rows.push({
        ...base, dome: false, temp_f: temp, wind_mph: wind, wind_dir: dir,
        precip: precip != null ? `${precip}in (${pop ?? 0}%)` : null,
        conditions: `${temp != null ? Math.round(temp) + '°F' : ''} wind ${Math.round(wind)}mph${dir ? ' ' + dir : ''}`.trim(),
        total_impact: impact,
      });
    } catch (e) {
      logger.warn('weather', `${g.home}: ${e.message}`);
    }
  }

  if (rows.length) {
    try { await db.insert('game_weather', rows); } catch (e) { logger.warn('weather', e.message); }
  }
  setIntel('weather', rows);
  return {
    summary: `${rows.length} forecasts (${windy} windy → Under, ${domes} domes)${unmatched ? `, ${unmatched} no-venue` : ''} · free Open-Meteo`,
    data: { count: rows.length, windy, domes, calls },
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export default { name: 'weather', run };
