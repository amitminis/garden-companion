// GET  /api/tasks -> list tasks, newest-due first (mirrors the Artifact's
//                     db.collection("tasks").orderBy("dueDate","desc"))
// POST /api/tasks -> create a task (used for one-off tasks; the bulk of
//                     task creation happens server-side via
//                     lib/schedule.js and applyIssueDiagnosis-equivalent
//                     logic in the AI-touchpoint endpoints, not through
//                     this route)

const sql = require('../../lib/db');
const { taskFromRow } = require('../../lib/mappers');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`select * from tasks order by due_date desc limit 200`;
    res.status(200).json(rows.map(taskFromRow));
    return;
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    if (!b.title || !b.dueDate || !b.kind) {
      res.status(400).json({ error: 'title, dueDate, and kind are required' });
      return;
    }
    const year = b.year || new Date(b.dueDate).getFullYear();
    const [row] = await sql`
      insert into tasks
        (plant_id, plant_name, title, description, due_date, status, kind, reason, severity, year, requests_photo, tracking_for)
      values
        (${b.plantId || null}, ${b.plantName || ''}, ${b.title}, ${b.description || ''}, ${b.dueDate},
         ${b.status || 'pending'}, ${b.kind}, ${b.reason || ''}, ${b.severity || 'info'}, ${year},
         ${!!b.requestsPhoto}, ${b.trackingFor || null})
      returning *
    `;
    res.status(201).json(taskFromRow(row));
    return;
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ error: 'Method not allowed' });
};
