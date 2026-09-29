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

function careJsonSpec() {
  return '{"careProfile": {"soil": short phrase on ideal soil/ground, "sun": short phrase on sunlight needs, "watering": short phrase on watering needs, ' +
    '"nutrients": short phrase on fertilizing/feeding needs, "pruning": short phrase on pruning needs and best season (empty string if not applicable to this plant), ' +
    '"frostSensitive": short cold-tolerance note, "commonIssues": short note on common pests/diseases}, ' +
    '"yearlySchedule": array of 3 to 8 objects spread across the year, each {"month": integer 1-12 (1=January, the month the action should happen), ' +
    '"type": one of "prune","fertilize","sow","other", "title": short imperative task title (e.g. "Prune after flowering"), "note": one short plain sentence, ' +
    '"requestsPhoto": true if the best way to do this task is to look at a photo of the plant, false if it\'s a pure action like feeding or pruning with nothing to look at first}}';
}

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

function basePrompt(plant, templateType, knownAnswers) {
  let p = 'You are an expert horticulturist filling in a care template for a home garden plant. Template type: "' + templateType + '" ' +
    '(this changes which fields matter — e.g. a "tree"/"bush" template weighs pruning and structure, a "flower" template weighs sowing/deadheading and bloom season, "other" covers vegetables/herbs/everything else). ' +
    'Plant: ' + (plant.species || plant.name) + ' (common name: "' + plant.name + '", type: ' + plant.type + (plant.spot ? ', planted at ' + plant.spot : '') + '). ';
  if (knownAnswers.length) {
    p += 'The gardener also told you this about their specific plant: ' +
      knownAnswers.map((a) => DETAIL_LABELS[a.key] + ': ' + a.label).join('; ') + '. Take this into account where relevant (e.g. adjust watering/sun advice to match their situation) without just repeating it back. ';
  }
  return p;
}

module.exports = { DETAIL_LABELS, careJsonSpec, knownAnswersFromPlant, basePrompt };
