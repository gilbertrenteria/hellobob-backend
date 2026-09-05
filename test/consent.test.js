// Tests for the compliance gate (src/compliance/consent.js). These exercise
// the state machine with an in-memory database so they run instantly and
// never touch the real data/hellobob.db file.
//
// IMPORTANT: env vars must be set before db.js (or anything importing it)
// is loaded, so the imports below are dynamic and happen after the env is
// set — a normal top-of-file `import` would be hoisted ahead of this.

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  canSend,
  recordFullConsentAnswer,
  processOptOut,
  isOptOutMessage,
  parseYesNo,
  MESSAGE_CATEGORIES,
} = await import('../src/compliance/consent.js');
const { createBusiness, upsertCustomer } = await import('../src/db.js');

// node:sqlite enforces foreign keys, so consent_records/opt_outs rows need
// real businesses/customers rows behind them — create fresh ones per test
// (a new phone number each time) so tests can't interfere with each other.
let fixtureCounter = 0;
function freshFixtures() {
  fixtureCounter += 1;
  const business = createBusiness({
    name: 'Test HVAC',
    phoneE164: `+1555000${String(fixtureCounter).padStart(4, '0')}`,
    state: 'FL',
    timezone: 'America/New_York',
    config: {},
  });
  // 24/7 window (start === end) so these tests never depend on wall-clock time.
  business.quiet_hours_start = 0;
  business.quiet_hours_end = 0;
  const customer = upsertCustomer(business.id, `+1555111${String(fixtureCounter).padStart(4, '0')}`, null);
  return { business, customer };
}

test('a reactive reply needs no prior consent', () => {
  const { business, customer } = freshFixtures();
  const decision = canSend(business, customer, MESSAGE_CATEGORIES.REPLY_ONLY, false);
  assert.equal(decision.allowed, true);
});

test('a transactional message is blocked without full consent on file', () => {
  const { business, customer } = freshFixtures();
  const decision = canSend(business, customer, MESSAGE_CATEGORIES.TRANSACTIONAL, false);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /full-texting-consent/);
});

test('a transactional message is allowed once full consent is granted', () => {
  const { business, customer } = freshFixtures();
  recordFullConsentAnswer(business, customer, true);
  const decision = canSend(business, customer, MESSAGE_CATEGORIES.TRANSACTIONAL, false);
  assert.equal(decision.allowed, true);
});

test('declining full consent keeps transactional messages blocked', () => {
  const { business, customer } = freshFixtures();
  recordFullConsentAnswer(business, customer, false);
  const decision = canSend(business, customer, MESSAGE_CATEGORIES.TRANSACTIONAL, false);
  assert.equal(decision.allowed, false);
});

test('STOP revokes everything, even a bare reply', () => {
  const { business, customer } = freshFixtures();
  recordFullConsentAnswer(business, customer, true);
  processOptOut(business, customer, 'STOP');

  assert.equal(canSend(business, customer, MESSAGE_CATEGORIES.REPLY_ONLY, false).allowed, false);
  assert.equal(canSend(business, customer, MESSAGE_CATEGORIES.TRANSACTIONAL, false).allowed, false);
});

test('promotional messages need their own separate opt-in', () => {
  const { business, customer } = freshFixtures();
  recordFullConsentAnswer(business, customer, true); // full consent ≠ promotional consent
  const decision = canSend(business, customer, MESSAGE_CATEGORIES.PROMOTIONAL, false);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /promotional/);
});

test('isOptOutMessage matches only a bare stop-family word', () => {
  assert.equal(isOptOutMessage('STOP'), true);
  assert.equal(isOptOutMessage('stop.'), true);
  assert.equal(isOptOutMessage('unsubscribe'), true);
  assert.equal(isOptOutMessage('please stop texting me'), false);
  assert.equal(isOptOutMessage('what are your hours'), false);
});

test('parseYesNo reads a clear yes/no and refuses to guess otherwise', () => {
  assert.equal(parseYesNo('Yes'), true);
  assert.equal(parseYesNo('yeah'), true);
  assert.equal(parseYesNo('No'), false);
  assert.equal(parseYesNo('nope'), false);
  assert.equal(parseYesNo('maybe later'), null);
  assert.equal(parseYesNo(''), null);
});
