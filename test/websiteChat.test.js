// Covers the marketing-site "Ask Bob" chat endpoint: the public
// /api/website-chat route and its abuse guards (via real HTTP, dry-run
// Claude), plus the capture_signup hand-off that replaces the old Jotform
// quick sign-up (tested directly against handleWebsiteChat with injected
// fakes for callClaude/sendEmail — see that function's `deps` param for why:
// ESM named exports can't be redefined by node:test's mock.method).

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';
process.env.PORT = '0';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const { handleWebsiteChat } = await import('../src/webchat/websiteChat.js');
const { captureSignup } = await import('../src/signup.js');
const { listSignups } = await import('../src/db.js');

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

function postChat(history) {
  return fetch(`${baseUrl}/api/website-chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ history }),
  });
}

// ---- HTTP-level: real dry-run Claude behind the real server ----

test('a plain question gets the dry-run reply and CORS headers', async () => {
  const res = await postChat([{ role: 'user', content: 'how much does it cost?' }]);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.match(json.text, /DRY RUN/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('OPTIONS preflight is answered with no body', async () => {
  const res = await fetch(`${baseUrl}/api/website-chat`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
});

test('empty history is rejected as bad_request', async () => {
  const res = await postChat([]);
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error, 'bad_request');
});

test('history not ending on a user turn is rejected', async () => {
  const res = await postChat([{ role: 'assistant', content: 'hi' }]);
  assert.equal(res.status, 400);
});

test('/api/signups is hidden without the right admin key', async () => {
  const res = await fetch(`${baseUrl}/api/signups?key=wrong`);
  assert.equal(res.status, 404);
});

// ---- The plain on-page "Start My Free Trial" form — the OTHER path in ----
test('POST /api/signup (the plain form, not chat) saves a row and returns the questionnaire link', async () => {
  const before = listSignups().length;
  const res = await fetch(`${baseUrl}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: 'Desert Air LLC', contactEmail: 'owner@desertair.com', contactPhone: '480-555-0111' }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.signup?.id);
  assert.equal(json.questionnaireUrl, 'https://form.jotform.com/262458290659065');

  const rows = listSignups();
  assert.equal(rows.length, before + 1);
  const saved = rows.find((r) => r.id === json.signup.id);
  assert.equal(saved?.source, 'website_form');
  assert.equal(saved?.business_name, 'Desert Air LLC');
});

test('POST /api/signup rejects a missing field with 400', async () => {
  const res = await fetch(`${baseUrl}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: 'No Email Co', contactEmail: '', contactPhone: '480-555-0111' }),
  });
  assert.equal(res.status, 400);
});

// ---- Direct: capture_signup logic, with a fake model + fake mailer ----

test('a capture_signup tool call saves a real row and emails both parties — no Jotform involved', async () => {
  const sentEmails = [];
  const fakeCallClaude = async () => ({
    text: "Great, you're all set — check your email for the setup questionnaire!",
    toolCalls: [{
      name: 'capture_signup',
      input: { businessName: 'Sunrise Air & Heat', contactEmail: 'mike@sunriseair.com', contactPhone: '619-555-0148' },
    }],
  });
  const fakeCreateSignup = (row) => ({ id: 42, ...row });
  const fakeSendEmail = async ({ to, subject }) => {
    sentEmails.push({ to, subject });
    return { sent: true };
  };

  const result = await handleWebsiteChat(
    {
      ip: '1.2.3.4',
      history: [
        { role: 'user', content: "I'm ready to sign up" },
        { role: 'assistant', content: 'Great — business name, email, and phone?' },
        { role: 'user', content: 'Sunrise Air & Heat, mike@sunriseair.com, 619-555-0148' },
      ],
    },
    {
      callClaude: fakeCallClaude,
      captureSignup: (row) => captureSignup(row, { createSignup: fakeCreateSignup, sendEmail: fakeSendEmail }),
    }
  );

  assert.equal(result.signup.id, 42);
  assert.equal(result.questionnaireUrl, 'https://form.jotform.com/262458290659065');
  assert.equal(sentEmails.length, 2);
  assert.ok(sentEmails.some((e) => e.to === 'mike@sunriseair.com'), 'visitor gets the welcome email');
  assert.ok(sentEmails.some((e) => e.subject.includes('Sunrise Air & Heat')), 'Gilbert gets a notification email');
});

test('a capture_signup call missing a required field is ignored, not half-saved', async () => {
  const fakeCallClaude = async () => ({
    text: 'Sure — what’s the best email to reach you at?',
    toolCalls: [{ name: 'capture_signup', input: { businessName: 'Incomplete Co', contactEmail: '', contactPhone: '619-555-0000' } }],
  });
  let captureSignupCalled = false;

  const result = await handleWebsiteChat(
    { ip: '1.2.3.4', history: [{ role: 'user', content: 'sign me up, Incomplete Co' }] },
    { callClaude: fakeCallClaude, captureSignup: async () => { captureSignupCalled = true; } }
  );

  assert.equal(result.signup, undefined);
  assert.equal(captureSignupCalled, false, 'should never even call captureSignup without all three fields');
});

test('the real signups table (no fakes) actually gets a row via the full default path', async () => {
  const fakeCallClaude = async () => ({
    text: "You're all set!",
    toolCalls: [{ name: 'capture_signup', input: { businessName: 'Coastal Cooling', contactEmail: 'j@coastalcooling.com', contactPhone: '619-555-0199' } }],
  });
  const before = listSignups().length;
  const result = await handleWebsiteChat(
    { ip: '1.2.3.5', history: [{ role: 'user', content: 'sign me up' }] },
    { callClaude: fakeCallClaude } // captureSignup NOT overridden — real db write, dry-run email
  );
  assert.ok(result.signup?.id);
  const rows = listSignups();
  assert.equal(rows.length, before + 1);
  const saved = rows.find((r) => r.id === result.signup.id);
  assert.equal(saved?.business_name, 'Coastal Cooling');
  assert.equal(saved?.source, 'website_chat');
});

test('rate limiting kicks in after the per-IP hourly cap', async () => {
  const fakeCallClaude = async () => ({ text: 'ok', toolCalls: [] });
  const ip = 'rate-limit-test-ip';
  let lastErrorCode;
  for (let i = 0; i < 31; i++) {
    try {
      await handleWebsiteChat({ ip, history: [{ role: 'user', content: `msg ${i}` }] }, { callClaude: fakeCallClaude });
    } catch (err) {
      lastErrorCode = err.code;
    }
  }
  assert.equal(lastErrorCode, 'rate_limited');
});
