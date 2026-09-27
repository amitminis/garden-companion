// POST /api/ask   body: {turns: [{role:'user'|'assistant', content}, ...]}
//
// Ported from garden-companion.html's Ask panel (sendAsk + gardenContext).
// The garden-context message is built here from the DB — never trusted from
// the client. lib/sandbox-agent.js's runAgentPrompt takes one prompt string
// (maxTurns:1), so the context + conversation are flattened into a single
// transcript and the model is asked to reply as the assistant.
//
// Always 200: on failure returns the original's fallback text.

const sql = require('../lib/db');
const { runAgentPrompt } = require('../lib/sandbox-agent');

const FALLBACK = "Sorry, I couldn't answer that just now.";

module.exports = async function handler(req, res) {
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
    const [settings] = await sql`select location from settings where id = true`;
    const plants = await sql`select name, type, spot from plants order by created_at asc limit 200`;
    const loc = (settings && settings.location && settings.location.label) || 'unspecified';
    const plantList = plants.map((p) => p.name + ' (' + p.type + (p.spot ? ', ' + p.spot : '') + ')').join('; ') || 'no plants recorded yet';
    const context =
      "You are the user's personal home gardening expert, familiar with their real garden. Garden location: " + loc +
      '. Plants: ' + plantList + '. Answer their questions specifically and practically, referencing their actual plants and conditions where relevant. Keep answers concise.';

    const transcript = cleanTurns
      .map((t) => (t.role === 'user' ? 'User: ' : 'Assistant: ') + t.content.trim())
      .join('\n\n');
    const prompt = context + '\n\nConversation so far:\n\n' + transcript + '\n\nRespond as the assistant to the latest message above. Reply with only your answer text — no "Assistant:" prefix.';

    const text = await runAgentPrompt(prompt, { timeoutMs: 90_000 });
    const answer = String(text || '').trim().replace(/^Assistant:\s*/i, '');
    res.status(200).json({ text: answer || FALLBACK });
  } catch (e) {
    res.status(200).json({ text: FALLBACK });
  }
};
