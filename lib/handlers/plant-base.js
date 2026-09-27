// GET    /api/plants/:id  -> single plant
// PATCH  /api/plants/:id  -> partial update (mirrors db.doc("plants/"+id).update(patch))
// DELETE /api/plants/:id  -> remove a plant (and its tasks, via ON DELETE CASCADE)

const sql = require('../db');
const { plantFromRow, PLANT_FIELD_MAP, jsonParam } = require('../mappers');

module.exports = async function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'GET') {
    const [row] = await sql`select * from plants where id = ${id}`;
    if (!row) { res.status(404).json({ error: 'Plant not found' }); return; }
    res.status(200).json(plantFromRow(row));
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const setClauses = [];
    const values = [];
    let i = 1;
    for (const [camelKey, value] of Object.entries(body)) {
      const column = PLANT_FIELD_MAP[camelKey];
      if (!column) continue; // silently drop unknown fields rather than erroring
      setClauses.push(`${column} = $${i}`);
      // Objects/arrays destined for jsonb columns go through jsonParam():
      // the Neon driver JSON.stringifies plain objects but encodes ARRAYS
      // as Postgres array literals, which jsonb rejects (see lib/mappers.js).
      values.push(jsonParam(value));
      i++;
    }
    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No recognized fields in patch body' });
      return;
    }
    setClauses.push('updated_at = now()');
    values.push(id);
    const text = `update plants set ${setClauses.join(', ')} where id = $${i} returning *`;
    // sql.query() (unlike sql.query with {fullResults:true}) resolves
    // directly to the rows array, not a {rows: [...]} wrapper.
    const rows = await sql.query(text, values);
    if (!rows[0]) { res.status(404).json({ error: 'Plant not found' }); return; }
    res.status(200).json(plantFromRow(rows[0]));
    return;
  }

  if (req.method === 'DELETE') {
    const rows = await sql.query('delete from plants where id = $1 returning id', [id]);
    if (!rows[0]) { res.status(404).json({ error: 'Plant not found' }); return; }
    res.status(204).end();
    return;
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE');
  res.status(405).json({ error: 'Method not allowed' });
};
