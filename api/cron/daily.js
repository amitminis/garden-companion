// GET /api/cron/daily — invoked once a day by Vercel Cron (see vercel.json).
//
// Replaces the Claude Code Remote scheduled trigger's two responsibilities,
// as described in the AI-touchpoints doc: (1) fetch weather and decide
// whether a weather-alert task is warranted, (2) create the weekly photo
// check-in on the configured day. Unlike the other endpoints in this repo,
// this ISN'T a line-for-line port — that daily logic lived in the external
// scheduled trigger's own instructions, not in garden-companion.html, so
// this is a fresh implementation matching the documented behavior. Review
// the weather-alert prompt below and adjust it to taste.
//
// Security: set a CRON_SECRET env var (any random string) and Vercel will
// send it as `Authorization: Bearer <CRON_SECRET>` on cron-triggered
// requests automatically — checked below so this endpoint can't be
// triggered by a random request to a guessable URL.

const sql = require('../../lib/db');
const { completeJson } = require('../../lib/ai');
const { todayISO } = require('../../lib/dates');
const { friendlyWeather } = require('../../lib/weather');
const { jsonParam } = require('../../lib/mappers');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function geocode(label) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(label);
  const r = await fetch(url);
  const data = await r.json();
  const hit = data && data.results && data.results[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
}

async function fetchWeather(lat, lon) {
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max' +
    '&forecast_days=3&timezone=auto';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open-Meteo request failed: ' + r.status);
  return r.json();
}

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const summary = { weatherChecked: false, alertCreated: false, checkinTasksCreated: 0, errors: [] };

  // --- 1. Weather check + alert decision -------------------------------
  try {
    let [settingsRow] = await sql`select * from settings where id = true`;
    const location = (settingsRow && settingsRow.location) || {};
    let coords = (location.lat != null && location.lon != null) ? { lat: location.lat, lon: location.lon } : null;
    if (!coords && location.label && location.label !== 'Unspecified') {
      coords = await geocode(location.label);
    }

    if (coords) {
      const forecast = await fetchWeather(coords.lat, coords.lon);

      const plants = await sql`select name, type from plants`;
      const plantList = plants.map((p) => p.name + ' (' + p.type + ')').join(', ') || 'no plants yet';
      const prompt =
        'You are a home gardening expert reviewing a 3-day weather forecast (Open-Meteo JSON, temperatures in the API\'s default units) ' +
        'for a garden with these plants: ' + plantList + '. Forecast: ' + JSON.stringify(forecast.daily) + '. ' +
        'Decide if anything in this forecast (frost, heat, heavy rain/wind, etc.) genuinely warrants a proactive heads-up for THIS garden ' +
        '— most days warrant nothing. Reply with only a JSON object: {"alertWarranted": boolean, "title": short imperative task title if warranted else "", ' +
        '"description": one to two sentence explanation and recommended action if warranted else ""}.';

      let decision;
      try {
        decision = await completeJson(prompt, { timeoutMs: 60_000 });
      } catch (e) {
        summary.errors.push('weather-alert reasoning failed: ' + String(e.message || e));
        decision = null;
      }

      // Single weather write, AFTER the alert decision, in the friendly
      // shape the frontend's weatherCard() reads (see lib/weather.js).
      const weatherData = friendlyWeather(
        forecast,
        location.label,
        decision && decision.alertWarranted ? (decision.title || 'Weather heads-up') : ''
      );
      await sql`
        insert into weather (id, data, updated_at) values (true, ${jsonParam(weatherData)}, now())
        on conflict (id) do update set data = excluded.data, updated_at = now()
      `;
      summary.weatherChecked = true;

      if (decision && decision.alertWarranted) {
        await sql`
          insert into tasks (title, description, due_date, status, kind, reason, severity, year, requests_photo)
          values (${decision.title || 'Weather heads-up'}, ${decision.description || ''}, ${todayISO()},
                  'pending', 'issue', 'weather alert', 'warning', ${new Date().getFullYear()}, false)
        `;
        summary.alertCreated = true;
      }
    }
  } catch (e) {
    summary.errors.push('weather step failed: ' + String(e.message || e));
  }

  // --- 2. Weekly photo check-in -----------------------------------------
  try {
    const [settingsRow] = await sql`select * from settings where id = true`;
    const checkinDay = (settingsRow && settingsRow.photo_checkin_day) || 'Friday';
    const today = new Date();
    if (DAY_NAMES[today.getDay()] === checkinDay) {
      const plants = await sql`select id, name from plants`;
      const year = today.getFullYear();
      for (const plant of plants) {
        await sql`
          insert into tasks (plant_id, plant_name, title, description, due_date, status, kind, reason, severity, year, requests_photo)
          values (${plant.id}, ${plant.name}, ${'Weekly check-in: ' + plant.name}, 'A quick photo to keep track of how it\'s doing.',
                  ${todayISO()}, 'pending', 'checkin', 'weekly checkin', 'info', ${year}, true)
        `;
        summary.checkinTasksCreated++;
      }
    }
  } catch (e) {
    summary.errors.push('weekly check-in step failed: ' + String(e.message || e));
  }

  res.status(200).json(summary);
};
