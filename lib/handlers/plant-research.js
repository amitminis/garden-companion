// POST /api/plants/:id/research
//
// Ported from garden-companion.html's researchPlant() — same prompt, same
// month/schedule coercion logic, same "leave it unresearched on failure"
// behavior — with two differences: `sample.json()` (an Artifact platform
// call) is replaced by completeJson() (a direct Anthropic Messages API
// call, see lib/ai.js), and `db.doc(...).update(...)` is replaced by a SQL
// UPDATE.

const sql = require('../db');
const { plantFromRow, jsonParam } = require('../mappers');
const { careTemplateFor } = require('../care-templates');
const { completeJson } = require('../ai');
const { materializeScheduledTasks } = require('../schedule');
const { uid } = require('../dates');
const { CARE_SCHEMA, knownAnswersFromPlant, basePrompt } = require('../care-prompt');
const { getGardenContext } = require('../garden-context');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id } = req.query;
  const [row] = await sql`select * from plants where id = ${id}`;
  const plant = plantFromRow(row);
  if (!plant) {
    res.status(404).json({ error: 'Plant not found' });
    return;
  }

  const templateType = careTemplateFor(plant.type);
  // Same prompt as the wizard's build-card call: the plant, the details the
  // gardener has saved about its spot, and the garden's location + climate.
  const garden = await getGardenContext();
  const prompt = basePrompt(plant, templateType, knownAnswersFromPlant(plant), garden.text) +
    'Base this on well-established horticultural knowledge for this species, applied to this location.\n' + garden.languageLine;

  let result;
  try {
    result = await completeJson(prompt, { timeoutMs: 120_000, effort: 'medium', schema: CARE_SCHEMA });
  } catch (e) {
    // Same fallback as the original: leave the plant unresearched rather
    // than fail the request — the plant page just shows "getting to know
    // it" until a retry succeeds.
    res.status(200).json({ researched: false, error: String(e.message || e) });
    return;
  }

  if (!result || !result.careProfile) {
    res.status(200).json({ researched: false, error: 'Agent response was missing careProfile' });
    return;
  }

  const oldSchedule = plant.yearlySchedule || [];
  const schedule = (result.yearlySchedule || [])
    .map((e, i) => {
      const month = parseInt(e.month, 10);
      if (!(month >= 1 && month <= 12)) return null;
      const entry = {
        id: templateType + '-' + i + '-' + uid(),
        month,
        type: e.type || 'other',
        title: e.title || '',
        note: e.note || '',
        requestsPhoto: !!e.requestsPhoto,
        lastDone: null,
      };
      const match = oldSchedule.find((oe) => oe.type === entry.type && Number(oe.month) === entry.month && oe.lastDone);
      if (match) entry.lastDone = match.lastDone;
      return entry;
    })
    .filter((e) => e !== null);

  // Note on JSONB params: @neondatabase/serverless JSON.stringifies plain
  // objects, but encodes JS ARRAYS as Postgres array literals ('{...}'),
  // which a jsonb column rejects — so both go through jsonParam() (see
  // lib/mappers.js).
  const [updated] = await sql`
    update plants
    set researched = true,
        care_profile = ${jsonParam(result.careProfile)},
        yearly_schedule = ${jsonParam(schedule)},
        care_template_type = ${templateType},
        updated_at = now()
    where id = ${id}
    returning *
  `;

  await materializeScheduledTasks({ id: plant.id, name: plant.name }, schedule, { replace: true });

  res.status(200).json(plantFromRow(updated));
};
