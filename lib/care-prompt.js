// The care-guide prompt shared by the "Add a plant" wizard's build-card call
// (lib/handlers/plant-build-card.js) and the plant page's "Build care guide"
// / "Update research" call (lib/handlers/plant-research.js), so both give the
// model the same picture of the plant — including what the gardener has told
// us about its spot (sun, watering, ground, age).

const DETAIL_LABELS = {
  age: 'about how old it is',
  sunExposure: 'the sun exposure at its spot',
  watering: 'how it\'s watered',
  groundType: 'the ground/soil at its spot',
};

// JSON Schemas for the care-guide reply (structured outputs: the reply is
// guaranteed to match). Descriptions double as the field instructions.
const str = (description) => ({ type: 'string', description });
const CARE_PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['soil', 'sun', 'watering', 'nutrients', 'pruning', 'frostSensitive', 'commonIssues'],
  properties: {
    soil: str('Short phrase: ideal soil/ground for this plant, and what to do about the gardener\'s actual ground if known.'),
    sun: str('Short phrase: sunlight needs, and whether its actual spot suits it.'),
    watering: str('Short phrase: watering for this plant in this climate — how it changes between the local hot/dry and cool/rainy seasons, with the gardener\'s watering method in mind.'),
    nutrients: str('Short phrase: fertilizing/feeding needs and when, in local months.'),
    pruning: str('Short phrase: pruning needs and the best time locally (empty string if not applicable).'),
    frostSensitive: str('Short cold-tolerance note that is relevant to THIS location: if frost or damaging cold does not occur here, say so instead of giving frost-protection advice.'),
    commonIssues: str('Short note on the pests/diseases this plant commonly gets in this region and when.'),
  },
};
const SCHEDULE_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['month', 'type', 'title', 'note', 'requestsPhoto'],
  properties: {
    month: { type: 'integer', description: 'Month 1-12 (1 = January) in which to do it at THIS location.' },
    type: { type: 'string', enum: ['prune', 'fertilize', 'water', 'sow', 'harvest', 'pest-check', 'other'] },
    title: str('Short imperative task title, specific to this plant (e.g. "Feed the lemon with citrus fertilizer").'),
    note: str('One or two plain sentences: what exactly to do and why it matters this month here.'),
    requestsPhoto: { type: 'boolean', description: 'True if the best way to do this task is to look at a photo of the plant (checking leaves, pests, size); false for a pure action like feeding or pruning.' },
  },
};
const CARE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['careProfile', 'yearlySchedule'],
  properties: {
    careProfile: CARE_PROFILE_SCHEMA,
    yearlySchedule: { type: 'array', items: SCHEDULE_ENTRY_SCHEMA },
  },
};
// Build-card with photos: the guide plus what the photo(s) show.
const CARE_WITH_PHOTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['careProfile', 'yearlySchedule', 'sizeEstimate', 'healthStatus', 'issues', 'careActions', 'summary'],
  properties: {
    careProfile: CARE_PROFILE_SCHEMA,
    yearlySchedule: { type: 'array', items: SCHEDULE_ENTRY_SCHEMA },
    sizeEstimate: str('Short phrase on its current size/maturity.'),
    healthStatus: { type: 'string', enum: ['healthy', 'needs_attention'] },
    issues: { type: 'array', items: { type: 'string' }, description: 'Short issue strings (empty if none).' },
    careActions: { type: 'array', items: { type: 'string' }, description: 'Short specific fixes for those issues (empty if none).' },
    summary: str('One or two plain sentences summarizing what you see in the photo(s).'),
  },
};

const SCHEDULE_INSTRUCTIONS =
  'For yearlySchedule, give 6 to 12 entries that together cover the whole year: everything this particular plant actually needs in this garden ' +
  '(seasonal watering changes, feeding, pruning, pest and disease checks, mulching, harvest, and so on), each in the month it should really happen at this location. ' +
  'Skip anything that does not apply here (for example no frost protection where it does not freeze). ';

// [{key, label}] from a plant's saved plantDetails, skipping "Not sure"
// answers (they tell the model nothing).
function knownAnswersFromPlant(plant) {
  const details = (plant && plant.plantDetails) || {};
  return Object.keys(DETAIL_LABELS).map((key) => {
    const v = details[key];
    const label = v && (typeof v === 'string' ? v : (v.display || v.raw));
    if (!label || /^not sure/i.test(label)) return null;
    return { key, label };
  }).filter(Boolean);
}

// gardenText: lib/garden-context.js's location + measured-climate text.
function basePrompt(plant, templateType, knownAnswers, gardenText) {
  let p = 'You are an expert horticulturist writing a care guide for one specific plant in a real home garden. ' +
    (gardenText ? gardenText + '\n\n' : '') +
    'Template type: "' + templateType + '" ' +
    '(this changes which fields matter — e.g. a "tree"/"bush" template weighs pruning and structure, a "flower" template weighs sowing/deadheading and bloom season, "other" covers vegetables/herbs/everything else). ' +
    'Plant: ' + (plant.species || plant.name) + ' (common name: "' + plant.name + '", type: ' + plant.type + (plant.spot ? ', planted at ' + plant.spot : '') + '). ';
  if (plant.notes) p += 'Gardener\'s notes: ' + plant.notes + '. ';
  if (knownAnswers.length) {
    p += 'The gardener also told you this about their specific plant: ' +
      knownAnswers.map((a) => DETAIL_LABELS[a.key] + ': ' + a.label).join('; ') + '. Take this into account (e.g. adjust watering/sun advice to match their situation) without just repeating it back. ';
  }
  p += 'Write the guide for this plant, in this spot, in this climate — not a generic species sheet. ' + SCHEDULE_INSTRUCTIONS;
  return p;
}

module.exports = { DETAIL_LABELS, CARE_SCHEMA, CARE_WITH_PHOTO_SCHEMA, knownAnswersFromPlant, basePrompt };
