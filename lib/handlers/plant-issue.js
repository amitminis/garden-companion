// POST /api/plants/:id/issue   body: {description, dataUrl?}
//
// Ported from garden-companion.html's reportPlantIssue() — the "Report a
// problem" button. The user describes what they're seeing and/or attaches a
// photo (at least one is required). Same diagnosis->task pipeline as a
// photo check-in (lib/issue-diagnosis.js). The photo is always kept on the
// plant record, even when it can't be analyzed — only whether it's sent to
// the model depends on image support (ANTHROPIC_API_KEY being set).
//
// Goes through lib/ai.js's completeJson() either way — a photo, when
// usable, is just passed along as an image content block on the same call.
//
// Responses (HTTP 200 once the plant exists):
//   {plant, result}                       diagnosis applied, tasks created
//   {plant, result:{..., __photoOnly}}     photo-only, nothing to diagnose from
//   {error, plant?, photoSaved?}          diagnosis failed (photo still saved if given)

const sql = require('../db');
const { plantFromRow } = require('../mappers');
const { completeJson } = require('../ai');
const { applyIssueDiagnosis, savePlantPhotoOnly } = require('../issue-diagnosis');

const PHOTO_ONLY_SUMMARY = "Photo saved, but I can't analyze images in this view right now — no tasks were created. Try describing the problem in words instead.";

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id } = req.query;
  const body = req.body || {};
  const description = String(body.description || '');
  const photoDataUrl = body.dataUrl && /^data:image\//.test(String(body.dataUrl)) ? String(body.dataUrl) : null;
  const hasText = !!description.trim();

  if (!hasText && !photoDataUrl) {
    res.status(400).json({ error: 'Describe the problem and/or attach a photo' });
    return;
  }

  const [row] = await sql`select * from plants where id = ${id}`;
  const plant = plantFromRow(row);
  if (!plant) {
    res.status(404).json({ error: 'Plant not found' });
    return;
  }

  const canUseImage = !!(photoDataUrl && process.env.ANTHROPIC_API_KEY);

  try {
    if (!hasText && photoDataUrl && !canUseImage) {
      // Nothing to diagnose from (no text, and the photo can't be analyzed
      // here) — still save the photo rather than silently dropping it.
      const updated = await savePlantPhotoOnly(plant, photoDataUrl, '');
      res.status(200).json({
        plant: updated,
        result: { summary: PHOTO_ONLY_SUMMARY, issues: [], careActions: [], healthStatus: 'healthy', __photoOnly: true },
        __photoOnly: true,
      });
      return;
    }

    const prompt =
      'You are an expert home gardening consultant. The user is reporting a problem with their ' + (plant.species || plant.name) +
      ' (' + plant.type + (plant.spot ? ', planted at ' + plant.spot : '') + ').' +
      (hasText ? ' They described: "' + description.trim() + '".' : '') +
      (canUseImage ? ' They also attached a photo — use it as the primary evidence' + (hasText ? ', alongside their description' : '') + '.' : '') +
      ' Reply with only a JSON object: {"sizeEstimate": short phrase on its current size/maturity' + (canUseImage ? '' : " (empty string if you can't tell from text alone)") + ', ' +
      '"healthStatus": "needs_attention", ' +
      '"issues": array of short issue strings distilled from what you ' + (canUseImage ? 'see and/or ' : '') + 'were told, ' +
      '"careActions": array of short specific fixes, ' +
      '"summary": one or two plain sentences confirming what\'s wrong and what to do}.';

    let result;
    try {
      result = await completeJson(prompt, { images: canUseImage ? photoDataUrl : undefined, timeoutMs: 90_000 });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('diagnosis returned an unexpected shape');
    } catch (e) {
      // Never lose an upload: keep the photo even though diagnosis failed.
      let updated = null;
      if (photoDataUrl) updated = await savePlantPhotoOnly(plant, photoDataUrl, hasText ? description.trim() : '');
      res.status(200).json({ error: String((e && e.message) || e), plant: updated || plant, photoSaved: !!photoDataUrl });
      return;
    }

    if (!result.issues || !result.issues.length) result.issues = [hasText ? description.trim() : 'Issue reported with photo'];
    result.healthStatus = 'needs_attention';
    const out = await applyIssueDiagnosis(plant, result, {
      reason: 'reported issue',
      photoDataUrl: photoDataUrl || null,
      userNote: hasText ? description.trim() : '',
    });
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ error: String((e && e.message) || e) });
  }
};
