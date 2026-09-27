// Builds the friendly weather shape the frontend's weatherCard() reads
// ({tempLabel, forecast, locationLabel, fetchedAt, alert}) from a raw
// Open-Meteo daily forecast. Deterministic — no AI call. Used by
// api/cron/daily.js when storing, and by api/weather.js to upgrade any
// older row that still holds the raw Open-Meteo object.

function describeDay(precipProb, windMax) {
  const p = Number(precipProb);
  const w = Number(windMax);
  if (p >= 50) return Math.round(p) + '% chance of rain';
  if (w > 30) return p >= 20 ? 'Breezy, light chance of rain' : 'Breezy and dry';
  if (p >= 20) return 'Mostly dry, light chance of rain';
  return 'Clear and mild';
}

function friendlyWeather(forecast, locationLabel, alert) {
  const d = (forecast && forecast.daily) || {};
  const max = d.temperature_2m_max && d.temperature_2m_max[0];
  const min = d.temperature_2m_min && d.temperature_2m_min[0];
  const tempLabel = (max != null && min != null) ? Math.round(max) + '° / ' + Math.round(min) + '°' : '';
  const precip = d.precipitation_probability_max ? d.precipitation_probability_max[0] : 0;
  const wind = d.wind_speed_10m_max ? d.wind_speed_10m_max[0] : 0;
  return {
    tempLabel,
    forecast: describeDay(precip || 0, wind || 0),
    locationLabel: locationLabel || '',
    fetchedAt: new Date().toISOString(),
    alert: alert || '',
  };
}

module.exports = { friendlyWeather };
