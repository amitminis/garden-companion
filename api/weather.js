// GET /api/weather -> the latest weather snapshot written by the daily cron
// (mirrors the Artifact's weather/latest doc), in the friendly shape the
// frontend's weatherCard() reads: {tempLabel, forecast, locationLabel,
// fetchedAt, alert, updatedAt}. `null` if the cron hasn't run yet.

const sql = require('../lib/db');
const { friendlyWeather } = require('../lib/weather');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const [row] = await sql`select * from weather where id = true`;
  if (!row) {
    res.status(200).json(null);
    return;
  }
  let data = row.data || {};
  // Rows written before the cron stored the friendly shape hold the raw
  // Open-Meteo object — convert on read so the card still renders.
  if (!('tempLabel' in data) && data.daily) {
    const [s] = await sql`select location from settings where id = true`;
    data = Object.assign(friendlyWeather(data, s && s.location && s.location.label, ''), {
      fetchedAt: new Date(row.updated_at).toISOString(),
    });
  }
  res.status(200).json(Object.assign({}, data, { updatedAt: row.updated_at }));
};
