// Ported from garden-companion.html's analyzeAndApplyPlantPhoto(). Shared by
// api/plants/[id]/photo.js (Overview tab / onboarding photo step) and
// api/tasks/[id]/photo.js (a photo attached to a task that has a plant), so
// both behave identically.
//
// Always keeps the photo: if analysis is unavailable (no ANTHROPIC_API_KEY)
// or fails for any other reason, the photo is still saved onto the plant
// without analysis (savePlantPhotoOnly) — an upload is never lost.
//
// Returns {plant, result} on success, or
//         {plant, result: PHOTO_ONLY_RESULT, __photoOnly: true, error?}
// when only the photo could be saved (`error` set when analysis actually
// failed, as opposed to simply not being configured).

const { analyzeImageJson, IMAGE_ANALYSIS_UNAVAILABLE } = require('./vision');
const { applyIssueDiagnosis, savePlantPhotoOnly } = require('./issue-diagnosis');

function photoOnlyResult() {
  return { summary: '', healthStatus: 'unknown', issues: [], careActions: [], sizeEstimate: '', __photoOnly: true };
}

function plantPhotoPrompt(plant, userNote) {
  return 'You are an expert home gardening consultant looking at a photo of the user\'s ' + (plant.species || plant.name) +
    ' (' + plant.type + (plant.spot ? ', planted at ' + plant.spot : '') + ').' +
    (userNote ? ' The user also told you this about it: "' + userNote + '".' : '') +
    ' Reply with only a JSON object: ' +
    '{"sizeEstimate": short phrase on its current size/maturity, "healthStatus": "healthy" or "needs_attention", ' +
    '"issues": array of short issue strings (empty array if none), "careActions": array of short specific fixes for those issues (empty array if none), ' +
    '"summary": one or two plain sentences summarizing what you see}.';
}

async function analyzeAndApplyPlantPhoto(plant, dataUrl, userNote) {
  let result;
  try {
    result = await analyzeImageJson(plantPhotoPrompt(plant, userNote), dataUrl);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('image analysis returned an unexpected shape');
    }
  } catch (e) {
    const updated = await savePlantPhotoOnly(plant, dataUrl, userNote);
    const out = { plant: updated, result: photoOnlyResult(), __photoOnly: true };
    if (!(e && e.message === IMAGE_ANALYSIS_UNAVAILABLE)) out.error = String((e && e.message) || e);
    return out;
  }
  return applyIssueDiagnosis(plant, result, { photoDataUrl: dataUrl, userNote, reason: 'photo diagnosis' });
}

module.exports = { analyzeAndApplyPlantPhoto, photoOnlyResult };
