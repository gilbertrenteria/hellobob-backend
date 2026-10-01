// Confirms the pre-existing, default behavior stays intact when
// OWNER_FORWARD_PHONE is left unset (the state every deployment starts in,
// until an owner adds their real cell number): an incoming call just gets
// the old empty/disconnect TwiML, exactly as before whisper-forwarding was
// added in webhooks.js. Kept in its own file (its own process, under
// `node --test`) specifically so it does NOT inherit the
// OWNER_FORWARD_PHONE env var set at the top of webhooks.integration.test.js.

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';
process.env.PORT = '0';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const { createBusiness } = await import('../src/db.js');
const { exampleBusinessConfig } = await import('../src/businessConfig.example.js');
const { config } = await import('../src/config.js');

let server;
let baseUrl;
let business;

before(async () => {
  assert.equal(config.ownerForwardPhone, '', 'expected OWNER_FORWARD_PHONE to be unset for this test file');
  business = createBusiness({
    name: 'AccuHVAC',
    phoneE164: '+15550002222',
    state: 'FL',
    timezone: 'America/New_York',
    config: exampleBusinessConfig,
  });
  server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('with no OWNER_FORWARD_PHONE set, an incoming call still just gets disconnected (old default)', async () => {
  const res = await fetch(`${baseUrl}/webhooks/voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+15559998888', To: business.phone_e164, CallStatus: 'ringing' }),
  });
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.equal(xml, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});
