// GET /api/tips?month=1-12  (rewritten to /api/ask?mode=tips — see
// vercel.json; folded into api/ask.js to stay under the Hobby plan's
// Function cap)
//
// The dashboard's seasonal "Garden tips": written by the model for THIS
// garden — its location and measured climate (lib/garden-context.js), its
// plants and their spots — for one month (the current one by default; the
// All tips sheet browses the others). Replaces a fixed, temperate-climate
// tip list that suggested frost protection in places where it never
// freezes.
//
// Cached in garden_cache per month + garden signature (location, plants
// and language), so each month is generated once and only regenerated when
// the garden changes. -> {month, year, tips: [{id, emoji, theme, title, body, plants,
// task: {title, description, dueInDays}}], generatedAt}

const crypto = require('crypto');
const sql = require('../db');
const { completeJson, AI_UNAVAILABLE } = require('../ai');
const { getGardenContext, cacheGet, cacheSet } = require('../garden-context');
const { isoDate, todayISO } = require('../dates');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CACHE_VERSION = 'v1';

const str = (description) => ({ type: 'string', description });
const TIPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tips'],
  properties: {
    tips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['emoji', 'theme', 'title', 'body', 'plants', 'task'],
        properties: {
          emoji: str('One emoji that fits the tip.'),
          theme: { type: 'string', enum: ['winter', 'spring', 'summer', 'autumn'], description: 'The season this month feels like at this location (sets the card color).' },
          title: str('Short, friendly headline (max ~6 words), e.g. "Time to sow winter herbs".'),
          body: str('One or two sentences: what to do now and why — specific to this place and month.'),
          plants: { type: 'array', items: { type: 'string' }, description: 'Names of the garden\'s plants this tip is about, exactly as listed (empty for a general tip).' },
          task: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'description', 'dueInDays'],
            properties: {
              title: str('Short imperative task title for the to-do list.'),
              description: str('One or two sentences on exactly what to do.'),
              dueInDays: { type: 'integer', description: 'When to do it, in days from the reference date given in the prompt (0-27).' },
            },
          },
        },
      },
    },
  },
};

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tip';
}

function plantLine(p) {
  const details = p.plant_details || {};
  const d = (k) => { const v = details[k]; const t = v && (typeof v === 'string' ? v : (v.display || v.raw)); return t && !/^not sure/i.test(t) ? t : ''; };
  return '- ' + p.name + ' (' + [p.species, p.type, p.spot ? 'at ' + p.spot : '', d('sunExposure'), d('watering'), d('groundType'), d('age') ? 'age ' + d('age') : ''].filter(Boolean).join(', ') + ')';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const today = todayISO();
  const now = new Date(today + 'T00:00:00');
  const thisMonth = now.getMonth() + 1;
  let month = parseInt(req.query.month, 10);
  if (!(month >= 1 && month <= 12)) month = thisMonth;
  // Browsing ahead: an earlier month than now means next year's.
  const year = month >= thisMonth ? now.getFullYear() : now.getFullYear() + 1;
  const isCurrent = month === thisMonth && year === now.getFullYear();

  try {
    const [garden, plants] = await Promise.all([
      getGardenContext(),
      sql`select id, name, type, species, spot, plant_details from plants order by created_at asc limit 200`,
    ]);
    const signature = crypto.createHash('sha1').update(JSON.stringify({
      lat: garden.lat == null ? null : garden.lat.toFixed(2), lon: garden.lon == null ? null : garden.lon.toFixed(2), place: garden.place, language: garden.language,
      plants: plants.map((p) => [p.name, p.type, p.species, p.spot, p.plant_details]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    })).digest('hex').slice(0, 16);
    const key = 'tips:' + CACHE_VERSION + ':' + year + '-' + String(month).padStart(2, '0') + ':' + signature;

    const cached = await cacheGet(key);
    if (cached) { res.status(200).json(cached); return; }

    // Already-scheduled care tasks that month, so tips don't repeat them.
    const from = isoDate(year, month, 1);
    const to = isoDate(year, month, 28);
    const scheduled = await sql`select title, plant_name from tasks where due_date between ${from} and ${to} and status <> 'done' limit 40`;

    const refDate = isCurrent ? 'today (' + today + ')' : 'the 1st of ' + MONTH_NAMES[month - 1] + ' ' + year;
    const prompt =
      garden.text + '\n\n' +
      'The plants in this garden:\n' + (plants.map(plantLine).join('\n') || '- (no plants added yet)') + '\n\n' +
      (scheduled.length ? 'Already on their to-do list that month (don\'t repeat these): ' + scheduled.map((t) => t.title + (t.plant_name ? ' (' + t.plant_name + ')' : '')).join('; ') + '.\n\n' : '') +
      'Write 4 to 7 garden tips for ' + MONTH_NAMES[month - 1] + ' ' + year + ' for this exact garden: timely things to do, plant, sow, buy, prepare for or watch out for ' +
      'in this month at this location. Every tip must be correct for the local climate in that month (use the measured weather above) — nothing that belongs to a different climate or season. ' +
      'Mix tips for specific plants in this garden (name them) with a couple of general ones that suit this region in this month (e.g. what is good to sow or plant here now). ' +
      'Each tip comes with one concrete task; its dueInDays counts from ' + refDate + '.\n' + garden.languageLine;

    const result = await completeJson(prompt, { effort: 'medium', schema: TIPS_SCHEMA, timeoutMs: 120_000 });
    const seen = {};
    const tips = (result.tips || []).map((t) => {
      let id = slug(t.title);
      while (seen[id]) id += '-2';
      seen[id] = true;
      return {
        id, emoji: t.emoji, theme: t.theme, title: t.title, body: t.body,
        plants: Array.isArray(t.plants) ? t.plants : [],
        task: { title: t.task.title, description: t.task.description, dueInDays: Math.max(0, Math.min(27, parseInt(t.task.dueInDays, 10) || 0)) },
      };
    });
    const out = { month, year, place: garden.place, tips, generatedAt: new Date().toISOString() };
    if (tips.length) await cacheSet(key, out);
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ month, year, tips: [], error: e && e.message === AI_UNAVAILABLE ? 'AI unavailable' : String((e && e.message) || e) });
  }
};
