// POST /api/plants/:id/details   body: {key, rawText}
//
// Ported from garden-companion.html's openGetToKnowPlant() save handler +
// normalizeDetailAnswer(). Saves one "get to know this plant" answer to
// plant_details[key] as {raw, display}, where `display` is a short,
// standardized label for the profile (e.g. "planted about 2 years ago" ->
// "~2 years"). The raw text is always kept as the source of truth; display
// falls back to the raw text whenever the AI call fails or returns nothing.
// The "age" answer also mirrors its display form onto age_estimate.

const sql = require('../db');
const { plantFromRow, jsonParam } = require('../mappers');
const { runAgentPrompt } = require('../sandbox-agent');

// Keys + labels must match GET_TO_KNOW_QUESTIONS in public/js/app.js.
const QUESTION_LABELS = {
  age: 'About how old is it?',
  yieldPerYear: 'How much does it produce each year?',
  groundType: "What's the ground like there?",
  watering: 'How do you water it?',
  sunExposure: 'How much sun does that spot get?',
};

async function normalizeDetailAnswer(question, rawText) {
  try {
    const text = await runAgentPrompt(
      'Rewrite the following answer to the gardening question "' + question + '" as a short, clean, standardized label — a few words, no filler, keep the key fact or number exactly. Reply with ONLY that short phrase, no quotation marks, no extra text.\n\nAnswer: ' + rawText,
      { timeoutMs: 60_000 }
    );
    const txt = String(text || '').trim().replace(/^["'“”](.*)["'“”]$/s, '$1').trim();
    return txt || rawText;
  } catch (e) {
    return rawText;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id } = req.query;
  const body = req.body || {};
  const key = body.key;
  const rawText = String(body.rawText || '').trim();
  if (!Object.prototype.hasOwnProperty.call(QUESTION_LABELS, key)) {
    res.status(400).json({ error: 'key must be one of: ' + Object.keys(QUESTION_LABELS).join(', ') });
    return;
  }
  if (!rawText) {
    res.status(400).json({ error: 'rawText is required' });
    return;
  }

  const [row] = await sql`select * from plants where id = ${id}`;
  const plant = plantFromRow(row);
  if (!plant) {
    res.status(404).json({ error: 'Plant not found' });
    return;
  }

  const display = await normalizeDetailAnswer(QUESTION_LABELS[key], rawText);

  // Re-read plant_details right before writing, so a concurrent save of a
  // different key (normalization takes a while) isn't clobbered.
  const [fresh] = await sql`select plant_details from plants where id = ${id}`;
  const newDetails = Object.assign({}, (fresh && fresh.plant_details) || {});
  newDetails[key] = { raw: rawText, display };

  let updated;
  if (key === 'age') {
    [updated] = await sql`
      update plants set plant_details = ${jsonParam(newDetails)}, age_estimate = ${display}, updated_at = now()
      where id = ${id} returning *
    `;
  } else {
    [updated] = await sql`
      update plants set plant_details = ${jsonParam(newDetails)}, updated_at = now()
      where id = ${id} returning *
    `;
  }
  res.status(200).json(plantFromRow(updated));
};
