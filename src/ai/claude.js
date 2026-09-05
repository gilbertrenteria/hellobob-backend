// Thin Anthropic Messages API client using nothing but built-in `fetch` —
// same rationale as telephony/twilio.js: no SDK dependency needed for what
// this backend does (one text-generation call per inbound message, with
// optional tool use for booking).

import { config } from '../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * @param {object} opts
 * @param {string} opts.system     system prompt (business context + instructions)
 * @param {Array}  opts.messages   [{role: 'user'|'assistant', content: string}]
 * @param {Array}  [opts.tools]    Anthropic tool definitions
 * @returns {Promise<{text: string, toolCalls: Array<{name: string, input: object}>}>}
 */
export async function callClaude({ system, messages, tools }) {
  if (config.dryRun) {
    console.log('[DRY RUN] Would call Claude with system prompt:', system.slice(0, 120), '...');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return {
      text:
        `[DRY RUN — no ANTHROPIC_API_KEY set] Bob would reply here to: ` +
        `"${lastUser?.content ?? ''}". Set ANTHROPIC_API_KEY in .env to go live.`,
      toolCalls: [],
    };
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 512,
      system,
      messages,
      ...(tools ? { tools } : {}),
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${data.error?.message || JSON.stringify(data)}`);
  }

  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const toolCalls = data.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ name: b.name, input: b.input }));

  return { text, toolCalls };
}
