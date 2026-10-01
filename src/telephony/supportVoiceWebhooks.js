// Webhook handlers for the HelloBob support/sales phone line — Gilbert's own
// prospects and customers calling in to ask about or get help with
// HelloBob, answered first by AI ("Bob, from HelloBob"), with two ways to
// reach Gilbert directly if that's not enough: a logged callback request, or
// a recorded (and transcribed) voice message. Entirely separate from
// telephony/webhooks.js, which handles each SUBSCRIBER BUSINESS's own
// customer-facing number — different number, different system prompt,
// different escalation path, on purpose. See db.js's support_requests table.
//
// Same HTTP-framework-agnostic shape as webhooks.js: each handler takes
// `{ url, params, signatureHeader }` and returns `{ status, body }`, so
// server.js stays the only place that knows about node:http.

import { config } from '../config.js';
import {
  isValidTwilioSignature,
  gatherSpeechXml,
  gatherSpeechOrDigitXml,
  recordVoiceMessageXml,
  sayAndHangupXml,
} from './twilio.js';
import { sendSms } from './twilio.js';
import { sendEmail } from '../email/resend.js';
import { createSupportRequest, getSupportRequestByRecordingSid, setSupportRequestTranscript } from '../db.js';
import { runSupportTurn } from '../ai/supportConversationEngine.js';
import { escapeHtml } from '../util/html.js';

const GREETING = "Thanks for calling HelloBob — the 24/7 front desk that answers every call, even the ones you miss. We text your customers back in seconds, book the job, and keep you compliant, so no lead ever slips through the cracks. This is Bob from HelloBob — what can I do for you today?";
const MAX_TURNS = 6; // bounds both the call length and the Claude usage per call
const STALE_CALL_MS = 10 * 60 * 1000; // 10 minutes — see pruneStaleCalls below

// In-memory per-call conversation state, keyed by Twilio's CallSid. This is
// a deliberate simplification (same spirit as the rest of this
// zero-dependency backend): a call lasts a couple of minutes at most, so
// keeping its transcript in memory for that window is simpler than a DB
// round-trip on every turn, and if the process restarts mid-call the turn
// handler below degrades to "start the conversation over" rather than
// crashing — an acceptable trade for how rarely that'll actually happen.
const callState = new Map();

function pruneStaleCalls() {
  const cutoff = Date.now() - STALE_CALL_MS;
  for (const [sid, state] of callState) {
    if (state.lastTouched < cutoff) callState.delete(sid);
  }
}

function urlFor(path) {
  return `${config.publicBaseUrl}${path}`;
}

async function notifyGilbert({ subject, smsText, emailHtml }, deps = {}) {
  const { sendEmailFn = sendEmail, sendSmsFn = sendSms } = deps;
  const sends = [sendEmailFn({ to: config.notifyEmail, subject, html: emailHtml }).catch(() => {})];
  // ownerForwardPhone is Gilbert's real cell (see config.js) — already the
  // number this same codebase forwards per-business calls to, reused here
  // as "where to text Gilbert" since it's exactly that.
  if (config.ownerForwardPhone) {
    sends.push(
      sendSmsFn(config.ownerForwardPhone, smsText).catch((err) => {
        console.error('[support-voice] notify SMS failed:', err.message);
      })
    );
  }
  await Promise.all(sends);
}

/** Incoming call to the dedicated HelloBob support/sales number. */
export async function handleSupportVoiceIncoming({ url, params, signatureHeader }) {
  if (!isValidTwilioSignature(url, params, signatureHeader)) {
    return { status: 403, body: 'invalid signature' };
  }
  pruneStaleCalls();

  const callSid = params.CallSid;
  callState.set(callSid, { history: [], turns: 0, silences: 0, escalateAttempts: 0, escalationReason: null, lastTouched: Date.now() });

  return {
    status: 200,
    body: gatherSpeechXml({ sayText: GREETING, actionUrl: urlFor('/webhooks/support-voice/turn') }),
  };
}

function escalationOfferXml() {
  return gatherSpeechOrDigitXml({
    sayText:
      "I can do one of two things. Say or press 1 and I'll have Gilbert call you back. " +
      "Say or press 2 to leave a voice message explaining what's going on, and he'll get that too.",
    actionUrl: urlFor('/webhooks/support-voice/escalate-choice'),
  });
}

/** One turn of the Q&A loop: the caller just said something (or stayed silent). */
export async function handleSupportVoiceTurn({ url, params, signatureHeader }, deps = {}) {
  if (!isValidTwilioSignature(url, params, signatureHeader)) {
    return { status: 403, body: 'invalid signature' };
  }

  const callSid = params.CallSid;
  const state = callState.get(callSid) || { history: [], turns: 0, silences: 0, escalateAttempts: 0, escalationReason: null, lastTouched: Date.now() };
  state.lastTouched = Date.now();
  callState.set(callSid, state);

  const speech = (params.SpeechResult || '').trim();

  if (!speech) {
    state.silences += 1;
    if (state.silences >= 2) {
      return { status: 200, body: escalationOfferXml() };
    }
    return {
      status: 200,
      body: gatherSpeechXml({
        sayText: "Sorry, I didn't catch that — could you say that again?",
        actionUrl: urlFor('/webhooks/support-voice/turn'),
      }),
    };
  }

  state.silences = 0;
  state.history.push({ role: 'user', content: speech });
  state.turns += 1;

  const { reply, wantsHuman, reason } = await runSupportTurn(state.history, deps);
  state.history.push({ role: 'assistant', content: reply });

  if (wantsHuman || state.turns >= MAX_TURNS) {
    state.escalationReason = reason || (state.turns >= MAX_TURNS ? 'Call ran long without resolving' : null);
    return {
      status: 200,
      body: gatherSpeechOrDigitXml({
        sayText: `${reply} ${state.turns >= MAX_TURNS && !wantsHuman ? "Let's get you to Gilbert directly. " : ''}` +
          "Say or press 1 and I'll have him call you back, or say or press 2 to leave a voice message.",
        actionUrl: urlFor('/webhooks/support-voice/escalate-choice'),
      }),
    };
  }

  return {
    status: 200,
    body: gatherSpeechXml({ sayText: reply, actionUrl: urlFor('/webhooks/support-voice/turn') }),
  };
}

function wantsCallback(params) {
  const digit = (params.Digits || '').trim();
  const speech = (params.SpeechResult || '').trim().toLowerCase();
  return digit === '1' || /\b(call\s*back|callback|one|first)\b/.test(speech);
}

function wantsVoiceMessage(params) {
  const digit = (params.Digits || '').trim();
  const speech = (params.SpeechResult || '').trim().toLowerCase();
  return digit === '2' || /\b(message|voicemail|voice\s*mail|two|second)\b/.test(speech);
}

/** The caller just answered "callback or voice message?" (by speech or keypress). */
export async function handleSupportVoiceEscalateChoice({ url, params, signatureHeader }) {
  if (!isValidTwilioSignature(url, params, signatureHeader)) {
    return { status: 403, body: 'invalid signature' };
  }

  const callSid = params.CallSid;
  const state = callState.get(callSid) || { escalateAttempts: 0 };

  if (wantsCallback(params)) {
    return {
      status: 200,
      body: gatherSpeechXml({ sayText: "Sure — what's your name?", actionUrl: urlFor('/webhooks/support-voice/callback-name') }),
    };
  }

  if (wantsVoiceMessage(params)) {
    return {
      status: 200,
      body: recordVoiceMessageXml({
        sayText: "Go ahead after the tone — press pound or just stay quiet for a moment when you're done.",
        actionUrl: urlFor('/webhooks/support-voice/recording-complete'),
        transcribeCallbackUrl: urlFor('/webhooks/support-voice/transcription-complete'),
      }),
    };
  }

  state.escalateAttempts = (state.escalateAttempts || 0) + 1;
  callState.set(callSid, state);
  // Didn't understand the choice — ask once more, then default to the
  // voice message path rather than leaving the caller stuck in a loop.
  if (state.escalateAttempts < 2) {
    return { status: 200, body: escalationOfferXml() };
  }
  return {
    status: 200,
    body: recordVoiceMessageXml({
      sayText: "Let's just get a quick message — go ahead after the tone.",
      actionUrl: urlFor('/webhooks/support-voice/recording-complete'),
      transcribeCallbackUrl: urlFor('/webhooks/support-voice/transcription-complete'),
    }),
  };
}

function notifyEmailHtml(title, rows) {
  const items = rows.map(([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${value}</li>`).join('');
  return `<p>${escapeHtml(title)}</p><ul>${items}</ul>`;
}

/** Caller gave their name for a callback — log the request and notify Gilbert. */
export async function handleSupportVoiceCallbackName({ url, params, signatureHeader }, deps = {}) {
  if (!isValidTwilioSignature(url, params, signatureHeader)) {
    return { status: 403, body: 'invalid signature' };
  }

  const callSid = params.CallSid;
  const state = callState.get(callSid);
  const name = (params.SpeechResult || '').trim() || '(name not captured)';
  const reason = state?.escalationReason || 'General support inquiry';

  const { createSupportRequestFn = createSupportRequest } = deps;
  const request = createSupportRequestFn({ kind: 'callback', callSid, phoneE164: params.From, name, reason });

  await notifyGilbert(
    {
      subject: `HelloBob support: callback requested — ${name}`,
      smsText: `HelloBob support call: ${name} (${params.From}) wants a callback — ${reason}`,
      emailHtml: notifyEmailHtml('New HelloBob support callback request:', [
        ['Name', escapeHtml(name)],
        ['Phone', escapeHtml(params.From)],
        ['Reason', escapeHtml(reason)],
      ]),
    },
    deps
  );

  callState.delete(callSid);
  return {
    status: 200,
    body: sayAndHangupXml(`Thanks, ${name} — Gilbert will call you back at this number shortly. Have a good one!`),
  };
}

/** The recording just stopped — this fires before transcription is ready, so notify right away with a playback link. */
export async function handleSupportVoiceRecordingComplete({ url, params, signatureHeader }, deps = {}) {
  if (!isValidTwilioSignature(url, params, signatureHeader)) {
    return { status: 403, body: 'invalid signature' };
  }

  const { createSupportRequestFn = createSupportRequest } = deps;
  const durationSeconds = Number(params.RecordingDuration || 0);
  const request = createSupportRequestFn({
    kind: 'voice_message',
    callSid: params.CallSid,
    phoneE164: params.From,
    recordingSid: params.RecordingSid,
    recordingDurationSeconds: durationSeconds,
  });

  const playbackUrl = config.adminKey
    ? `${config.publicBaseUrl}/api/admin/voice-messages/${request.id}?key=${config.adminKey}`
    : null;

  await notifyGilbert(
    {
      subject: `HelloBob support: voice message left (${durationSeconds}s)`,
      smsText: `HelloBob support voicemail, ${durationSeconds}s, from ${params.From}.${playbackUrl ? ` Listen: ${playbackUrl}` : ''} Transcript coming shortly.`,
      emailHtml: notifyEmailHtml('New HelloBob support voice message:', [
        ['From', escapeHtml(params.From)],
        ['Length', `${durationSeconds} seconds`],
        ['Listen', playbackUrl ? `<a href="${playbackUrl}">${playbackUrl}</a>` : 'set ADMIN_KEY to get a playback link'],
        ['Transcript', 'pending — a follow-up notification will include it shortly'],
      ]),
    },
    deps
  );

  callState.delete(params.CallSid);
  return { status: 200, body: sayAndHangupXml('Got it, thanks — Gilbert will get back to you soon.') };
}

/**
 * Fires asynchronously once Twilio's speech-to-text finishes — NOT tied to
 * an active call anymore (the caller already hung up), so this returns a
 * bare 200 with no TwiML; Twilio doesn't do anything with the response body.
 */
export async function handleSupportVoiceTranscriptionComplete({ url, params, signatureHeader }, deps = {}) {
  if (!isValidTwilioSignature(url, params, signatureHeader)) {
    return { status: 403, body: 'invalid signature' };
  }

  const { getSupportRequestByRecordingSidFn = getSupportRequestByRecordingSid, setSupportRequestTranscriptFn = setSupportRequestTranscript } = deps;
  const request = getSupportRequestByRecordingSidFn(params.RecordingSid);
  if (!request) {
    // Nothing to attach it to (e.g. the row was somehow never created) —
    // acknowledge anyway so Twilio doesn't retry forever.
    return { status: 200, body: 'ok' };
  }

  const transcript = params.TranscriptionStatus === 'completed' ? params.TranscriptionText || '' : null;
  setSupportRequestTranscriptFn(request.id, transcript);

  if (transcript) {
    await notifyGilbert(
      {
        subject: `HelloBob support: voicemail transcript ready`,
        smsText: `HelloBob voicemail transcript (${request.phone_e164}): "${transcript.slice(0, 280)}"`,
        emailHtml: notifyEmailHtml(`Transcript for the voice message from ${escapeHtml(request.phone_e164)}:`, [
          ['Transcript', escapeHtml(transcript)],
        ]),
      },
      deps
    );
  }

  return { status: 200, body: 'ok' };
}

// Exposed for tests only — lets a test assert on/clear in-memory call state
// without reaching into module internals another way.
export const _internalsForTests = { callState };
