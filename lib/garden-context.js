// Where the garden is and what its climate is actually like — shared by
// every AI prompt that gives advice (care guides, garden tips, photo and
// problem diagnoses, Ask), so advice follows the real local seasons rather
// than a generic temperate calendar (no frost protection where it doesn't
// freeze, watering that follows the local dry/rainy seasons, ...).
//
// The climate summary is computed from the past year of daily weather at
// the garden's coordinates (Open-Meteo archive API, free, no key), and
// cached in the garden_cache table per location, refreshed every 90 days.
// The place name comes from the saved location label, or — when the label
// is just "Current location" from GPS — a reverse geocode (cached too).

const sql = require('./db');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CLIMATE_MAX_AGE_DAYS = 90;

// garden_cache is a small key -> JSON store (also used for generated garden
// tips). Created on first use so no separate migration step is needed; the
// same statement is in schema.sql.
let cacheReady = null;
function ensureCacheTable() {
  if (!cacheReady) {
    cacheReady = sql`
      create table if not exists garden_cache (
        key        text primary key,
        value      jsonb not null,
        updated_at timestamptz not null default now()
      )
    `.catch((e) => { cacheReady = null; throw e; });
  }
  return cacheReady;
}
async function cacheGet(key, maxAgeDays) {
  await ensureCacheTable();
  const [row] = await sql`select value, updated_at from garden_cache where key = ${key}`;
  if (!row) return null;
  if (maxAgeDays && (Date.now() - new Date(row.updated_at).getTime()) > maxAgeDays * 86400000) return null;
  return row.value;
}
// Always JSON-encode: jsonParam() passes plain strings through untouched,
// which a jsonb column would then reject as invalid JSON.
async function cacheSet(key, value) {
  await ensureCacheTable();
  await sql`
    insert into garden_cache (key, value, updated_at) values (${key}, ${JSON.stringify(value)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

async function geocodeLabel(label) {
  const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(label));
  const data = await r.json();
  const hit = data && data.results && data.results[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude, place: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ') } : null;
}

async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=en&latitude=' + lat + '&longitude=' + lon);
    if (!r.ok) return '';
    const d = await r.json();
    return [d.city || d.locality, d.principalSubdivision, d.countryName].filter(Boolean).join(', ');
  } catch (e) {
    return '';
  }
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

// Monthly averages over the last full year of daily data.
async function computeClimate(lat, lon) {
  const end = new Date(Date.now() - 7 * 86400000); // archive lags a few days
  const start = new Date(end.getTime() - 364 * 86400000);
  const url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon +
    '&start_date=' + isoDay(start) + '&end_date=' + isoDay(end) +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open-Meteo archive request failed: ' + r.status);
  const d = (await r.json()).daily || {};
  const months = MONTHS.map(() => ({ hi: [], lo: [], rain: 0 }));
  (d.time || []).forEach((day, i) => {
    const m = months[Number(day.slice(5, 7)) - 1];
    if (d.temperature_2m_max[i] != null) m.hi.push(d.temperature_2m_max[i]);
    if (d.temperature_2m_min[i] != null) m.lo.push(d.temperature_2m_min[i]);
    m.rain += d.precipitation_sum[i] || 0;
  });
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const lows = (d.temperature_2m_min || []).filter((v) => v != null);
  return {
    months: months.map((m, i) => ({
      month: i + 1,
      avgHigh: avg(m.hi) == null ? null : Math.round(avg(m.hi)),
      avgLow: avg(m.lo) == null ? null : Math.round(avg(m.lo)),
      coldest: m.lo.length ? Math.round(Math.min(...m.lo)) : null,
      hottest: m.hi.length ? Math.round(Math.max(...m.hi)) : null,
      rainMm: Math.round(m.rain),
    })),
    frostNights: lows.filter((v) => v <= 0).length,
    coldestNight: lows.length ? Math.round(Math.min(...lows) * 10) / 10 : null,
    from: isoDay(start),
    to: isoDay(end),
  };
}

function climateText(c) {
  if (!c) return '';
  const lines = c.months.map((m) =>
    MONTHS[m.month - 1] + ': highs ~' + m.avgHigh + '°C, lows ~' + m.avgLow + '°C (coldest ' + m.coldest + '°C, hottest ' + m.hottest + '°C), rain ' + m.rainMm + ' mm'
  );
  return 'Measured local weather over the past year (' + c.from + ' to ' + c.to + '):\n' + lines.join('\n') +
    '\nNights at or below 0°C in that year: ' + c.frostNights + ' (coldest night ' + c.coldestNight + '°C).';
}

// -> {place, lat, lon, climate, text}. Never throws: anything it can't
// work out is just left out of the text.
async function getGardenContext() {
  const out = { place: '', lat: null, lon: null, climate: null, text: '' };
  try {
    const [row] = await sql`select location from settings where id = true`;
    const loc = (row && row.location) || {};
    const label = loc.label && !/^(current location|unspecified)$/i.test(loc.label) ? loc.label : '';
    if (loc.lat != null && loc.lon != null) {
      out.lat = Number(loc.lat); out.lon = Number(loc.lon);
    } else if (label) {
      const g = await geocodeLabel(label).catch(() => null);
      if (g) { out.lat = g.lat; out.lon = g.lon; out.place = g.place; }
    }
    out.place = label || out.place;
    if (out.lat != null) {
      const key = out.lat.toFixed(2) + ',' + out.lon.toFixed(2);
      // Each lookup fails on its own: the coordinates alone still go in.
      if (!out.place) {
        try {
          out.place = (await cacheGet('place:' + key)) || '';
          if (!out.place) {
            out.place = await reverseGeocode(out.lat, out.lon);
            if (out.place) await cacheSet('place:' + key, out.place);
          }
        } catch (e) { /* no place name */ }
      }
      try {
        out.climate = await cacheGet('climate:' + key, CLIMATE_MAX_AGE_DAYS);
        if (!out.climate) {
          out.climate = await computeClimate(out.lat, out.lon);
          await cacheSet('climate:' + key, out.climate);
        }
      } catch (e) { /* keep whatever climate we computed, if any */ }
    }
  } catch (e) { /* fall through with whatever we have */ }

  const where = out.place || (out.lat != null ? 'an unnamed place' : 'an unknown location');
  const coords = out.lat != null ? ' (' + Math.abs(out.lat).toFixed(2) + '°' + (out.lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(out.lon).toFixed(2) + '°' + (out.lon >= 0 ? 'E' : 'W') + ')' : '';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.text = 'The garden is in ' + where + coords + '. Today is ' + today + '.' +
    (out.climate ? '\n' + climateText(out.climate) : '') +
    '\nBase all advice and timing on this location\'s real climate and seasons — month by month, as they actually are there — not on a generic temperate or northern-European calendar. ' +
    'Only mention frost or cold protection if frost or damaging cold realistically happens at this location in that season; likewise adapt watering to the local dry and rainy seasons and heat.';
  return out;
}

module.exports = { getGardenContext, cacheGet, cacheSet, ensureCacheTable };
