// POST /api/migrate — one-time (idempotent) schema setup.
//
// The first production deployment shipped without ever running schema.sql
// against the Neon database, so every query failed with
// `relation "plants" does not exist` etc. This endpoint applies schema.sql
// itself, from inside a Vercel Function (which already knows how to reach
// Neon), rather than needing a direct psql/network path from outside.
//
// Safe to call more than once: every statement in schema.sql is
// `create table/index if not exists`, so re-running it is a no-op once the
// schema is in place. No auth here, consistent with the rest of this API
// (see README's "Known gaps" — nothing is authenticated yet); it only ever
// creates structure, never touches data.

const sql = require('../lib/db');
const fs = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const schemaText = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    const statements = schemaText
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    const ran = [];
    for (const stmt of statements) {
      await sql.query(stmt);
      ran.push(stmt.split('\n')[0].slice(0, 60));
    }
    res.status(200).json({ ok: true, statementsRun: ran.length, statements: ran });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
