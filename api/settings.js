// GET   /api/settings -> the single settings row (creates the default row
//                          on first read if none exists yet — mirrors
//                          onboarding's settingsDoc.set({...}) happening
//                          implicitly rather than requiring a separate
//                          "init" call)
// PATCH /api/settings -> partial update (location, photoCheckinDay, ...)

const sql = require('../lib/db');
const { settingsFromRow, SETTINGS_FIELD_MAP, jsonParam } = require('../lib/mappers');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    let [row] = await sql`select * from settings where id = true`;
    if (!row) {
      [row] = await sql`insert into settings (id) values (true) returning *`;
    }
    res.status(200).json(settingsFromRow(row));
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    // Single pass over the recognized fields, building the column list,
    // placeholder list, and values array together so the three stay in
    // lockstep (rather than three separate derivations that could drift).
    const columns = [];
    const placeholders = [];
    const setClauses = [];
    const values = [];
    let i = 1;
    for (const [camelKey, value] of Object.entries(body)) {
      const column = SETTINGS_FIELD_MAP[camelKey];
      if (!column) continue;
      columns.push(column);
      placeholders.push(`$${i}`);
      setClauses.push(`${column} = $${i}`);
      values.push(jsonParam(value));
      i++;
    }
    if (columns.length === 0) {
      res.status(400).json({ error: 'No recognized fields in patch body' });
      return;
    }
    // Upsert: the settings row may not exist yet if this is called before
    // any GET has created it.
    const text = `
      insert into settings (id, ${columns.join(', ')})
      values (true, ${placeholders.join(', ')})
      on conflict (id) do update set ${setClauses.join(', ')}
      returning *
    `;
    const rows = await sql.query(text, values);
    res.status(200).json(settingsFromRow(rows[0]));
    return;
  }

  res.setHeader('Allow', 'GET, PATCH');
  res.status(405).json({ error: 'Method not allowed' });
};
