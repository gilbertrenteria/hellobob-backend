// Covers the SMS conversation engine's booking flow: check_availability must
// never let the model invent a slot (the code's own deterministic listing is
// the reply, not the model's text), book_appointment must only lock in a
// real, still-open slot, and a business with no technicians set up yet keeps
// working the old way (record whatever was verbally agreed).

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const { createBusiness, upsertCustomer, createConversation, createTechnician } = await import('../src/db.js');
const { setTechAvailability } = await import('../src/db.js');
const { runConversationTurn } = await import('../src/ai/conversationEngine.js');

const MON = '2026-09-07'; // matches test/booking.test.js — a real Monday

function setup(name = 'Desert Air') {
  const business = createBusiness({ name, phoneE164: `+1619555${Math.floor(Math.random() * 9000 + 1000)}`, state: 'CA', config: {} });
  const customer = upsertCustomer(business.id, '+16195551234', 'Jane Homeowner');
  const conversation = createConversation(business.id, customer.id, 'sms');
  return { business, customer, conversation };
}

test('check_availability replies with a real, deterministic listing — never the model\'s own text', async () => {
  const { business, customer, conversation } = setup();
  const mike = createTechnician(business.id, 'Mike');
  setTechAvailability(mike.id, [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }]); // Mon 9am-noon

  const fakeCallClaude = async () => ({
    text: "Sure, let me check!", // deliberately wrong/irrelevant — must never reach the customer as-is
    toolCalls: [{ name: 'check_availability', input: { service: 'AC repair', earliestStart: `${MON}T00:00`, latestStart: `${MON}T23:59` } }],
  });

  const { reply, category } = await runConversationTurn(
    { business, customer, conversation, inboundText: 'Can I get AC repair Monday?' },
    { callClaude: fakeCallClaude }
  );

  assert.ok(!reply.includes('Sure, let me check'), 'must not leak the model\'s own unverified text');
  assert.match(reply, /9:00 AM — Mike/);
  assert.match(reply, /10:00 AM — Mike/);
  assert.equal(category, 'reply_only');
});

test('book_appointment locks in a real slot and blocks a double-booking attempt', async () => {
  const { business, customer, conversation } = setup();
  const mike = createTechnician(business.id, 'Mike');
  setTechAvailability(mike.id, [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }]);

  const bookFirst = async () => ({
    text: "You're all set for Monday!",
    toolCalls: [{ name: 'book_appointment', input: { service: 'AC repair', address: '123 Main St', start: `${MON}T09:00`, technicianName: 'Mike' } }],
  });
  const first = await runConversationTurn(
    { business, customer, conversation, inboundText: '9am works, 123 Main St' },
    { callClaude: bookFirst }
  );
  assert.match(first.reply, /You're all set for Monday!/);
  assert.equal(first.category, 'consent_ask'); // full-consent ask appended after a real booking

  // A second customer tries to grab the exact same slot.
  const other = upsertCustomer(business.id, '+16195559999', 'Other Customer');
  const otherConversation = createConversation(business.id, other.id, 'sms');
  const bookSecond = async () => ({
    text: "You're all set!",
    toolCalls: [{ name: 'book_appointment', input: { service: 'AC repair', address: '456 Oak Ave', start: `${MON}T09:00`, technicianName: 'Mike' } }],
  });
  const second = await runConversationTurn(
    { business, customer: other, conversation: otherConversation, inboundText: '9am works too, 456 Oak Ave' },
    { callClaude: bookSecond }
  );
  assert.match(second.reply, /just got taken/);
  assert.notEqual(second.category, 'consent_ask'); // never confirmed as booked
});

test('a business with no technicians configured falls back to recording the verbally-agreed time', async () => {
  const { business, customer, conversation } = setup('No-Tech-Setup HVAC');

  const fakeCallClaude = async () => ({
    text: "Great, Thursday at 2pm it is!",
    toolCalls: [{ name: 'book_appointment', input: { service: 'Furnace check', address: '789 Pine Rd', start: '2026-09-10T14:00', technicianName: 'Whoever is free' } }],
  });

  const { reply, category } = await runConversationTurn(
    { business, customer, conversation, inboundText: 'Thursday 2pm works' },
    { callClaude: fakeCallClaude }
  );
  assert.match(reply, /Thursday at 2pm it is!/);
  assert.equal(category, 'consent_ask');
});
