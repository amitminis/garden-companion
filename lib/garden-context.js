// Where the garden is and what its climate is actually like — shared by
// every AI prompt that gives advice (care guides, garden tips, photo and
// problem diagnoses, Ask), so advice follows the real local seasons rather
// than a generic temperate calendar (no frost protection where it doesn't
// freeze, watering that follows the local dry/rainy seasons, ...).
//
// The climate summary is computed from the past year of daily weather at
// the garden's coordinates (Open-Meteo archive API, free, no key), and
// cached in the garden_cache table per location, refreshed every 90 days.
// The place name is the gardener's own location label (Settings). A GPS-only
// location ("Current location") goes in as coordinates alone: reverse
// geocoding was tried and named the nearest larger city instead of the
// actual town, so no name is better than a wrong one — the coordinates and
// the measured climate are what the advice is based on anyway.

const sql = require('./db');
const { getLanguage, languageInstruction } = require('./language');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CLIMATE_MAX_AGE_DAYS = 90;

// garden_cache is a small key -> JSON store (the climate summary, and the
// generated garden tips). Created on first use so no separate migration step is needed; the
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

// -> {place, lat, lon, climate, language, text}. Never throws: anything
// it can't work out is just left out of the text. The text ends with the
// instruction to write in the gardener's language (lib/language.js), so
// every prompt built on it answers in that language.
async function getGardenContext() {
  const out = { place: '', lat: null, lon: null, climate: null, language: await getLanguage(), text: '' };
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
      // If this fails, the coordinates alone still go in.
      try {
        out.climate = await cacheGet('climate:' + key, CLIMATE_MAX_AGE_DAYS);
        if (!out.climate) {
          out.climate = await computeClimate(out.lat, out.lon);
          await cacheSet('climate:' + key, out.climate);
        }
      } catch (e) { /* keep whatever climate we computed, if any */ }
    }
  } catch (e) { /* fall through with whatever we have */ }

  const where = out.place || (out.lat != null ? 'a location given only by its coordinates' : 'an unknown location');
  const coords = out.lat != null ? ' (' + Math.abs(out.lat).toFixed(2) + '°' + (out.lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(out.lon).toFixed(2) + '°' + (out.lon >= 0 ? 'E' : 'W') + ')' : '';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.text = 'The garden is in ' + where + coords + '. Today is ' + today + '.' +
    (out.climate ? '\n' + climateText(out.climate) : '') +
    '\nBase all advice and timing on this location\'s real climate and seasons — month by month, as they actually are there — not on a generic temperate or northern-European calendar. ' +
    'Only mention frost or cold protection if frost or damaging cold realistically happens at this location in that season; likewise adapt watering to the local dry and rainy seasons and heat.' +
    '\n' + languageInstruction(out.language);
  return out;
}

module.exports = { getGardenContext, cacheGet, cacheSet, ensureCacheTable };
