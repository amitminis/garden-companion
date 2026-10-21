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
const MODEL = 'claude-sonnet-5-5';

// Effort per kind of call (output_config.effort). Thinking is adaptive (the
// model's default) — at "low" it skips thinking on most simple requests;
// "medium" gives care guides and photo reads room to reason about the
// plant, the season and the local climate. Callers can override per call.
const DEFAULT_EFFORT = 'low';

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

// opts: {system, messages, timeoutMs, maxTokens, effort, schema}
// - maxTokens covers thinking as well as the reply, so it's sized well
//   above the longest expected answer.
// - schema: a JSON Schema; when given, the reply is constrained to it
//   (structured outputs) and comes back as a single JSON text block.
// - Server-side fallback ("default"): if Claude Sonnet 5.5's safety
//   classifiers decline a request in a category another model can handle,
//   the API re-runs it there within the same call.
async function callMessages({ system, messages, timeoutMs = 90_000, maxTokens = 16000, effort = DEFAULT_EFFORT, schema }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error(AI_UNAVAILABLE);

  const outputConfig = { effort };
  if (schema) outputConfig.format = { type: 'json_schema', schema };
  const body = { model: MODEL, max_tokens: maxTokens, messages, output_config: outputConfig, fallbacks: 'default' };
  if (system) body.system = system;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Anthropic Messages API request timed out after ' + timeoutMs + 'ms');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Anthropic Messages API request failed (' + res.status + '): ' + text.slice(0, 500));
  }
  const json = await res.json();
  if (json.stop_reason === 'refusal') {
    const category = json.stop_details && json.stop_details.category;
    throw new Error('Anthropic Messages API declined the request' + (category ? ' (' + category + ')' : ''));
  }
  if (json.stop_reason === 'max_tokens') {
    throw new Error('Anthropic Messages API reply was cut off at max_tokens (' + maxTokens + ')');
  }
  // The reply can start with (empty) thinking blocks — read text blocks
  // by type, not position.
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('Anthropic Messages API returned no text content');
  return text;
}

// Single-shot prompt -> text. opts: {images, timeoutMs, maxTokens, effort, schema}
async function complete(promptText, opts = {}) {
  const content = [{ type: 'text', text: promptText }, ...imageBlocks(opts.images)];
  return callMessages({
    system: opts.system, messages: [{ role: 'user', content }],
    timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens, effort: opts.effort, schema: opts.schema,
  });
}

// Same as complete(), but parses the reply as JSON. With opts.schema the
// reply is guaranteed to match it; without, a ```json fence is tolerated.
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
  return callMessages({ system: systemPrompt, messages, timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens, effort: opts.effort });
}

module.exports = { complete, completeJson, chat, AI_UNAVAILABLE };
