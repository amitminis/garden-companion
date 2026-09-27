// POST /api/weather-refresh — on-demand weather check. Called automatically
// every time the app loads and from the dashboard weather card's Refresh
// button (see public/js/app.js's refreshWeatherNow()), so the forecast
// shown is never stale waiting on the once-a-day cron (api/cron/daily.js,
// which still separately handles the weather-alert task decision once a
// day). Fast: a live Open-Meteo fetch, no AI call.

const { refreshWeatherQuick } = require('../lib/weather-fetch');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const data = await refreshWeatherQuick();
    if (!data) {
      res.status(200).json({ error: 'No location set yet' });
      return;
    }
    res.status(200).json(data);
  } catch (e) {
    res.status(200).json({ error: String((e && e.message) || e) });
  }
};
