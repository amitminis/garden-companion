// Ported from garden-companion.html's applyIssueDiagnosis() (and its
// savePlantPhotoOnly() fallback). Shared diagnosis handling: structured
// issues -> status patch + follow-up tasks. This is where the plant's own
// STATUS is gathered — this specific specimen's size, health and any active
// issue. Never touches careProfile/yearlySchedule (that's species-level
// research, see api/plants/[id]/research.js). Used by both the photo path
// (lib/plant-photo.js) and the "report a problem" path
// (api/plants/[id]/issue.js) — the two share everything downstream of
// getting a {issues, careActions, summary, healthStatus} result, they just
// get there differently.
//
// Only change from the original: storage calls (db.doc/db.collection) are
// SQL, and "currently open tasks" are read from the tasks table directly
// instead of the client's in-memory state.tasks.

const sql = require('./db');
const { plantFromRow, jsonParam } = require('./mappers');
const { todayISO } = require('./dates');

async function applyIssueDiagnosis(plant, result, opts) {
  opts = opts || {};
  const reason = opts.reason || 'photo diagnosis';
  const nowIso = new Date().toISOString();

  // Built as a camelCase patch exactly like the original, then written below.
  const patch = {};
  if (result.sizeEstimate) patch.sizeInfo = result.sizeEstimate;
  if (opts.photoDataUrl) {
    const photos = (plant.photos || []).slice();
    photos.push({
      dataUrl: opts.photoDataUrl,
      date: nowIso,
      summary: result.summary || '',
      healthStatus: result.healthStatus || 'unknown',
      issues: result.issues || [],
      userNote: opts.userNote || '',
    });
    while (photos.length > 6) photos.shift();
    patch.photos = photos;
  }

  const wasIssue = !!(plant.activeIssue && plant.activeIssue.description);
  const needsAttention = result.healthStatus === 'needs_attention' && result.issues && result.issues.length;

  if (needsAttention) {
    patch.healthStatus = 'needs_attention';
    patch.activeIssue = { description: result.issues.join('; '), since: todayISO() };

    // Each plant handles one issue at a time: close out EVERY still-open
    // issue-kind task for this plant (both the care task and its follow-up
    // tracking task from any prior diagnosis), not just the tracking task —
    // otherwise an older "Care for X" task could stay open alongside a
    // brand-new one, splitting attention across two supposedly-separate
    // issues on the same plant.
    const priorOpen = await sql`
      select id, comments from tasks
      where plant_id = ${plant.id} and kind = 'issue' and status <> 'done'
    `;
    for (const t of priorOpen) {
      const comments = (t.comments || []).concat([{ text: 'Superseded by a newer check-in.', date: new Date().toISOString() }]);
      await sql`
        update tasks set status = 'done', completed_at = now(), comments = ${jsonParam(comments)}
        where id = ${t.id}
      `;
    }

    // All care actions for this diagnosis are aggregated into ONE task
    // (rather than one task per action) so a single issue doesn't fragment
    // "This week" into several near-duplicate entries — the follow-up
    // check-in below stays a separate task, since that's a distinct thing
    // to do on a different date.
    const actions = (result.careActions && result.careActions.length) ? result.careActions : ['Check on ' + plant.name];
    const thisYear = new Date().getFullYear();
    const careTitle = actions.length === 1
      ? (actions[0].length > 60 ? actions[0].slice(0, 57) + '…' : actions[0])
      : ('Care for ' + plant.name + ' — ' + actions.length + ' steps');
    const careDescription = (result.summary ? result.summary + '\n\n' : '') + actions.map((a) => '• ' + a).join('\n');
    await sql`
      insert into tasks
        (title, description, plant_id, plant_name, due_date, status, comments, reason, severity, kind, year, requests_photo)
      values
        (${careTitle}, ${careDescription}, ${plant.id}, ${plant.name}, ${todayISO()}, 'pending', '[]'::jsonb,
         ${reason}, 'warning', 'issue', ${thisYear}, false)
    `;

    const trackDate = new Date();
    trackDate.setDate(trackDate.getDate() + 5);
    await sql`
      insert into tasks
        (title, description, plant_id, plant_name, due_date, status, comments, reason, severity, tracking_for, kind, year, requests_photo)
      values
        (${'Check on ' + plant.name + ' — is it recovering?'}, ${'Follow-up on: ' + result.issues.join('; ')},
         ${plant.id}, ${plant.name}, ${trackDate.toISOString().slice(0, 10)}, 'pending', '[]'::jsonb,
         'health tracking', 'info', ${plant.id}, 'issue', ${trackDate.getFullYear()}, true)
    `;
  } else {
    patch.healthStatus = 'healthy';
    patch.activeIssue = null;
    if (wasIssue) {
      const openTracking = await sql`
        select id, comments from tasks
        where tracking_for = ${plant.id} and status <> 'done'
      `;
      for (const t of openTracking) {
        const comments = (t.comments || []).concat([{ text: 'Resolved — latest photo looks healthy.', date: new Date().toISOString() }]);
        await sql`
          update tasks set status = 'done', completed_at = now(), comments = ${jsonParam(comments)}
          where id = ${t.id}
        `;
      }
    }
  }

  const updated = await updatePlantPatch(plant.id, patch);
  return { plant: updated, result };
}

// Fallback for when photo ANALYSIS can't run at all (no ANTHROPIC_API_KEY,
// or the analysis call failed) — save the photo itself rather than losing
// what the user just uploaded. No AI-derived size/health/issues, so it's
// added with an "unknown" status; the user can still describe what they see
// via "Report a problem" (text) to get real diagnosis + tasks.
async function savePlantPhotoOnly(plant, dataUrl, userNote) {
  const photos = (plant.photos || []).slice();
  photos.push({ dataUrl, date: new Date().toISOString(), summary: '', healthStatus: 'unknown', issues: [], userNote: userNote || '' });
  while (photos.length > 6) photos.shift();
  return updatePlantPatch(plant.id, { photos });
}

const PATCH_COLUMNS = {
  sizeInfo: 'size_info',
  photos: 'photos',
  healthStatus: 'health_status',
  activeIssue: 'active_issue',
};

async function updatePlantPatch(plantId, patch) {
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    const column = PATCH_COLUMNS[key];
    if (!column) continue;
    setClauses.push(`${column} = $${i}`);
    values.push(jsonParam(value));
    i++;
  }
  setClauses.push('updated_at = now()');
  values.push(plantId);
  const rows = await sql.query(`update plants set ${setClauses.join(', ')} where id = $${i} returning *`, values);
  return plantFromRow(rows[0]);
}

module.exports = { applyIssueDiagnosis, savePlantPhotoOnly };
