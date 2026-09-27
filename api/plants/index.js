// GET  /api/plants        -> list all plants (newest-created first is NOT
//                             the order used — matches the Artifact's
//                             orderBy("createdAt","asc") so plants appear
//                             in the order they were added, oldest first)
// POST /api/plants        -> create a plant (mirrors onboarding's
//                             db.collection("plants").add({...}) call)

const sql = require('../../lib/db');
const { plantFromRow } = require('../../lib/mappers');
const { careTemplateFor } = require('../../lib/care-templates');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`select * from plants order by created_at asc limit 200`;
    res.status(200).json(rows.map(plantFromRow));
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const type = body.type || 'other';
    const [row] = await sql`
      insert into plants (name, species, type, spot, notes, care_template_type)
      values (${body.name}, ${body.species || ''}, ${type}, ${body.spot || ''}, ${body.notes || ''}, ${careTemplateFor(type)})
      returning *
    `;
    res.status(201).json(plantFromRow(row));
    return;
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ error: 'Method not allowed' });
};
