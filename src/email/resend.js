// Minimal Resend (https://resend.com) client using nothing but built-in
// `fetch` — same zero-dependency approach as ai/claude.js and
// telephony/twilio.js. One HTTP call, no SDK.

import { config } from '../config.js';

const API_URL = 'https://api.resend.com/emails';

/**
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @returns {Promise<{sent: boolean}>}
 */
export async function sendEmail({ to, subject, html }) {
  if (!config.resendApiKey) {
    console.log(`[DRY RUN — no RESEND_API_KEY set] Would email "${subject}" to ${to}`);
    return { sent: false };
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // Email failures are logged, never thrown — a signup should still
    // succeed and be saved even if the notification email fails to send.
    console.error(`[email] Resend error (${res.status}) sending "${subject}" to ${to}:`, data.message || data);
    return { sent: false };
  }

  return { sent: true };
}
