// POST /api/plants/:id/build-card   body: {details: [{key,label}...], photos: [dataUrl,...]}
//
// The single AI call the "Add a plant" wizard makes after collecting a new
// plant's structured answers (age/sunExposure/watering/groundType — already
// clean dropdown labels, so no normalizeDetailAnswer() pass needed) and up
// to a few photos. Replaces what used to be three separate round trips
// (create -> research -> photo) with one: save the answers, ask the model
// for a care guide informed by them, and — when a photo was given — fold in
// a size/health read in the same call, applied through the existing
// diagnosis pipeline (lib/issue-diagnosis.js) so photo storage and any
// resulting tasks are identical to what a regular photo upload produces.
//
// Falls back to a text-only care guide (same shape as plant-research.js) if
// there's no photo, or if the multimodal call fails for any reason.

const sql = require('../db');
const { plantFromRow, jsonParam } = require('../mappers');
const { careTemplateFor } = require('../care-templates');
const { completeJson, AI_UNAVAILABLE } = require('../ai');
const { applyIssueDiagnosis, savePlantPhotoOnly } = require('../issue-diagnosis');
const { materializeScheduledTasksForYear } = require('../schedule');
const { uid } = require('../dates');
const { DETAIL_LABELS, careJsonSpec, basePrompt } = require('../care-prompt');


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id } = req.query;
  const [row] = await sql`select * from plants where id = ${id}`;
  let plant = plantFromRow(row);
  if (!plant) {
    res.status(404).json({ error: 'Plant not found' });
    return;
  }

  const body = req.body || {};
  const details = Array.isArray(body.details) ? body.details.filter((d) => d && d.key && d.label && DETAIL_LABELS[d.key]) : [];
  const photos = Array.isArray(body.photos) ? body.photos.filter((p) => typeof p === 'string' && /^data:image\//.test(p)).slice(0, 3) : [];

  // Structured answers are already clean dropdown labels — save as
  // {raw, display} straight away (same shape lib/handlers/plant-details.js
  // writes) with no AI normalization pass needed.
  if (details.length) {
    const newDetails = Object.assign({}, plant.plantDetails || {});
    let ageDisplay = null;
    details.forEach((d) => {
      newDetails[d.key] = { raw: d.label, display: d.label };
      if (d.key === 'age') ageDisplay = d.label;
    });
    const [savedRow] = ageDisplay
      ? await sql`update plants set plant_details = ${jsonParam(newDetails)}, age_estimate = ${ageDisplay}, updated_at = now() where id = ${id} returning *`
      : await sql`update plants set plant_details = ${jsonParam(newDetails)}, updated_at = now() where id = ${id} returning *`;
    plant = plantFromRow(savedRow);
  }

  const templateType = careTemplateFor(plant.type);
  // "Not sure" answers are saved (the gardener did answer) but tell the model nothing.
  const prompt = basePrompt(plant, templateType, details.filter((d) => !/^not sure/i.test(d.label)));

  let careResult = null;
  let photoResult = null;
  let photoError = null;

  if (photos.length) {
    try {
      const combined = await completeJson(
        prompt + 'You are also looking at ' + (photos.length > 1 ? photos.length + ' photos' : 'a photo') + ' of this specific plant. ' +
        'Reply with only a JSON object combining a species-level care guide with what you see in the photo(s): ' +
        careJsonSpec().slice(0, -1) + ', "sizeEstimate": short phrase on its current size/maturity, "healthStatus": "healthy" or "needs_attention", ' +
        '"issues": array of short issue strings (empty array if none), "careActions": array of short specific fixes for those issues (empty array if none), ' +
        '"summary": one or two plain sentences summarizing what you see in the photo(s)}.',
        { images: photos, timeoutMs: 120_000 }
      );
      careResult = combined;
      photoResult = combined;
    } catch (e) {
      photoError = e && e.message === AI_UNAVAILABLE ? AI_UNAVAILABLE : String((e && e.message) || e);
    }
  }

  if (!careResult) {
    try {
      careResult = await completeJson(prompt + 'Reply with only a JSON object: ' + careJsonSpec() + '.', { timeoutMs: 120_000 });
    } catch (e) {
      careResult = null;
      if (!photoError) photoError = e && e.message === AI_UNAVAILABLE ? AI_UNAVAILABLE : String((e && e.message) || e);
    }
  }

  // Photos are never lost even when analysis didn't happen — save plainly.
  if (photos.length && !photoResult) {
    for (const dataUrl of photos) {
      const updated = await savePlantPhotoOnly(plant, dataUrl, '');
      plant = updated;
    }
  }

  if (!careResult || !careResult.careProfile) {
    const message = photoError === AI_UNAVAILABLE
      ? "AI features aren't configured yet — set ANTHROPIC_API_KEY."
      : (photoError || 'Agent response was missing careProfile');
    res.status(200).json({ plant, researched: false, error: message });
    return;
  }

  const oldSchedule = plant.yearlySchedule || [];
  const schedule = (careResult.yearlySchedule || [])
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

  const [careRow] = await sql`
    update plants
    set researched = true,
        care_profile = ${jsonParam(careResult.careProfile)},
        yearly_schedule = ${jsonParam(schedule)},
        care_template_type = ${templateType},
        updated_at = now()
    where id = ${id}
    returning *
  `;
  plant = plantFromRow(careRow);

  await materializeScheduledTasksForYear({ id: plant.id, name: plant.name }, schedule, new Date().getFullYear());

  // Photo-derived size/health/issues + task creation, via the same pipeline
  // a regular photo upload uses. The diagnosis is one shared read of
  // photos[0..n] but the pipeline appends/tasks per call, so it only runs
  // once (on the first photo) to avoid creating duplicate care tasks and
  // repeatedly closing/reopening them; any additional photos are appended
  // afterward carrying the same shared analysis, with no further task churn.
  if (photoResult) {
    const out = await applyIssueDiagnosis(plant, photoResult, { photoDataUrl: photos[0], reason: 'new plant photo' });
    plant = out.plant;
    if (photos.length > 1) {
      const extraPhotos = (plant.photos || []).slice();
      photos.slice(1).forEach((dataUrl) => {
        extraPhotos.push({
          dataUrl, date: new Date().toISOString(), summary: photoResult.summary || '',
          healthStatus: photoResult.healthStatus || 'unknown', issues: photoResult.issues || [], userNote: '',
        });
      });
      while (extraPhotos.length > 6) extraPhotos.shift();
      const [extraRow] = await sql`update plants set photos = ${jsonParam(extraPhotos)}, updated_at = now() where id = ${id} returning *`;
      plant = plantFromRow(extraRow);
    }
  }

  res.status(200).json(plant);
};
