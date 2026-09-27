// GET   /api/tasks/:id -> single task
// PATCH /api/tasks/:id -> partial update (status, comments, photo, ...).
//   Ported side-effect from garden-companion.html: marking a "scheduled"
//   task done also stamps `lastDone` on the matching entry in its plant's
//   yearly_schedule, so the care-guide view reflects it without a
//   separate call.

const sql = require('../db');
const { taskFromRow, TASK_FIELD_MAP, jsonParam } = require('../mappers');

module.exports = async function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'GET') {
    const [row] = await sql`select * from tasks where id = ${id}`;
    if (!row) { res.status(404).json({ error: 'Task not found' }); return; }
    res.status(200).json(taskFromRow(row));
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};

    // Mirrors the original's implicit rule: setting status:"done" without
    // an explicit completedAt stamps now(); moving back to "pending" clears it.
    if (body.status && !('completedAt' in body)) {
      body.completedAt = body.status === 'done' ? new Date().toISOString() : null;
    }

    const setClauses = [];
    const values = [];
    let i = 1;
    for (const [camelKey, value] of Object.entries(body)) {
      const column = TASK_FIELD_MAP[camelKey];
      if (!column) continue;
      setClauses.push(`${column} = $${i}`);
      values.push(jsonParam(value)); // arrays (comments) must be JSON text for jsonb
      i++;
    }
    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No recognized fields in patch body' });
      return;
    }
    values.push(id);
    const text = `update tasks set ${setClauses.join(', ')} where id = $${i} returning *`;
    const rows = await sql.query(text, values);
    const updated = rows[0];
    if (!updated) { res.status(404).json({ error: 'Task not found' }); return; }

    // Ported from the original's doneBtn handler: a "scheduled" task
    // completing stamps lastDone on its matching yearly_schedule entry.
    if (body.status === 'done' && updated.plant_id && updated.schedule_entry_id) {
      try {
        const [plant] = await sql`select yearly_schedule from plants where id = ${updated.plant_id}`;
        if (plant) {
          const sched = (plant.yearly_schedule || []).map((x) =>
            x.id === updated.schedule_entry_id ? Object.assign({}, x, { lastDone: new Date().toISOString() }) : x
          );
          await sql`update plants set yearly_schedule = ${jsonParam(sched)} where id = ${updated.plant_id}`;
        }
      } catch (e) { /* best-effort, same as the original's try/catch */ }
    }

    res.status(200).json(taskFromRow(updated));
    return;
  }

  res.setHeader('Allow', 'GET, PATCH');
  res.status(405).json({ error: 'Method not allowed' });
};
