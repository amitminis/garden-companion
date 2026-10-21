// POST /api/translate   body: {plantId} | {scope: "general"}
// (rewritten to /api/settings?action=translate — see vercel.json; folded
// into api/settings.js to stay under the Hobby plan's Function cap)
//
// Translates the garden's existing content into the saved language
// (settings.language), so switching language leaves nothing behind in the
// old one: content written before the switch, by the model (care guides,
// schedules, diagnoses, tips) or by the gardener (plant names, notes).
// One call per plant — its name, care guide, yearly schedule, photo notes,
// details and all its tasks, in a single model request so the plant's new
// name is used consistently — plus one "general" call for tasks that
// aren't about a plant, the garden's location name and today's weather
// alert. The client runs these one after another (Settings / the Home
// banner).
//
// Only text that is in another language is sent: for Hebrew, anything with
// Latin letters and no Hebrew letters. Preset answers (sun, watering, ...)
// stay as their English keys — the app shows those translated itself.
// Identical strings are sent once (a care-guide task repeats its schedule
// entry's title and note). -> {translated: <number of strings changed>}

const sql = require('../db');
const { plantFromRow, taskFromRow, jsonParam } = require('../mappers');
const { completeJson, AI_UNAVAILABLE } = require('../ai');
const { getLanguage, LANGUAGES } = require('../language');

// Preset option values the app saves in English and translates on display
// (public/js/app.js: SPOT/AGE/SUN/WATERING/GROUND_OPTIONS).
const PRESETS = new Set([
  'Front yard', 'Backyard', 'Side yard', 'Patio / pots', 'Raised bed', 'Greenhouse', 'Balcony', 'Windowsill',
  'Just planted', 'Less than 1 year', '1–2 years', '3–5 years', 'More than 5 years', 'Not sure',
  'Full sun (6+ hrs)', 'Partial sun (4–6 hrs)', 'Partial shade (2–4 hrs)', 'Full shade (under 2 hrs)',
  'Drip irrigation', 'Sprinkler', 'Hand watering', 'Rain-fed only',
  'Clay soil', 'Sandy soil', 'Loamy soil', 'Pot / container',
]);
const SENTINEL_LABELS = /^(current location|unspecified)$/i;

const HEBREW = /[֐-׿]/;
const LATIN = /[A-Za-z]/;
function needsTranslation(s, lang) {
  if (typeof s !== 'string' || !s.trim() || PRESETS.has(s)) return false;
  return lang === 'he' ? (LATIN.test(s) && !HEBREW.test(s)) : HEBREW.test(s);
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
};

// Collects strings to translate. add(text, apply) registers one string and
// the function that writes its translation back; identical texts share one
// id.
function collector(lang) {
  const byText = new Map();
  return {
    add(text, apply) {
      if (!needsTranslation(text, lang)) return;
      if (!byText.has(text)) byText.set(text, { id: 's' + byText.size, apply: [] });
      byText.get(text).apply.push(apply);
    },
    entries() { return [...byText.entries()].map(([text, e]) => ({ id: e.id, text, apply: e.apply })); },
  };
}

async function translateAll(entries, lang, context) {
  if (!entries.length) return 0;
  const language = LANGUAGES[lang];
  const prompt =
    'Translate each of these texts from a home-gardening app into ' + language + '. ' + context + ' ' +
    (lang === 'he'
      ? 'Use natural, everyday Israeli Hebrew and the plant and pest names Israeli gardeners use (e.g. "Raspbery" or "Raspberry" -> "פטל", "Lemon tree" -> "עץ לימון"); fix obvious typos; ' +
        'address the gardener in gender-neutral forms (plural or infinitive); scientific Latin names may stay in Latin. '
      : '') +
    'Keep numbers, units, months and the meaning exactly; keep the same tone and length (a short task title stays a short task title). ' +
    'Return every id exactly once with its translation.\n\n' +
    JSON.stringify(entries.map((e) => ({ id: e.id, text: e.text })));
  const result = await completeJson(prompt, { schema: SCHEMA, effort: 'low', timeoutMs: 240_000 });
  const out = new Map((result.items || []).map((i) => [i.id, i.text]));
  let n = 0;
  for (const e of entries) {
    const t = out.get(e.id);
    if (typeof t === 'string' && t.trim()) { e.apply.forEach((fn) => fn(t.trim())); n++; }
  }
  return n;
}

// A task's own translatable text (title, description, comments, photo note).
function addTask(c, t) {
  c.add(t.title, (v) => { t.title = v; t.dirty = true; });
  c.add(t.description, (v) => { t.description = v; t.dirty = true; });
  (t.comments || []).forEach((cm) => c.add(cm.text, (v) => { cm.text = v; t.dirty = true; }));
  if (t.photo) c.add(t.photo.analysis, (v) => { t.photo.analysis = v; t.dirty = true; });
}
async function saveTasks(tasks) {
  for (const t of tasks.filter((x) => x.dirty)) {
    await sql`
      update tasks set title = ${t.title}, description = ${t.description}, plant_name = ${t.plantName || ''},
        comments = ${jsonParam(t.comments || [])}, photo = ${jsonParam(t.photo)}
      where id = ${t.id}
    `;
  }
}

async function translatePlant(plantId, lang) {
  const [row] = await sql`select * from plants where id = ${plantId}`;
  const p = plantFromRow(row);
  if (!p) return null;
  const tasks = (await sql`select * from tasks where plant_id = ${plantId}`).map(taskFromRow);
  const c = collector(lang);

  c.add(p.name, (v) => { p.name = v; tasks.forEach((t) => { t.plantName = v; t.dirty = true; }); });
  c.add(p.species, (v) => { p.species = v; });
  c.add(p.spot, (v) => { p.spot = v; });
  c.add(p.notes, (v) => { p.notes = v; });
  c.add(p.sizeInfo, (v) => { p.sizeInfo = v; });
  c.add(p.ageEstimate, (v) => { p.ageEstimate = v; });
  Object.keys(p.careProfile || {}).forEach((k) => c.add(p.careProfile[k], (v) => { p.careProfile[k] = v; }));
  (p.yearlySchedule || []).forEach((e) => {
    c.add(e.title, (v) => { e.title = v; });
    c.add(e.note, (v) => { e.note = v; });
  });
  (p.photos || []).forEach((ph) => {
    c.add(ph.summary, (v) => { ph.summary = v; });
    c.add(ph.userNote, (v) => { ph.userNote = v; });
    (ph.issues || []).forEach((is, i) => c.add(is, (v) => { ph.issues[i] = v; }));
  });
  if (p.activeIssue) c.add(p.activeIssue.description, (v) => { p.activeIssue.description = v; });
  Object.keys(p.plantDetails || {}).forEach((k) => {
    const d = p.plantDetails[k];
    if (typeof d === 'string') c.add(d, (v) => { p.plantDetails[k] = v; });
    else if (d) {
      c.add(d.raw, (v) => { d.raw = v; });
      c.add(d.display, (v) => { d.display = v; });
    }
  });
  // A task still named after the plant's old name (e.g. renamed earlier).
  tasks.forEach((t) => {
    c.add(t.plantName, (v) => { t.plantName = v; t.dirty = true; });
    addTask(c, t);
  });

  const n = await translateAll(c.entries(), lang,
    'They all belong to one plant in the garden, "' + p.name + '" — translate its name the same way wherever it appears.');
  if (!n) return 0;
  await sql`
    update plants set name = ${p.name}, species = ${p.species}, spot = ${p.spot}, notes = ${p.notes},
      size_info = ${p.sizeInfo}, age_estimate = ${p.ageEstimate},
      care_profile = ${jsonParam(p.careProfile)}, yearly_schedule = ${jsonParam(p.yearlySchedule || [])},
      photos = ${jsonParam(p.photos || [])}, active_issue = ${jsonParam(p.activeIssue)},
      plant_details = ${jsonParam(p.plantDetails || {})}, updated_at = now()
    where id = ${plantId}
  `;
  await saveTasks(tasks);
  return n;
}

async function translateGeneral(lang) {
  const tasks = (await sql`select * from tasks where plant_id is null`).map(taskFromRow);
  const [settingsRow] = await sql`select location from settings where id = true`;
  const location = (settingsRow && settingsRow.location) || {};
  const [weatherRow] = await sql`select data from weather where id = true`;
  const weather = (weatherRow && weatherRow.data) || {};
  const c = collector(lang);
  let locationDirty = false, weatherDirty = false;

  tasks.forEach((t) => addTask(c, t));
  if (location.label && !SENTINEL_LABELS.test(location.label)) {
    c.add(location.label, (v) => { location.label = v; locationDirty = true; });
  }
  c.add(weather.alert, (v) => { weather.alert = v; weatherDirty = true; });
  if (weather.locationLabel && !SENTINEL_LABELS.test(weather.locationLabel)) {
    c.add(weather.locationLabel, (v) => { weather.locationLabel = v; weatherDirty = true; });
  }

  const n = await translateAll(c.entries(), lang, 'Place names are the gardener\'s town and country — use their usual name in this language.');
  if (!n) return 0;
  await saveTasks(tasks);
  if (locationDirty) await sql`update settings set location = ${jsonParam(location)} where id = true`;
  if (weatherDirty) await sql`update weather set data = ${jsonParam(weather)} where id = true`;
  return n;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const body = req.body || {};
  const lang = await getLanguage();
  try {
    let n;
    if (body.plantId) {
      n = await translatePlant(String(body.plantId), lang);
      if (n === null) { res.status(404).json({ error: 'Plant not found' }); return; }
    } else {
      n = await translateGeneral(lang);
    }
    res.status(200).json({ translated: n, language: lang });
  } catch (e) {
    res.status(502).json({ error: e && e.message === AI_UNAVAILABLE ? 'AI unavailable' : String((e && e.message) || e) });
  }
};

module.exports.needsTranslation = needsTranslation;
