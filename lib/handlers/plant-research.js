// POST /api/plants/:id/research
//
// Ported from garden-companion.html's researchPlant() — same prompt, same
// month/schedule coercion logic, same "leave it unresearched on failure"
// behavior — with two differences: `sample.json()` (an Artifact platform
// call) is replaced by runAgentJson() (a Vercel Sandbox running the Agent
// SDK, see lib/sandbox-agent.js), and `db.doc(...).update(...)` is replaced
// by a SQL UPDATE. This is the proof-of-concept AI touchpoint: the other
// seven touchpoints in the AI-touchpoints doc follow this same shape.

const sql = require('../db');
const { plantFromRow, jsonParam } = require('../mappers');
const { careTemplateFor } = require('../care-templates');
const { runAgentJson } = require('../sandbox-agent');
const { materializeScheduledTasksForYear } = require('../schedule');
const { uid } = require('../dates');

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
  const prompt =
    'You are an expert horticulturist filling in a care template for a home garden plant. Template type: "' + templateType + '" ' +
    '(this changes which fields matter — e.g. a "tree"/"bush" template weighs pruning and structure, a "flower" template weighs sowing/deadheading and bloom season, "other" covers vegetables/herbs/everything else). ' +
    'Plant: ' + (plant.species || plant.name) + ' (common name: "' + plant.name + '", type: ' + plant.type + (plant.spot ? ', planted at ' + plant.spot : '') + '). ' +
    'Base this on well-established horticultural knowledge for this species. Reply with only a JSON object: ' +
    '{"careProfile": {"soil": short phrase on ideal soil/ground, "sun": short phrase on sunlight needs, "watering": short phrase on watering needs, ' +
    '"nutrients": short phrase on fertilizing/feeding needs, "pruning": short phrase on pruning needs and best season (empty string if not applicable to this plant), ' +
    '"frostSensitive": short cold-tolerance note, "commonIssues": short note on common pests/diseases}, ' +
    '"yearlySchedule": array of 3 to 8 objects spread across the year, each {"month": integer 1-12 (1=January, the month the action should happen), ' +
    '"type": one of "prune","fertilize","sow","other", "title": short imperative task title (e.g. "Prune after flowering"), "note": one short plain sentence, ' +
    '"requestsPhoto": true if the best way to do this task is to look at a photo of the plant (e.g. checking pest damage, leaf color, or size), false if it\'s a pure action like feeding or pruning with nothing to look at first}}.';

  let result;
  try {
    result = await runAgentJson(prompt, { timeoutMs: 120_000 });
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

  await materializeScheduledTasksForYear({ id: plant.id, name: plant.name }, schedule, new Date().getFullYear());

  res.status(200).json(plantFromRow(updated));
};
