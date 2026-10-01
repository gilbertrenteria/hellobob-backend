// Thin Twilio REST API client using nothing but built-in `fetch` and
// `node:crypto` — the official `twilio` npm package isn't needed for what
// this backend does (send an SMS, validate an inbound webhook signature).
// If you later want call recordings, TwiML Bins, or other advanced features,
// swapping in the real SDK is a drop-in change scoped to this one file.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { escapeHtml } from '../util/html.js';

const API_BASE = 'https://api.twilio.com/2010-04-01';

function authHeader() {
  const token = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Send an SMS. In dry-run mode (no Twilio credentials configured yet) this
 * just logs what would have been sent, so the rest of the app can be built
 * and tested before you've finished Twilio/A2P 10DLC setup.
 */
export async function sendSms(toE164, body) {
  if (config.dryRun) {
    console.log(`[DRY RUN] Would send SMS to ${toE164}: ${body}`);
    return { sid: 'DRYRUN', status: 'dry_run' };
  }
  // Claude may be live (ANTHROPIC_API_KEY set) while Twilio isn't set up
  // yet — e.g. the public demo. Log and skip rather than throw, so the
  // conversation is still recorded and the dashboard still shows it.
  if (!config.twilioConfigured) {
    console.log(`[twilio] not configured (TWILIO_* unset) — skipped SMS to ${toE164}: ${body}`);
    return { sid: 'SKIPPED', status: 'skipped_unconfigured' };
  }

  const params = new URLSearchParams({
    To: toE164,
    From: config.twilioFromNumber,
    Body: body,
  });

  const res = await fetch(`${API_BASE}/Accounts/${config.twilioAccountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Twilio send failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data; // includes .sid, .status
}

/**
 * Validate that an incoming webhook request really came from Twilio.
 * Implements Twilio's documented signature algorithm without their SDK:
 * HMAC-SHA1(authToken, url + sorted "key"+"value" pairs), base64-encoded,
 * compared to the X-Twilio-Signature header.
 *
 * @param {string} url          the exact URL Twilio requested (see README —
 *                               must match byte-for-byte, including query string)
 * @param {Record<string,string>} params  the parsed form body
 * @param {string} signatureHeader  value of the X-Twilio-Signature header
 */
export function isValidTwilioSignature(url, params, signatureHeader) {
  if (config.dryRun) return true; // no real Twilio traffic to validate yet
  if (!signatureHeader) return false;

  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = createHmac('sha1', config.twilioAuthToken).update(Buffer.from(data, 'utf-8')).digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Minimal TwiML response so Twilio's voice webhook gets a valid reply. */
export function emptyVoiceResponseXml() {
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

/**
 * Forwards an incoming call to the owner's real phone, with a "whisper" —
 * a short message only the owner hears (the caller just hears normal
 * ringing) confirming this is a HelloBob business call before they're
 * bridged in. `whisperUrl` is this same server's own /webhooks/voice-whisper
 * endpoint (built in webhooks.js) — Twilio fetches it fresh the moment the
 * owner picks up. `answerOnBridge="true"` is what delays "answered" from the
 * caller's perspective until after the whisper + bridge, not the instant the
 * owner's phone picks up — without it the whisper itself would count as
 * billable/answered time and the caller could hear a sliver of dead air.
 * If the owner doesn't pick up, Twilio reports this call as no-answer, which
 * re-invokes handleIncomingVoice and falls into the existing missed-call
 * text-back path below — no separate "missed" handling needed here.
 */
export function dialWithWhisperXml(ownerPhoneE164, whisperUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true"><Number url="${escapeHtml(whisperUrl)}">${escapeHtml(ownerPhoneE164)}</Number></Dial></Response>`;
}

/** The whisper TwiML itself — played only to the owner, only once they answer. */
export function whisperXml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeHtml(message)}</Say></Response>`;
}

// ---- HelloBob support/sales voice line (telephony/supportVoiceWebhooks.js) -
// A completely separate call flow from everything above: this is "Bob from
// HelloBob" answering calls to GILBERT's own support/sales number (people
// asking about or already using HelloBob), not a per-business customer line.
// A single neural voice, picked once here so every prompt in that flow
// sounds consistent — swap this one constant to change it everywhere.
export const SUPPORT_VOICE = 'Polly.Gregory-Neural';

/**
 * One turn of the support line's back-and-forth: say something, then listen
 * for the caller's next sentence. `actionOnEmptyResult="true"` is the part
 * that's easy to miss — without it, Twilio silently skips `action` on a
 * timeout (no speech heard) and just falls through to whatever TwiML verb
 * comes next, so a quiet caller would get no response at all instead of
 * being re-prompted. With it, our action route always gets a hit — with an
 * empty SpeechResult — so the silence-handling logic lives in one place
 * (supportVoiceWebhooks.js's turn handler), not duplicated in TwiML.
 */
export function gatherSpeechXml({ sayText, actionUrl, timeoutSeconds = 6 }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="speech" action="${escapeHtml(actionUrl)}" method="POST" speechTimeout="auto" timeout="${timeoutSeconds}" actionOnEmptyResult="true">` +
    `<Say voice="${SUPPORT_VOICE}">${escapeHtml(sayText)}</Say>` +
    `</Gather>` +
    `</Response>`
  );
}

/** Same idea as gatherSpeechXml, but also accepts a single keypress — used for the "callback vs. voice message" menu. */
export function gatherSpeechOrDigitXml({ sayText, actionUrl, timeoutSeconds = 6 }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="speech dtmf" numDigits="1" action="${escapeHtml(actionUrl)}" method="POST" speechTimeout="auto" timeout="${timeoutSeconds}" actionOnEmptyResult="true">` +
    `<Say voice="${SUPPORT_VOICE}">${escapeHtml(sayText)}</Say>` +
    `</Gather>` +
    `</Response>`
  );
}

/**
 * The "leave a voice message" path. `transcribe`/`transcribeCallback` queue
 * Twilio's own speech-to-text (English only, recordings under 2 minutes —
 * see maxLength) as a SEPARATE async callback that can land seconds after
 * the call has already ended; recording-complete (this response's `action`)
 * fires first, as soon as the caller stops talking, and is what we use to
 * notify Gilbert right away so he isn't waiting on transcription to hear
 * about it.
 */
export function recordVoiceMessageXml({ sayText, actionUrl, transcribeCallbackUrl }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say voice="${SUPPORT_VOICE}">${escapeHtml(sayText)}</Say>` +
    `<Record action="${escapeHtml(actionUrl)}" method="POST" maxLength="120" playBeep="true" trim="trim-silence" ` +
    `transcribe="true" transcribeCallback="${escapeHtml(transcribeCallbackUrl)}" />` +
    `</Response>`
  );
}

/** Says a final line, then ends the call — used once a callback/voice-message has been captured. */
export function sayAndHangupXml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${SUPPORT_VOICE}">${escapeHtml(message)}</Say><Hangup/></Response>`;
}

/**
 * Fetches a call recording's actual audio bytes from Twilio, using this
 * account's own credentials — this is what lets /api/admin/voice-messages/:id
 * hand Gilbert a working link without him ever needing Twilio credentials
 * himself. Recordings are never downloaded or stored anywhere else; this is
 * called on demand, each time that link is opened.
 */
export async function fetchRecordingAudio(recordingSid) {
  if (!config.twilioConfigured) {
    return { ok: false, status: 404 };
  }
  const res = await fetch(`${API_BASE}/Accounts/${config.twilioAccountSid}/Recordings/${recordingSid}.mp3`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { ok: true, status: 200, buffer, contentType: 'audio/mpeg' };
}
