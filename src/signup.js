// Shared by both ways a marketing-site visitor can sign up for HelloBob:
// the "Ask Bob" chat's capture_signup tool call (webchat/websiteChat.js)
// and the plain on-page sign-up form (docs/index.html's #signupSteps).
// Both funnel into the exact same place — this backend's own `signups`
// table, plus the same welcome message — so it never matters to Gilbert
// which one a given customer used.
//
// The welcome message links to our OWN Guided Setup page (docs/setup.html,
// submitting to POST /api/setup — see setupForms.js), not a third-party
// form of any kind. The customer fills it out on their own time during the
// 10-day trial; see reminders.js for the automatic day-2/5/8 nudges if they
// haven't.

import { config } from './config.js';
import { createSignup } from './db.js';
import { sendEmail } from './email/resend.js';
import { sendSms } from './telephony/twilio.js';
import { escapeHtml } from './util/html.js';

export class SignupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function setupUrlFor(signup) {
  return `${config.siteBaseUrl}/setup.html?t=${signup.setup_token}`;
}

function welcomeEmailHtml(businessName, setupUrl) {
  return `
    <p>Hi there,</p>
    <p>Thanks for signing up for HelloBob for <strong>${escapeHtml(businessName)}</strong>! You're officially in — your free 10-day trial has started, no card needed.</p>
    <p>Next step: Guided Setup, a short questionnaire so we can build Bob around exactly how your business runs — your hours, pricing, services, and a few other details. It takes about 10&ndash;15 minutes, and you can fill it out whenever works for you during your trial &mdash; your answers save as you go.</p>
    <p><a href="${setupUrl}" style="display:inline-block;background:#E5231A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Start Guided Setup</a></p>
    <p>Once we get that back, we'll build your system and follow up with next steps.</p>
    <p>&mdash; The HelloBob team</p>
  `;
}

function welcomeSmsText(businessName, setupUrl) {
  return `HelloBob: Thanks for signing up, ${businessName}! Your free 10-day trial has started. When you're ready, finish Guided Setup here (takes ~10-15 min, save & finish anytime): ${setupUrl}`;
}

function notifyEmailHtml({ businessName, contactEmail, contactPhone, contactPref, source }) {
  return `
    <p>New HelloBob signup (${escapeHtml(source)}):</p>
    <ul>
      <li><strong>Business:</strong> ${escapeHtml(businessName)}</li>
      <li><strong>Email:</strong> ${escapeHtml(contactEmail)}</li>
      <li><strong>Phone:</strong> ${escapeHtml(contactPhone)}</li>
      <li><strong>Wants their setup link by:</strong> ${escapeHtml(contactPref)}</li>
    </ul>
  `;
}

/**
 * @param {object} opts
 * @param {string} opts.businessName
 * @param {string} opts.contactEmail
 * @param {string} opts.contactPhone
 * @param {'email'|'text'} [opts.contactPref] defaults to 'email'
 * @param {'website_chat'|'website_form'} opts.source
 * @param {object} [deps] injectable for tests
 * @returns {Promise<{signup: {id:number}, setupUrl: string}>}
 */
export async function captureSignup({ businessName, contactEmail, contactPhone, contactPref, source }, deps = {}) {
  const {
    createSignup: createSignupFn = createSignup,
    sendEmail: sendEmailFn = sendEmail,
    sendSms: sendSmsFn = sendSms,
  } = deps;

  if (!businessName || !contactEmail || !contactPhone) {
    throw new SignupError('bad_request', 'businessName, contactEmail, and contactPhone are all required');
  }

  const pref = contactPref === 'text' ? 'text' : 'email';
  const signup = createSignupFn({ businessName, contactEmail, contactPhone, contactPref: pref, source });
  const setupUrl = setupUrlFor(signup);

  // Best-effort — a failed send never blocks the signup from being saved.
  // sendEmail() never throws (see email/resend.js); sendSms() logs and
  // skips instead of throwing when Twilio isn't configured yet (see
  // telephony/twilio.js) — the .catch() here is only for an unexpected
  // Twilio API error, so one bad send still leaves the others in flight.
  const sends = [
    sendEmailFn({
      to: contactEmail,
      subject: 'Welcome to HelloBob — start your Guided Setup',
      html: welcomeEmailHtml(businessName, setupUrl),
    }),
    sendEmailFn({
      to: config.notifyEmail,
      subject: `New HelloBob signup: ${businessName}`,
      html: notifyEmailHtml({ businessName, contactEmail, contactPhone, contactPref: pref, source }),
    }),
  ];
  if (pref === 'text') {
    sends.push(
      sendSmsFn(contactPhone, welcomeSmsText(businessName, setupUrl)).catch((err) => {
        console.error('[signup] welcome SMS failed:', err.message);
      })
    );
  }
  await Promise.all(sends);

  return { signup: { id: signup.id }, setupUrl };
}
