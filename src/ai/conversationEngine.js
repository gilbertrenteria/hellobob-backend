// Turns one inbound SMS into one outbound reply. This is the ONLY module
// that talks to the AI model. Everything it decides about WHAT to say is
// advisory — whether the reply is actually allowed to go out is decided
// separately and deterministically by compliance/consent.js's canSend().
//
// One rule this file enforces on itself, deliberately: the full-consent
// yes/no answer is never interpreted by the model. It's parsed with the
// same regex-based parseYesNo() used everywhere else, so a customer's
// consent status can never depend on how the AI feels like reading "yeah
// I guess so." See the "consent_ask" handling below.

import { callClaude } from './claude.js';
import { getConversationMessages, createAppointment } from '../db.js';
import {
  parseYesNo,
  recordFullConsentAnswer,
  FULL_CONSENT_WORDING,
  MESSAGE_CATEGORIES,
} from '../compliance/consent.js';

const BOOK_APPOINTMENT_TOOL = {
  name: 'book_appointment',
  description:
    "Record a confirmed appointment once the customer has agreed on a service, address, and time. " +
    "Only call this when those three things are actually settled — don't call it while still gathering info.",
  input_schema: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'What the customer needs, e.g. "AC repair"' },
      address: { type: 'string', description: 'Service address' },
      scheduledAt: { type: 'string', description: 'Agreed date/time, in plain language or ISO 8601' },
      technician: { type: 'string', description: 'Assigned technician, if known' },
    },
    required: ['service', 'address', 'scheduledAt'],
  },
};

function buildSystemPrompt(business) {
  let cfg = {};
  try {
    cfg = JSON.parse(business.config_json || '{}');
  } catch {
    cfg = {};
  }

  const hoursLines = cfg.hours
    ? Object.entries(cfg.hours).map(([day, hrs]) => `  ${day}: ${hrs}`).join('\n')
    : '  (hours not configured)';

  const servicesLines = (cfg.services || [])
    .map((s) => `  - ${s.name}: ${s.typicalPrice || 'ask a technician for pricing'}`)
    .join('\n') || '  (services not configured)';

  return [
    `You are Bob, the SMS assistant for ${cfg.businessName || business.name}, an HVAC company.`,
    cfg.tagline ? `Their tagline: "${cfg.tagline}"` : '',
    `You are texting with a customer who reached out (or whose missed call you're following up on).`,
    ``,
    `Business hours:`,
    hoursLines,
    ``,
    `Service area: ${(cfg.serviceArea || []).join(', ') || '(not configured)'}`,
    ``,
    `Services and typical pricing:`,
    servicesLines,
    ``,
    cfg.emergencyPolicy ? `Emergency policy: ${cfg.emergencyPolicy}` : '',
    cfg.bookingNotes ? `Booking notes: ${cfg.bookingNotes}` : '',
    ``,
    `Style: warm, brief, text-message length (1-3 short sentences). No emoji. No markdown.`,
    `Never invent a price, technician name, or appointment slot you weren't given — say a technician will confirm instead of guessing.`,
    `If the conversation goes somewhere you can't resolve (a complaint, a price dispute, anything outside normal scheduling), say: "${cfg.escalation?.phrase || 'Let me get one of our team to follow up with you on that.'}"`,
    `When the customer has agreed on a service, an address, and a time, call the book_appointment tool with those details — don't just say it's booked in text without calling the tool.`,
    `Do not mention texting consent, opt-in, or legal language yourself — that's handled separately by the system, not by you.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @returns {Promise<{reply: string, category: string}|{reply: null}>}
 */
export async function runConversationTurn({ business, customer, conversation, inboundText }) {
  const history = getConversationMessages(conversation.id, 30);
  const lastOutbound = [...history].reverse().find((m) => m.direction === 'outbound');

  // We're mid-way through the deterministic full-consent yes/no exchange —
  // handle it here, without involving the model at all.
  if (lastOutbound?.category === 'consent_ask') {
    const answer = parseYesNo(inboundText);
    if (answer === null) {
      return {
        reply: "Sorry, just to confirm — reply YES or NO to texts about your appointment (reminders, on-my-way, invoice, review request).",
        category: 'consent_ask',
      };
    }
    recordFullConsentAnswer(business, customer, answer, 'booking_ask');
    return {
      reply: answer
        ? "Great, you're all set — we'll text you a reminder, an on-my-way alert, and your invoice."
        : "No problem, we won't send those texts. We'll still reply here if you write in.",
      category: MESSAGE_CATEGORIES.REPLY_ONLY,
    };
  }

  const messages = [
    ...history.map((m) => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body })),
    { role: 'user', content: inboundText },
  ];

  const { text, toolCalls } = await callClaude({
    system: buildSystemPrompt(business),
    messages,
    tools: [BOOK_APPOINTMENT_TOOL],
  });

  const booking = toolCalls.find((t) => t.name === 'book_appointment');
  if (booking) {
    createAppointment({
      businessId: business.id,
      customerId: customer.id,
      conversationId: conversation.id,
      service: booking.input.service,
      address: booking.input.address,
      scheduledAt: booking.input.scheduledAt,
      technician: booking.input.technician,
    });

    // Booking confirmed → deterministically append the one-time full-consent
    // ask, in its exact required wording, right after. This does NOT depend
    // on the model choosing to ask it.
    const confirmation = text || "You're booked!";
    return {
      reply: `${confirmation}\n\n${FULL_CONSENT_WORDING}`,
      category: 'consent_ask',
    };
  }

  return { reply: text, category: MESSAGE_CATEGORIES.REPLY_ONLY };
}
