// POST /api/ask   body: {turns: [{role:'user'|'assistant', content}, ...]}
// GET  /api/tips  -> lib/handlers/garden-tips.js (via a vercel.json rewrite)
//
// Ported from garden-companion.html's Ask panel (sendAsk + gardenContext).
// The garden-context message is built here from the DB — never trusted from
// the client — and passed as the system prompt to lib/ai.js's chat(), with
// the conversation passed as real user/assistant turns rather than
// flattened into one string.
//
// Always 200: on failure returns the original's fallback text.

const sql = require('../lib/db');
const { chat } = require('../lib/ai');
const { getGardenContext } = require('../lib/garden-context');
const gardenTips = require('../lib/handlers/garden-tips');

const FALLBACK = "Sorry, I couldn't answer that just now.";

module.exports = async function handler(req, res) {
  // GET /api/tips is rewritten here (vercel.json) — garden tips are the
  // other "ask the gardener" AI surface; sharing this Function keeps the
  // deployment under the Hobby plan's Function cap.
  if (req.query && req.query.mode === 'tips') return gardenTips(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const turns = Array.isArray(req.body && req.body.turns) ? req.body.turns : [];
  const cleanTurns = turns
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .slice(-40);
  if (!cleanTurns.length || cleanTurns[cleanTurns.length - 1].role !== 'user') {
    res.status(400).json({ error: 'turns must end with a user message' });
    return;
  }

  try {
    const garden = await getGardenContext();
    const plants = await sql`select name, type, spot, species from plants order by created_at asc limit 200`;
    const plantList = plants.map((p) => p.name + ' (' + [p.species, p.type, p.spot].filter(Boolean).join(', ') + ')').join('; ') || 'no plants recorded yet';
    const context =
      "You are the user's personal home gardening expert, familiar with their real garden. " + garden.text +
      '\nPlants: ' + plantList + '. Answer their questions specifically and practically, referencing their actual plants and local conditions where relevant. Keep answers concise.';

    const text = await chat(context, cleanTurns, { timeoutMs: 90_000 });
    res.status(200).json({ text: String(text || '').trim() || FALLBACK });
  } catch (e) {
    res.status(200).json({ text: FALLBACK });
  }
};
