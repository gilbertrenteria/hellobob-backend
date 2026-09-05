// Shared by both ways a marketing-site visitor can sign up for HelloBob:
// the "Ask Bob" chat's capture_signup tool call (webchat/websiteChat.js)
// and the plain on-page sign-up form (routes/signup.js). Both funnel into
// the exact same place — this backend's own `signups` table, plus the same
// two automatic emails — so it never matters to Gilbert which one a given
// customer used.

import { config } from './config.js';
import { createSignup } from './db.js';
import { sendEmail } from './email/resend.js';

export class SignupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function welcomeEmailHtml(businessName) {
  return `
    <p>Hi there,</p>
    <p>Thanks for signing up for HelloBob for <strong>${escapeHtml(businessName)}</strong>! You're officially in.</p>
    <p>Next step: a short setup questionnaire so we can build Bob around exactly how your business runs — your hours, pricing, services, and a few other details. It takes about 10&ndash;15 minutes, and you can save and finish later if you need to.</p>
    <p><a href="${config.jotformQuestionnaireUrl}" style="display:inline-block;background:#E5231A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Fill out your setup questionnaire</a></p>
    <p>Once we get that back, we'll build your system and follow up with next steps.</p>
    <p>&mdash; The HelloBob team</p>
  `;
}

function notifyEmailHtml({ businessName, contactEmail, contactPhone, source }) {
  return `
    <p>New HelloBob signup (${escapeHtml(source)}):</p>
    <ul>
      <li><strong>Business:</strong> ${escapeHtml(businessName)}</li>
      <li><strong>Email:</strong> ${escapeHtml(contactEmail)}</li>
      <li><strong>Phone:</strong> ${escapeHtml(contactPhone)}</li>
    </ul>
  `;
}

/**
 * @param {object} opts
 * @param {string} opts.businessName
 * @param {string} opts.contactEmail
 * @param {string} opts.contactPhone
 * @param {'website_chat'|'website_form'} opts.source
 * @param {object} [deps] injectable for tests — see websiteChat.js's own deps note
 * @returns {Promise<{signup: {id:number}, questionnaireUrl: string}>}
 */
export async function captureSignup({ businessName, contactEmail, contactPhone, source }, deps = {}) {
  const {
    createSignup: createSignupFn = createSignup,
    sendEmail: sendEmailFn = sendEmail,
  } = deps;

  if (!businessName || !contactEmail || !contactPhone) {
    throw new SignupError('bad_request', 'businessName, contactEmail, and contactPhone are all required');
  }

  const signup = createSignupFn({ businessName, contactEmail, contactPhone, source });

  // Best-effort — a failed email never blocks the signup from being saved
  // (sendEmail() itself never throws; see email/resend.js).
  await Promise.all([
    sendEmailFn({
      to: contactEmail,
      subject: 'Welcome to HelloBob — your setup questionnaire',
      html: welcomeEmailHtml(businessName),
    }),
    sendEmailFn({
      to: config.notifyEmail,
      subject: `New HelloBob signup: ${businessName}`,
      html: notifyEmailHtml({ businessName, contactEmail, contactPhone, source }),
    }),
  ]);

  return { signup: { id: signup.id }, questionnaireUrl: config.jotformQuestionnaireUrl };
}
