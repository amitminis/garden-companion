// Photo analysis — calls Anthropic's Messages API directly over HTTPS
// (global fetch, Node 24 runtime) rather than going through the Sandbox +
// Agent SDK path in lib/sandbox-agent.js. Image input on the Messages API is
// a well-documented content-block format, and a single direct request is
// much faster than spinning up a sandbox for every photo.
//
// Requires ANTHROPIC_API_KEY. When it isn't set, throws an Error whose
// message is exactly IMAGE_ANALYSIS_UNAVAILABLE — callers pattern-match on
// that to degrade gracefully (save the photo without analysis, the same as
// the original app's savePlantPhotoOnly() fallback).

const IMAGE_ANALYSIS_UNAVAILABLE = 'IMAGE_ANALYSIS_UNAVAILABLE';
const MODEL = 'claude-sonnet-4-5-20250929';

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('Invalid image dataUrl (expected data:<type>;base64,...)');
  return { mediaType: m[1], data: m[2] };
}

async function analyzeImageText(promptText, dataUrl) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error(IMAGE_ANALYSIS_UNAVAILABLE);
  const { mediaType, data } = parseDataUrl(dataUrl);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Anthropic Messages API request failed (' + res.status + '): ' + body.slice(0, 500));
  }
  const json = await res.json();
  const block = json && json.content && json.content[0];
  if (!block || typeof block.text !== 'string' || !block.text.trim()) {
    throw new Error('Anthropic Messages API returned no text content');
  }
  return block.text;
}

// Same as analyzeImageText, but parses the reply as JSON — tolerating a
// ```json fence the same way lib/sandbox-agent.js's runAgentJson() does.
async function analyzeImageJson(promptText, dataUrl) {
  const text = await analyzeImageText(promptText, dataUrl);
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (e) {
    throw new Error('image analysis did not return valid JSON: ' + stripped.slice(0, 300));
  }
}

module.exports = { analyzeImageJson, analyzeImageText, IMAGE_ANALYSIS_UNAVAILABLE };
