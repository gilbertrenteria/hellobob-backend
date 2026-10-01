// Covers the HelloBob support/sales phone line (telephony/supportVoiceWebhooks.js)
// — Gilbert's own prospects/customers calling in, NOT a subscriber
// business's customer line (that's webhooks.integration.test.js). Own
// process/env (node --test isolates each file) so ADMIN_KEY and
// OWNER_FORWARD_PHONE here don't leak into other test files.

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';
process.env.PORT = '0';
process.env.ADMIN_KEY = 'testkey123';
process.env.OWNER_FORWARD_PHONE = '+16195550199';
process.env.PUBLIC_BASE_URL = 'https://hellobob-backend.onrender.com';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const {
  handleSupportVoiceIncoming,
  handleSupportVoiceTurn,
  handleSupportVoiceEscalateChoice,
  handleSupportVoiceCallbackName,
  handleSupportVoiceRecordingComplete,
  handleSupportVoiceTranscriptionComplete,
} = await import('../src/telephony/supportVoiceWebhooks.js');
const { getSupportRequest, getSupportRequestByRecordingSid } = await import('../src/db.js');

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

function params(overrides = {}) {
  return { CallSid: 'CA_test_1', From: '+16195551234', ...overrides };
}

// ---- HTTP-level smoke test: real server, real dry-run Claude ----

test('a fresh call to the support line gets Bob\'s greeting and a Gather pointed at /turn', async () => {
  const res = await fetch(`${baseUrl}/webhooks/support-voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params({ CallSid: 'CA_http_1' })),
  });
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /Bob from HelloBob/);
  assert.match(xml, /action="https:\/\/hellobob-backend\.onrender\.com\/webhooks\/support-voice\/turn"/);
});

// ---- Handler-level: injected fake Claude so escalation is deterministic ----

test('a normal question keeps the Q&A loop going (no handoff tool call)', async () => {
  const fakeCallClaude = async () => ({ text: "It's a flat $197 a month, no contract.", toolCalls: [] });
  const result = await handleSupportVoiceTurn(
    { url: 'x', params: params({ CallSid: 'CA_qa_1', SpeechResult: 'how much does this cost' }), signatureHeader: 'sig' },
    { callClaude: fakeCallClaude }
  );
  assert.equal(result.status, 200);
  assert.match(result.body, /\$197 a month/);
  assert.match(result.body, /action="https:\/\/hellobob-backend\.onrender\.com\/webhooks\/support-voice\/turn"/);
});

test('two silences in a row moves straight to the callback/voice-message menu', async () => {
  const callSid = 'CA_silence_1';
  const first = await handleSupportVoiceTurn({ url: 'x', params: params({ CallSid: callSid, SpeechResult: '' }), signatureHeader: 'sig' });
  assert.match(first.body, /didn&#39;t catch that/);

  const second = await handleSupportVoiceTurn({ url: 'x', params: params({ CallSid: callSid, SpeechResult: '' }), signatureHeader: 'sig' });
  assert.match(second.body, /press 1/);
  assert.match(second.body, /press 2/);
  assert.match(second.body, /escalate-choice/);
});

test('the model calling request_human_handoff moves straight to the menu, with its own reason', async () => {
  const fakeCallClaude = async () => ({
    text: 'Let me get you connected.',
    toolCalls: [{ name: 'request_human_handoff', input: { reason: 'billing dispute' } }],
  });
  const result = await handleSupportVoiceTurn(
    { url: 'x', params: params({ CallSid: 'CA_handoff_1', SpeechResult: 'I was charged twice, I need to talk to someone' }), signatureHeader: 'sig' },
    { callClaude: fakeCallClaude }
  );
  assert.equal(result.status, 200);
  assert.match(result.body, /escalate-choice/);
  assert.match(result.body, /press 1/);
});

// ---- Escalation menu branching ----

test('pressing 1 asks for a name (callback path)', async () => {
  const result = await handleSupportVoiceEscalateChoice({ url: 'x', params: params({ Digits: '1' }), signatureHeader: 'sig' });
  assert.match(result.body, /what&#39;s your name/);
  assert.match(result.body, /callback-name/);
});

test('saying "voicemail" goes straight to recording (voice message path)', async () => {
  const result = await handleSupportVoiceEscalateChoice({ url: 'x', params: params({ SpeechResult: 'voicemail please' }), signatureHeader: 'sig' });
  assert.match(result.body, /<Record /);
  assert.match(result.body, /transcribeCallback="https:\/\/hellobob-backend\.onrender\.com\/webhooks\/support-voice\/transcription-complete"/);
});

test('an unrecognized answer re-asks once, then defaults to a voice message', async () => {
  const callSid = 'CA_unclear_1';
  const first = await handleSupportVoiceEscalateChoice({ url: 'x', params: params({ CallSid: callSid, SpeechResult: 'uh what' }), signatureHeader: 'sig' });
  assert.match(first.body, /press 1/);

  const second = await handleSupportVoiceEscalateChoice({ url: 'x', params: params({ CallSid: callSid, SpeechResult: 'still unclear' }), signatureHeader: 'sig' });
  assert.match(second.body, /<Record /);
});

// ---- Callback path: logs the request and notifies Gilbert on both channels ----

test('giving a name for a callback saves the request and notifies Gilbert by email + text', async () => {
  const emailsSent = [];
  const smsSent = [];
  const result = await handleSupportVoiceCallbackName(
    { url: 'x', params: params({ CallSid: 'CA_callback_1', SpeechResult: 'Jane Smith' }), signatureHeader: 'sig' },
    {
      sendEmailFn: async (opts) => { emailsSent.push(opts); return { sent: true }; },
      sendSmsFn: async (to, body) => { smsSent.push({ to, body }); return { sid: 'SM_fake' }; },
    }
  );
  assert.match(result.body, /Jane Smith/);
  assert.match(result.body, /<Hangup\/>/);

  assert.equal(emailsSent.length, 1);
  assert.match(emailsSent[0].html, /Jane Smith/);
  assert.equal(smsSent.length, 1);
  assert.equal(smsSent[0].to, '+16195550199'); // OWNER_FORWARD_PHONE
  assert.match(smsSent[0].body, /Jane Smith/);
});

// ---- Voice message path: logs immediately, transcript arrives later ----

test('a completed recording is logged and Gilbert is notified with a playback link, transcript pending', async () => {
  const emailsSent = [];
  const result = await handleSupportVoiceRecordingComplete(
    { url: 'x', params: params({ CallSid: 'CA_vm_1', RecordingSid: 'RE_fake_1', RecordingDuration: '37' }), signatureHeader: 'sig' },
    { sendEmailFn: async (opts) => { emailsSent.push(opts); return { sent: true }; }, sendSmsFn: async () => ({ sid: 'SM_fake' }) }
  );
  assert.match(result.body, /<Hangup\/>/);
  assert.equal(emailsSent.length, 1);
  assert.match(emailsSent[0].html, /\/api\/admin\/voice-messages\/\d+\?key=testkey123/);

  const saved = getSupportRequestByRecordingSid('RE_fake_1');
  assert.ok(saved);
  assert.equal(saved.kind, 'voice_message');
  assert.equal(saved.recording_duration_seconds, 37);
  assert.equal(saved.transcript, null);
});

test('the transcription callback fills in the transcript and sends a follow-up notification', async () => {
  await handleSupportVoiceRecordingComplete(
    { url: 'x', params: params({ CallSid: 'CA_vm_2', RecordingSid: 'RE_fake_2', RecordingDuration: '12' }), signatureHeader: 'sig' },
    { sendEmailFn: async () => ({ sent: true }), sendSmsFn: async () => ({ sid: 'SM_fake' }) }
  );

  const emailsSent = [];
  const result = await handleSupportVoiceTranscriptionComplete(
    { url: 'x', params: { RecordingSid: 'RE_fake_2', TranscriptionText: 'Hey, I need help resetting my dashboard password.', TranscriptionStatus: 'completed' }, signatureHeader: 'sig' },
    { sendEmailFn: async (opts) => { emailsSent.push(opts); return { sent: true }; }, sendSmsFn: async () => ({ sid: 'SM_fake' }) }
  );
  assert.equal(result.status, 200);

  const saved = getSupportRequestByRecordingSid('RE_fake_2');
  assert.match(saved.transcript, /resetting my dashboard password/);
  assert.equal(emailsSent.length, 1);
  assert.match(emailsSent[0].html, /resetting my dashboard password/);
});

test('a transcription callback for an unknown recording is acknowledged, not an error', async () => {
  const result = await handleSupportVoiceTranscriptionComplete({
    url: 'x',
    params: { RecordingSid: 'RE_never_created', TranscriptionText: 'whatever', TranscriptionStatus: 'completed' },
    signatureHeader: 'sig',
  });
  assert.equal(result.status, 200);
});

// ---- Admin playback route ----

test('voice-messages playback is hidden without the right admin key', async () => {
  const res = await fetch(`${baseUrl}/api/admin/voice-messages/1?key=wrong`);
  assert.equal(res.status, 404);
});

test('voice-messages playback 404s for an id that does not exist', async () => {
  const res = await fetch(`${baseUrl}/api/admin/voice-messages/999999?key=testkey123`);
  assert.equal(res.status, 404);
});

test('voice-messages playback finds the row but fails upstream when Twilio is not configured (dry run)', async () => {
  const request = await handleSupportVoiceRecordingComplete(
    { url: 'x', params: params({ CallSid: 'CA_vm_3', RecordingSid: 'RE_fake_3', RecordingDuration: '8' }), signatureHeader: 'sig' },
    { sendEmailFn: async () => ({ sent: true }), sendSmsFn: async () => ({ sid: 'SM_fake' }) }
  );
  const saved = getSupportRequestByRecordingSid('RE_fake_3');
  const res = await fetch(`${baseUrl}/api/admin/voice-messages/${saved.id}?key=testkey123`);
  // DRY_RUN means twilioConfigured is false, so fetchRecordingAudio() can't
  // actually reach Twilio — this confirms the route gets as far as trying,
  // rather than 404ing for the wrong reason.
  assert.equal(res.status, 502);
});
