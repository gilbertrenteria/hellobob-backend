// Thin Twilio REST API client using nothing but built-in `fetch` and
// `node:crypto` — the official `twilio` npm package isn't needed for what
// this backend does (send an SMS, validate an inbound webhook signature).
// If you later want call recordings, TwiML Bins, or other advanced features,
// swapping in the real SDK is a drop-in change scoped to this one file.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

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
