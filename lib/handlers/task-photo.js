// POST /api/tasks/:id/photo   body: {dataUrl, note, allowComplete?}
//
// Ported from the photo-save branch of garden-companion.html's
// taskDetailBody() Save handler. Attaches a photo (and optional note) to a
// task:
//   - If the task has a plant: runs the SAME photo-analysis pipeline as
//     POST /api/plants/:id/photo (lib/plant-photo.js — photo saved onto the
//     plant, diagnosis applied), and a "weekly checkin" task is marked done.
//     `allowComplete:false` (sent by the Yearly Plan's read-only task view)
//     skips that auto-complete, same as the original.
//   - Otherwise: freeform feedback on the photo via lib/ai.js
//     (silently skipped if image analysis isn't available).
// Either way the note is appended to comments and task.photo is set to
// {dataUrl, date, analysis}. Returns the updated task.

const sql = require('../db');
const { taskFromRow, plantFromRow, jsonParam } = require('../mappers');
const { analyzeAndApplyPlantPhoto } = require('../plant-photo');
const { complete } = require('../ai');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id } = req.query;
  const body = req.body || {};
  if (!body.dataUrl || !/^data:image\//.test(String(body.dataUrl))) {
    res.status(400).json({ error: 'dataUrl (a data:image/... URL) is required' });
    return;
  }
  const dataUrl = String(body.dataUrl);
  const note = String(body.note || '').trim();
  const allowComplete = body.allowComplete !== false;

  const [taskRow] = await sql`select * from tasks where id = ${id}`;
  const t = taskFromRow(taskRow);
  if (!t) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  let summaryText = '';
  let markDone = false;

  const plantRow = t.plantId ? (await sql`select * from plants where id = ${t.plantId}`)[0] : null;
  const plant = plantFromRow(plantRow);
  if (plant) {
    try {
      const out = await analyzeAndApplyPlantPhoto(plant, dataUrl, note);
      summaryText = out.error ? "Couldn't analyze that photo — it's saved, but try again for a diagnosis." : ((out.result && out.result.summary) || '');
    } catch (e) {
      summaryText = "Couldn't analyze that photo — try again.";
    }
    if (allowComplete && t.reason === 'weekly checkin') markDone = true;
  } else {
    try {
      summaryText = await complete(
        'You are the user\'s home gardening expert. They attached this photo as a note on the task "' + t.title + '". Give brief, specific feedback: does it look addressed, and what to do next, in 2-3 sentences.',
        { images: dataUrl }
      );
    } catch (e) { /* unavailable or failed — attach the photo without feedback */ }
  }

  // Re-read comments: the diagnosis above may have just closed this very
  // task (e.g. a follow-up tracking task) and appended a comment to it.
  const [freshTask] = await sql`select comments from tasks where id = ${id}`;
  const comments = ((freshTask && freshTask.comments) || t.comments || []).slice();
  if (note) comments.push({ text: note, date: new Date().toISOString() });
  const photo = { dataUrl, date: new Date().toISOString(), analysis: summaryText || '' };

  let updated;
  if (markDone) {
    [updated] = await sql`
      update tasks set comments = ${jsonParam(comments)}, photo = ${jsonParam(photo)}, status = 'done', completed_at = now()
      where id = ${id} returning *
    `;
  } else {
    [updated] = await sql`
      update tasks set comments = ${jsonParam(comments)}, photo = ${jsonParam(photo)}
      where id = ${id} returning *
    `;
  }
  res.status(200).json(taskFromRow(updated));
};
