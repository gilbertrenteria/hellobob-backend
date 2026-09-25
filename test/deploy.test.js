// Deployment-shape checks for the public demo on Render:
//   * CORS: WEBSITE_CHAT_ALLOWED_ORIGIN as a comma list — the GitHub Pages
//     site and gilbertrenteria.dev must both be able to call
//     /api/website-chat and /api/signup (including the OPTIONS preflight),
//     and an origin not on the list must not get an allow header.
//   * Only ANTHROPIC_API_KEY set (no TWILIO_*): Claude is live (dryRun is
//     false) but an SMS send is logged and skipped rather than thrown.
//   * DEMO_MODE off: /api/demo-info says so, and /api/me carries demo:false.
//
// This file never calls Claude — the fake key exists only to turn dryRun off
// so the Twilio skip path is what's under test.

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
delete process.env.DRY_RUN;
delete process.env.DEMO_MODE;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
process.env.WEBSITE_CHAT_ALLOWED_ORIGIN = 'https://gilbertrenteria.github.io, https://gilbertrenteria.dev/';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp, corsOriginFor } = await import('../src/server.js');
const { config } = await import('../src/config.js');
const { sendSms } = await import('../src/telephony/twilio.js');

let server;
let baseUrl;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('with only ANTHROPIC_API_KEY set, dry-run is off but Twilio is reported unconfigured', () => {
  assert.equal(config.dryRun, false);
  assert.equal(config.twilioConfigured, false);
  assert.equal(config.demoMode, false);
});

test('sendSms logs and skips instead of throwing when Twilio is not configured', async () => {
  const result = await sendSms('+15555550100', 'hello');
  assert.equal(result.status, 'skipped_unconfigured');
  assert.equal(result.sid, 'SKIPPED');
});

test('corsOriginFor matches a comma list exactly (trailing slash and case tolerated)', () => {
  assert.equal(corsOriginFor('https://gilbertrenteria.github.io'), 'https://gilbertrenteria.github.io');
  assert.equal(corsOriginFor('https://gilbertrenteria.dev'), 'https://gilbertrenteria.dev');
  assert.equal(corsOriginFor('https://GilbertRenteria.dev/'), 'https://GilbertRenteria.dev');
  assert.equal(corsOriginFor('https://evil.example'), null);
  assert.equal(corsOriginFor('https://gilbertrenteria.github.io.evil.example'), null);
  assert.equal(corsOriginFor(undefined), null);
});

for (const path of ['/api/website-chat', '/api/signup']) {
  test(`OPTIONS preflight on ${path} echoes an allowed origin with Vary: Origin`, async () => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://gilbertrenteria.dev',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://gilbertrenteria.dev');
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.match(res.headers.get('access-control-allow-headers'), /content-type/);
    assert.equal(res.headers.get('vary'), 'Origin');
  });

  test(`OPTIONS preflight on ${path} gives no allow-origin header to an unknown origin`, async () => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
}

test('POST /api/signup from the GitHub Pages origin carries the matching allow-origin header', async () => {
  // A bad body is fine here — we only care that the CORS header is present
  // on the actual POST response, not just the preflight.
  const res = await fetch(`${baseUrl}/api/signup`, {
    method: 'POST',
    headers: { origin: 'https://gilbertrenteria.github.io', 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://gilbertrenteria.github.io');
});

test('GET /health is 200 {ok:true} and GET /api/demo-info reports demo:false outside demo mode', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const info = await fetch(`${baseUrl}/api/demo-info`);
  assert.equal(info.status, 200);
  assert.deepEqual(await info.json(), { demo: false });
});
