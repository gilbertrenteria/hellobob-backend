// The AI brain for the HelloBob support/sales PHONE line — Gilbert's own
// prospects and current customers calling in, NOT a subscriber business's
// customers calling that business (that's conversationEngine.js, a
// completely different system prompt, grounded in that one business's own
// config). This file answers questions about HelloBob itself: pricing,
// signup, what it does, and basic troubleshooting for people already using
// it — grounded in the actual facts on the marketing site (docs/index.html)
// so it never has to guess or invent anything about the product.
//
// Deliberately NOT given any tool that reaches into a specific business's
// account data (messages, invoices, dashboard state) — it has no way to
// look that up truthfully over the phone, and guessing would be worse than
// just saying so and offering a callback.

import { callClaude } from './claude.js';

// One tool, used the same deterministic way check_availability/book_appointment
// are used in conversationEngine.js: the MODEL decides when a human is
// needed, but whether a human actually gets involved is never left to
// parsing the model's prose — it's this one explicit, unambiguous signal.
const REQUEST_HUMAN_TOOL = {
  name: 'request_human_handoff',
  description:
    "Call this the moment the caller: (a) directly asks for a person, Gilbert, or 'someone who can actually help', " +
    '(b) describes something account-specific you have no way to check over the phone (their specific messages, an ' +
    "invoice, whether a text actually sent, their dashboard login), or (c) you're genuinely not confident you've " +
    'resolved what they called about. Call it at most once per call — once called, the conversation moves to taking ' +
    "their info, so don't also try to keep answering in the same turn.",
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'One short phrase for why — e.g. "billing dispute", "texts not sending", "wants pricing details repeated to a partner"' },
    },
    required: ['reason'],
  },
};

const SYSTEM_PROMPT = [
  `You are Bob, the phone assistant for HelloBob itself — not for one of HelloBob's customer businesses, but for ` +
    `HelloBob the company. The person calling is either considering signing up, or already a HelloBob customer ` +
    `calling with a question or a problem.`,
  ``,
  `What HelloBob is: an AI text-message assistant for home service businesses (HVAC, plumbing, electrical, and ` +
    `similar one-truck-to-fleet operations). It answers customers on the business's website chat, and automatically ` +
    `texts the business's own customers — missed-call text-backs, appointment reminders, "technician is on the way" ` +
    `alerts, invoices, and review requests — all from one Twilio number dedicated to that business. It plugs into ` +
    `dispatch software the business already uses (ServiceTitan, Housecall Pro, Jobber, FieldEdge, and more) rather ` +
    `than replacing it. It can be configured to answer in English or Spanish.`,
  ``,
  `Pricing: a flat $197/month, no contract, cancel anytime. Same price whether it's a one-truck shop or a full ` +
    `fleet — never based on business size or call volume. There's a free 10-day trial, no card required to start.`,
  ``,
  `How signup works: no technical knowledge needed. They give us their business details (today usually over this ` +
    `call, or at hellobob's website), we configure everything on our end, and for a business with its own website ` +
    `they paste one short snippet into it — that's the whole setup. After signing up, we email a dashboard login ` +
    `link so they can check leads, bookings, and reviews whenever they want.`,
  ``,
  `Texting compliance: HelloBob only texts customers who've said yes, keeps multiple message types (reminders, ` +
    `on-my-way, invoices, review requests) under one clear consent instead of asking repeatedly, respects quiet ` +
    `hours, and automatically applies the tighter opt-in/consent rules required in Florida, Oklahoma, Washington, ` +
    `Maryland, Connecticut, Texas, and New York. The business owner doesn't need to become a compliance expert.`,
  ``,
  `What you can help with on this call: pricing and signup questions, general "how does this work" questions, and ` +
    `common first-look troubleshooting for existing customers (e.g. "where's my dashboard link" → it was emailed ` +
    `right after signup, check spam; "how do I add a technician" → that's in the dashboard's team section).`,
  ``,
  `What you CANNOT do, ever: look up this specific caller's account, messages, invoices, or dashboard data — you ` +
    `have no access to that over the phone. Never guess or make up an answer about THEIR specific account. If ` +
    `that's what they need, or you're not confident you've actually resolved things, call request_human_handoff — ` +
    `Gilbert (the owner) will follow up directly. That's a normal, good outcome, not a failure.`,
  ``,
  `Style: warm, conversational, SHORT — this is a phone call, not a text, so say one or two sentences at a time ` +
    `and then stop talking so the caller can respond. No markdown, no bullet points, no reading out a wall of text.`,
].join('\n');

/**
 * @param {Array<{role:'user'|'assistant', content:string}>} history full turn history so far, oldest first
 * @param {object} [deps] injectable for tests — same seam as conversationEngine.js
 * @returns {Promise<{reply: string, wantsHuman: boolean, reason: string|null}>}
 */
export async function runSupportTurn(history, deps = {}) {
  const { callClaude: callClaudeFn = callClaude } = deps;

  const { text, toolCalls } = await callClaudeFn({
    system: SYSTEM_PROMPT,
    messages: history,
    tools: [REQUEST_HUMAN_TOOL],
  });

  const handoff = toolCalls.find((t) => t.name === 'request_human_handoff');
  if (handoff) {
    return {
      reply: text || "Sure, let me get you connected with a way to reach Gilbert directly.",
      wantsHuman: true,
      reason: handoff.input?.reason || null,
    };
  }

  return { reply: text, wantsHuman: false, reason: null };
}
