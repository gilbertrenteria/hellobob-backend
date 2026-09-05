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
import {
  getAvailableSlots,
  bookAppointment,
  resolveTechnicianByName,
  businessHasSchedulingConfigured,
  nowInBusinessTimezone,
  addDays,
  SlotUnavailableError,
} from '../booking/scheduler.js';

const DEFAULT_APPOINTMENT_MINUTES = 60;
const MAX_SLOTS_TO_OFFER = 5;

// Two tools, not one, and deliberately split: check_availability lets Bob see
// REAL open times before saying anything about scheduling, and
// book_appointment only ever locks in a slot that check_availability already
// showed the customer. Neither tool's result is left for the model to
// describe in its own words — see the deterministic reply-building below —
// because a model paraphrasing real appointment times is exactly the kind of
// thing that could quietly hallucinate a slot that was never actually open.
const CHECK_AVAILABILITY_TOOL = {
  name: 'check_availability',
  description:
    "Look up REAL open appointment slots. Call this as soon as you know what service the customer needs and " +
    "roughly when they'd like it (\"tomorrow\", \"this week\", \"Thursday afternoon\") — convert that into a " +
    "concrete date range yourself using today's date above. Do not tell the customer any specific day/time " +
    "before calling this — you don't know what's actually open until you do.",
  input_schema: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'What the customer needs, e.g. "AC repair"' },
      earliestStart: { type: 'string', description: 'Earliest acceptable start, "YYYY-MM-DDTHH:MM", business-local time' },
      latestStart: { type: 'string', description: 'Latest acceptable start, "YYYY-MM-DDTHH:MM". Defaults to 7 days after earliestStart if omitted.' },
    },
    required: ['service', 'earliestStart'],
  },
};

const BOOK_APPOINTMENT_TOOL = {
  name: 'book_appointment',
  description:
    "Lock in ONE specific slot that check_availability already showed the customer, once they've picked it and " +
    "given an address. `start` and `technicianName` must exactly match one of those offered slots — never a time " +
    "or technician you haven't actually shown the customer as open.",
  input_schema: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'What the customer needs, e.g. "AC repair"' },
      address: { type: 'string', description: 'Service address' },
      start: { type: 'string', description: 'The exact slot start the customer picked, "YYYY-MM-DDTHH:MM"' },
      technicianName: { type: 'string', description: 'Which technician the picked slot was under' },
    },
    required: ['service', 'address', 'start', 'technicianName'],
  },
};

// Weekday/month names for turning a naive "YYYY-MM-DDTHH:MM" slot into
// something a customer would actually want to read in a text message.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatSlotForCustomer(naiveStr) {
  const [, y, mo, d, hh, mm] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(naiveStr).map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, hh, mm));
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  const ampm = hh < 12 ? 'AM' : 'PM';
  return `${WEEKDAYS[dt.getUTCDay()]} ${MONTHS[mo - 1]} ${d} at ${hour12}:${String(mm).padStart(2, '0')} ${ampm}`;
}

function buildSystemPrompt(business, { todayNaive }) {
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

  const schedulingConfigured = businessHasSchedulingConfigured(business.id);

  return [
    `You are Bob, the SMS assistant for ${cfg.businessName || business.name}, an HVAC company.`,
    cfg.tagline ? `Their tagline: "${cfg.tagline}"` : '',
    `You are texting with a customer who reached out (or whose missed call you're following up on).`,
    ``,
    `Today is ${todayNaive} (YYYY-MM-DDTHH:MM, business-local time) — use this to convert anything the customer says ("tomorrow", "Thursday") into a real date.`,
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
    `Never invent a price, technician name, or appointment slot yourself — pricing comes from the list above, and appointment slots ONLY ever come from calling check_availability. Never state a specific day/time as open without having just seen it in a check_availability result.`,
    schedulingConfigured
      ? `Once you know the service and a rough timeframe, call check_availability — don't ask the customer to just "pick a time" first, since you don't yet know what's actually open.`
      : `This business hasn't set up real-time scheduling yet, so once a service and rough timing are agreed, say a technician will confirm the exact time and call book_appointment with whatever time was discussed.`,
    `If the conversation goes somewhere you can't resolve (a complaint, a price dispute, anything outside normal scheduling), say: "${cfg.escalation?.phrase || 'Let me get one of our team to follow up with you on that.'}"`,
    `Do not mention texting consent, opt-in, or legal language yourself — that's handled separately by the system, not by you.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {object} [deps] Real dependencies by default — tests pass a fake
 *   callClaude directly instead of mocking the module (same seam used in
 *   webchat/websiteChat.js, for the same reason: it's simpler than mocking
 *   ESM named exports and won't break across Node versions).
 * @returns {Promise<{reply: string, category: string}|{reply: null}>}
 */
export async function runConversationTurn({ business, customer, conversation, inboundText }, deps = {}) {
  const { callClaude: callClaudeFn = callClaude } = deps;
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

  const todayNaive = nowInBusinessTimezone(business.timezone);
  const schedulingConfigured = businessHasSchedulingConfigured(business.id);

  const { text, toolCalls } = await callClaudeFn({
    system: buildSystemPrompt(business, { todayNaive }),
    messages,
    tools: [CHECK_AVAILABILITY_TOOL, BOOK_APPOINTMENT_TOOL],
  });

  // check_availability's result is never left for the model to paraphrase —
  // see the tool comment above. This deterministic listing IS the reply.
  const availabilityCheck = toolCalls.find((t) => t.name === 'check_availability');
  if (availabilityCheck) {
    if (!schedulingConfigured) {
      return {
        reply: "I'll have a technician confirm the exact time with you shortly — what's the best address for the visit?",
        category: MESSAGE_CATEGORIES.REPLY_ONLY,
      };
    }
    const { earliestStart, latestStart, service } = availabilityCheck.input;
    const slots = getAvailableSlots({
      businessId: business.id,
      rangeStart: earliestStart,
      rangeEnd: latestStart || addDays(earliestStart, 7),
      durationMinutes: DEFAULT_APPOINTMENT_MINUTES,
      now: todayNaive,
    }).slice(0, MAX_SLOTS_TO_OFFER);

    if (slots.length === 0) {
      return {
        reply: "I don't see anything open in that window — want me to check further out, or have a technician reach out directly?",
        category: MESSAGE_CATEGORIES.REPLY_ONLY,
      };
    }
    const listing = slots.map((s, i) => `${i + 1}. ${formatSlotForCustomer(s.start)} — ${s.technicianName}`).join('\n');
    return {
      reply: `Here's what's open for ${service}:\n${listing}\n\nWhich works, or want me to look at different days?`,
      category: MESSAGE_CATEGORIES.REPLY_ONLY,
    };
  }

  const booking = toolCalls.find((t) => t.name === 'book_appointment');
  if (booking) {
    const tech = schedulingConfigured ? resolveTechnicianByName(business.id, booking.input.technicianName) : null;

    if (tech) {
      try {
        bookAppointment({
          businessId: business.id,
          customerId: customer.id,
          conversationId: conversation.id,
          service: booking.input.service,
          address: booking.input.address,
          technicianId: tech.id,
          start: booking.input.start,
          durationMinutes: DEFAULT_APPOINTMENT_MINUTES,
        });
      } catch (err) {
        if (!(err instanceof SlotUnavailableError)) throw err;
        // Someone else took it (or the model mis-transcribed the time) —
        // never confirm a booking that isn't actually true. Offer fresh
        // options instead of silently double-booking or failing the turn.
        const freshSlots = getAvailableSlots({
          businessId: business.id,
          rangeStart: booking.input.start,
          rangeEnd: addDays(booking.input.start, 7),
          durationMinutes: DEFAULT_APPOINTMENT_MINUTES,
          now: todayNaive,
        }).slice(0, MAX_SLOTS_TO_OFFER);
        const listing = freshSlots
          .map((s, i) => `${i + 1}. ${formatSlotForCustomer(s.start)} — ${s.technicianName}`)
          .join('\n');
        return {
          reply: freshSlots.length
            ? `Sorry, that time just got taken. Still open nearby:\n${listing}\n\nWhich works?`
            : `Sorry, that time just got taken and nothing else is open nearby — let me have a technician reach out directly.`,
          category: MESSAGE_CATEGORIES.REPLY_ONLY,
        };
      }
    } else {
      // No real, schedulable technician to check against — either this
      // business hasn't set up technicians/hours yet, or the name didn't
      // match one. Fall back to recording what was agreed on verbally,
      // same as how every booking worked before real scheduling existed.
      createAppointment({
        businessId: business.id,
        customerId: customer.id,
        conversationId: conversation.id,
        service: booking.input.service,
        address: booking.input.address,
        scheduledAt: booking.input.start,
        technician: booking.input.technicianName,
      });
    }

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
