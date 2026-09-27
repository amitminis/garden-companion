// Shared "fetch the current forecast from Open-Meteo and store it" logic
// used by the on-demand refresh endpoint (api/weather-refresh.js) — called
// automatically every time the app opens and from the dashboard weather
// card's Refresh button, so the forecast shown is never stuck waiting on
// the once-a-day cron job. Deliberately does NOT touch whatever alert text
// is already on today's weather row or run the AI alert-decision — that
// stays the daily cron's job (api/cron/daily.js) so a quick manual refresh
// never accidentally clears today's weather-alert banner and stays fast
// (a live Open-Meteo fetch only, no agent call).

const sql = require('./db');
const { friendlyWeather } = require('./weather');
const { jsonParam } = require('./mappers');

async function geocodeLabel(label) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(label);
  const r = await fetch(url);
  const data = await r.json();
  const hit = data && data.results && data.results[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
}

async function fetchForecast(lat, lon) {
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max' +
    '&forecast_days=3&timezone=auto';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open-Meteo request failed: ' + r.status);
  return r.json();
}

async function refreshWeatherQuick() {
  const [settingsRow] = await sql`select * from settings where id = true`;
  const location = (settingsRow && settingsRow.location) || {};
  let coords = (location.lat != null && location.lon != null) ? { lat: location.lat, lon: location.lon } : null;
  if (!coords && location.label && location.label !== 'Unspecified') {
    coords = await geocodeLabel(location.label);
  }
  if (!coords) return null;

  const forecast = await fetchForecast(coords.lat, coords.lon);
  const [existing] = await sql`select data from weather where id = true`;
  const previousAlert = (existing && existing.data && existing.data.alert) || '';
  const weatherData = friendlyWeather(forecast, location.label, previousAlert);

  await sql`
    insert into weather (id, data, updated_at) values (true, ${jsonParam(weatherData)}, now())
    on conflict (id) do update set data = excluded.data, updated_at = now()
  `;
  return weatherData;
}

module.exports = { geocodeLabel, fetchForecast, refreshWeatherQuick };
