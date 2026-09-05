// End-to-end smoke test: boots the real HTTP server (src/server.js) against
// an in-memory database, in DRY_RUN mode (no real Twilio/Anthropic calls —
// isValidTwilioSignature() and sendSms()/callClaude() all short-circuit),
// and drives it with plain fetch() the way Twilio actually would: a form-
// encoded POST to /webhooks/sms and /webhooks/voice.

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';
process.env.PORT = '0'; // ask the OS for a free port

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const { createApp } = await import('../src/server.js');
const { createBusiness, createUserInvite, setUserPassword, createSession } = await import('../src/db.js');
const { exampleBusinessConfig } = await import('../src/businessConfig.example.js');

let server;
let baseUrl;
let business;
let authHeaders;

before(async () => {
  business = createBusiness({
    name: 'AccuHVAC',
    phoneE164: '+15550001111',
    state: 'FL',
    timezone: 'America/New_York',
    config: exampleBusinessConfig,
  });

  // The dashboard-data routes this test reads back from (conversations,
  // messages, compliance-summary) are gated by a real login now — see
  // src/auth/auth.js — so build a session directly against db.js rather
  // than driving the login HTTP flow, which isn't what this test is about.
  const user = createUserInvite({
    businessId: business.id,
    email: 'owner@accuhvac.example.com',
    inviteToken: randomBytes(16).toString('hex'),
    inviteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  setUserPassword(user.id, 'irrelevant-for-this-test');
  const token = randomBytes(32).toString('hex');
  createSession({ token, userId: user.id, businessId: business.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  authHeaders = { cookie: `hellobob_session=${token}` };

  server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function postForm(path, params) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

function getAuthed(path) {
  return fetch(`${baseUrl}${path}`, { headers: authHeaders });
}

test('health check reports dry-run mode', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.dryRun, true);
});

test('a missed call triggers a reactive text-back and logs a conversation', async () => {
  const res = await postForm('/webhooks/voice', {
    From: '+15559998888',
    To: business.phone_e164,
    CallStatus: 'no-answer',
  });
  assert.equal(res.status, 200);

  const convRes = await getAuthed(`/api/businesses/${business.id}/conversations`);
  const conversations = await convRes.json();
  const convo = conversations.find((c) => c.phone_e164 === '+15559998888');
  assert.ok(convo, 'expected a conversation to have been created for the missed-call customer');
  assert.equal(convo.channel, 'voice_missed_call');
});

test('an inbound SMS gets a dry-run AI reply and is logged both ways', async () => {
  const res = await postForm('/webhooks/sms', {
    From: '+15557776666',
    To: business.phone_e164,
    Body: 'Hi, is anyone available to fix my AC today?',
  });
  assert.equal(res.status, 200);

  const convRes = await getAuthed(`/api/businesses/${business.id}/conversations`);
  const conversations = await convRes.json();
  const convo = conversations.find((c) => c.phone_e164 === '+15557776666');
  assert.ok(convo);

  const msgRes = await getAuthed(`/api/conversations/${convo.id}/messages`);
  const messages = await msgRes.json();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].direction, 'inbound');
  assert.equal(messages[1].direction, 'outbound');
  assert.match(messages[1].body, /DRY RUN/);
});

test('texting STOP opts the customer out and blocks further sends', async () => {
  const from = '+15551112222';
  await postForm('/webhooks/sms', { From: from, To: business.phone_e164, Body: 'hello' });
  const stopRes = await postForm('/webhooks/sms', { From: from, To: business.phone_e164, Body: 'STOP' });
  assert.equal(stopRes.status, 200);

  const convRes = await getAuthed(`/api/businesses/${business.id}/conversations`);
  const conversations = await convRes.json();
  const convo = conversations.find((c) => c.phone_e164 === from);
  const msgRes = await getAuthed(`/api/conversations/${convo.id}/messages`);
  const messages = await msgRes.json();
  const lastOutbound = [...messages].reverse().find((m) => m.direction === 'outbound');
  assert.match(lastOutbound.body, /unsubscribed/i);

  const complianceRes = await getAuthed(`/api/businesses/${business.id}/compliance-summary`);
  const summary = await complianceRes.json();
  assert.equal(summary.optedOut, 1);
});

test('an unknown business number is rejected', async () => {
  const res = await postForm('/webhooks/sms', { From: '+15550000000', To: '+19995550000', Body: 'hi' });
  assert.equal(res.status, 404);
});
