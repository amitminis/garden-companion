// Single entry point for every AI call in the app — the Anthropic Messages
// API, called directly. Replaces the former Sandbox + Agent SDK path
// (lib/sandbox-agent.js) and the separate photo-only lib/vision.js: every
// touchpoint here is single-shot prompt-in/text-or-JSON-out, or (Ask) a
// real multi-turn chat — none use tools or multi-step agency, so there was
// never a need for the Agent SDK's sandboxed process (which existed only
// to give the SDK somewhere to spawn the `claude` CLI binary). One fetch,
// one auth story (ANTHROPIC_API_KEY), optionally with photos attached as
// image content blocks — the same request shape whether or not an image
// is present.
//
// Requires ANTHROPIC_API_KEY. When it isn't set, every export here throws
// an Error whose message is exactly AI_UNAVAILABLE — callers pattern-match
// on that to degrade gracefully (e.g. save a photo without analysis, leave
// a plant unresearched) rather than fail the request.

const AI_UNAVAILABLE = 'AI_UNAVAILABLE';
const MODEL = 'claude-sonnet-4-5-20250929';

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('Invalid image dataUrl (expected data:<type>;base64,...)');
  return { mediaType: m[1], data: m[2] };
}

// images: a single "data:...;base64,..." string, an array of them, or
// undefined/null (no images).
function imageBlocks(images) {
  if (!images) return [];
  const list = Array.isArray(images) ? images : [images];
  return list.map((u) => {
    const { mediaType, data } = parseDataUrl(u);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });
}

async function callMessages({ system, messages, timeoutMs = 90_000, maxTokens = 1024 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error(AI_UNAVAILABLE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Anthropic Messages API request timed out after ' + timeoutMs + 'ms');
    throw e;
  } finally {
    clearTimeout(timer);
  }

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

// Single-shot prompt -> text. opts: {images, timeoutMs, maxTokens}
async function complete(promptText, opts = {}) {
  const content = [{ type: 'text', text: promptText }, ...imageBlocks(opts.images)];
  return callMessages({ messages: [{ role: 'user', content }], timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens });
}

// Same as complete(), but parses the reply as JSON — tolerating a ```json
// fence, since the model sometimes wraps JSON in one despite instructions.
async function completeJson(promptText, opts) {
  const text = await complete(promptText, opts);
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (e) {
    throw new Error('response was not valid JSON: ' + stripped.slice(0, 300));
  }
}

// Real multi-turn conversation -> text. turns: [{role:'user'|'assistant',
// content}, ...], already alternating and ending on a user turn — passed
// straight through as the Messages API's native `messages` array (no
// flattening into a single prompt string needed, unlike the old
// Sandbox/Agent-SDK path which only accepted one prompt).
async function chat(systemPrompt, turns, opts = {}) {
  const messages = turns.map((t) => ({ role: t.role, content: t.content }));
  return callMessages({ system: systemPrompt, messages, timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens });
}

module.exports = { complete, completeJson, chat, AI_UNAVAILABLE };
