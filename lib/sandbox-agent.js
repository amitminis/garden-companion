// The one place the Claude Agent SDK actually runs. Every AI touchpoint
// (research a plant, diagnose an issue, "ask about this plant", the daily
// weather-alert reasoning, ...) goes through runAgentPrompt()/runAgentJson()
// here rather than calling the SDK directly from a Vercel Function — the
// SDK needs to spawn the `claude` CLI binary and hold process state, which
// plain Functions can't do. This spins up a short-lived Vercel Sandbox,
// runs the SDK inside it, and tears the sandbox down when it's done.
//
// Auth: either CLAUDE_CODE_OAUTH_TOKEN (subscription-authenticated, from
// `claude setup-token` — needs a terminal) or ANTHROPIC_API_KEY (metered
// API billing, generated at console.anthropic.com — no terminal needed,
// works from a phone browser). Whichever is set is passed into the sandbox;
// CLAUDE_CODE_OAUTH_TOKEN wins if both are present.
//
// This is a proof-of-concept for the pattern, wired up for one touchpoint
// (plant research, in api/plants/[id]/research.js) so it's provably
// correct end-to-end. The other seven touchpoints from the AI-touchpoints
// doc follow the exact same runAgentPrompt()/runAgentJson() call shape —
// only the prompt text changes.
//
// require('@vercel/sandbox') is deliberately deferred to inside
// runAgentPrompt() rather than done at module load: one of its dependencies
// (@workflow/serde) ships ESM-only and throws ERR_REQUIRE_ESM the moment
// it's required. At module load, that exception would crash every handler
// in the same bundled Function (e.g. api/plant-detail.js pulls in every
// lib/handlers/plant-*.js file, so a load-time throw here takes down
// actions that don't even touch the sandbox, like a plain plant GET).
// Deferred into the async function body, the same throw instead becomes a
// normal rejected promise that callers already catch and degrade from.

// Runs inside the sandbox, not in this Function. Reads the prompt from a
// file (not an env var or argv) to sidestep any shell-escaping/length
// limits on prompts that contain quotes, newlines, etc. maxTurns:1 and
// bypassPermissions because these are single-shot "read this, answer with
// text/JSON" calls with no tool use and no human present to approve
// anything — there's nothing for permission prompts to gate here.
const AGENT_SCRIPT = `
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync } from 'node:fs';

const prompt = readFileSync('prompt.txt', 'utf8');
let finalText = null;
let errorText = null;
try {
  for await (const message of query({
    prompt,
    options: { maxTurns: 1, permissionMode: 'bypassPermissions' },
  })) {
    if (message.type === 'result') {
      if (message.subtype === 'success') finalText = message.result;
      else errorText = message.result || JSON.stringify(message);
    }
  }
} catch (e) {
  errorText = String((e && e.stack) || e);
}
writeFileSync('output.json', JSON.stringify({ result: finalText, error: errorText }));
`;

const AGENT_PACKAGE_JSON = JSON.stringify({
  name: 'agent-task',
  private: true,
  type: 'module',
  dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.278' },
});

// Runs `prompt` through the Agent SDK and returns the final assistant text.
// Throws on any failure (missing token, sandbox/npm/agent error) — callers
// decide how to degrade (the touchpoints doc's pattern: leave the plant
// "unresearched" / show a friendly error, never crash the request).
async function runAgentPrompt(prompt, { timeoutMs = 90_000 } = {}) {
  const { Sandbox } = require('@vercel/sandbox');

  const authEnv = {};
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    authEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (process.env.ANTHROPIC_API_KEY) {
    authEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  } else {
    throw new Error(
      'No Claude auth is configured. Set either CLAUDE_CODE_OAUTH_TOKEN ' +
      '(from `claude setup-token`) or ANTHROPIC_API_KEY (from console.anthropic.com) ' +
      'as a Vercel environment variable (see README).'
    );
  }

  const sandbox = await Sandbox.create({
    timeout: timeoutMs,
    resources: { vcpus: 1 },
    env: authEnv,
  });

  try {
    await sandbox.writeFiles([
      { path: 'prompt.txt', content: prompt },
      { path: 'agent-task.mjs', content: AGENT_SCRIPT },
      { path: 'package.json', content: AGENT_PACKAGE_JSON },
    ]);

    const install = await sandbox.runCommand('npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 60_000 });
    if (install.exitCode !== 0) {
      throw new Error('npm install failed in sandbox: ' + (await install.stderr()));
    }

    const run = await sandbox.runCommand('node', ['agent-task.mjs'], { timeoutMs });
    if (run.exitCode !== 0) {
      throw new Error('agent task exited ' + run.exitCode + ': ' + (await run.stderr()));
    }

    const buf = await sandbox.readFileToBuffer({ path: 'output.json' });
    if (!buf) throw new Error('agent task produced no output.json');
    const out = JSON.parse(buf.toString('utf8'));
    if (out.error) throw new Error('agent returned an error: ' + out.error);
    if (!out.result) throw new Error('agent returned no result text');
    return out.result;
  } finally {
    // Best-effort cleanup — don't let a stop() failure mask the real
    // result/error above, and don't let it throw unhandled after we've
    // already returned/thrown.
    await sandbox.stop().catch(() => {});
  }
}

// Same as runAgentPrompt, but expects (and enforces via the prompt) a JSON
// object back, mirroring the Artifact's sample.json(). Claude sometimes
// wraps JSON in a ```json ... ``` fence despite instructions not to —
// stripped before parsing, same tolerance the original app's
// normalizeDetailAnswer() applied to quoted strings.
async function runAgentJson(prompt, opts) {
  const text = await runAgentPrompt(prompt, opts);
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (e) {
    throw new Error('agent did not return valid JSON: ' + stripped.slice(0, 300));
  }
}

module.exports = { runAgentPrompt, runAgentJson };
