// Handles the two real, own-domain forms a customer fills out after
// signing up: Guided Setup (docs/setup.html, POSTs here at /api/setup) and,
// conditionally, the Website Builder (docs/website-builder.html, POSTs at
// /api/website-builder). Both save the customer's answers to our own
// `setup_submissions` table (see db.js) and notify Gilbert — nothing here
// talks to Jotform or any other third-party form service.

import { config } from './config.js';
import {
  getSignupByToken,
  saveSetupSubmission,
  markGuidedSetupComplete,
  markWebsiteBuilderComplete,
} from './db.js';
import { sendEmail } from './email/resend.js';
import { escapeHtml } from './util/html.js';

export class SetupFormError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const WEBSITE_CHOICES = new Set(['no_website', 'wants_upgrade', 'has_website']);

function websiteBuilderUrlFor(signup) {
  return `${config.siteBaseUrl}/website-builder.html?t=${signup.setup_token}`;
}

function guidedSetupNotifyHtml({ signup, answers, websiteChoice, trialEndsAt }) {
  return `
    <p>${escapeHtml(signup.business_name)} just finished Guided Setup — their 10-day trial starts now and runs until ${escapeHtml(trialEndsAt)} (UTC).</p>
    <p><strong>Website:</strong> ${escapeHtml(websiteChoice)}</p>
    <p>Full answers (also saved in setup_submissions, signup id ${signup.id}):</p>
    <pre style="white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:8px;font-size:13px;">${escapeHtml(JSON.stringify(answers, null, 2))}</pre>
    <p>Review and approve from the admin signups list when ready.</p>
  `;
}

function websiteBuilderNotifyHtml({ signup }) {
  return `
    <p>${escapeHtml(signup.business_name)} just finished the Website Builder (signup id ${signup.id}). Their site content is saved in setup_submissions — open the admin signups list to review it.</p>
  `;
}

/**
 * @param {object} opts
 * @param {string} opts.token   the signup's setup_token, from ?t= in the URL
 * @param {object} opts.answers the wizard's full raw answer state (see docs/setup.html)
 * @param {string} opts.websiteChoice  one of 'no_website' | 'wants_upgrade' | 'has_website' —
 *   computed client-side from the wizard's own hasWebsite/websiteImproveInterest/
 *   websiteBuildInterest fields (which use their own 'yes'/'no' vocabulary internally;
 *   this is the normalized three-way answer the backend actually needs). Falls back to
 *   'has_website' (the safe default — no false trigger of the Website Builder follow-up)
 *   if missing or not one of the three values.
 * @param {object} [deps] injectable for tests
 */
export async function submitGuidedSetup({ token, answers, websiteChoice: rawWebsiteChoice }, deps = {}) {
  const {
    getSignupByToken: getSignupByTokenFn = getSignupByToken,
    saveSetupSubmission: saveSetupSubmissionFn = saveSetupSubmission,
    markGuidedSetupComplete: markGuidedSetupCompleteFn = markGuidedSetupComplete,
    sendEmail: sendEmailFn = sendEmail,
  } = deps;

  if (!token || typeof token !== 'string') {
    throw new SetupFormError('bad_request', 'token is required');
  }
  if (!answers || typeof answers !== 'object') {
    throw new SetupFormError('bad_request', 'answers is required');
  }

  const signup = getSignupByTokenFn(token);
  if (!signup) throw new SetupFormError('not_found', 'No signup found for this link');

  const websiteChoice = WEBSITE_CHOICES.has(rawWebsiteChoice) ? rawWebsiteChoice : 'has_website';

  saveSetupSubmissionFn({ signupId: signup.id, kind: 'guided_setup', data: answers });
  const updated = markGuidedSetupCompleteFn(signup.id, websiteChoice);

  const needsWebsiteBuilder = websiteChoice === 'no_website' || websiteChoice === 'wants_upgrade';
  const websiteBuilderUrl = needsWebsiteBuilder ? websiteBuilderUrlFor(updated) : null;

  await sendEmailFn({
    to: config.notifyEmail,
    subject: `Guided Setup complete: ${signup.business_name}`,
    html: guidedSetupNotifyHtml({ signup, answers, websiteChoice, trialEndsAt: updated.trial_ends_at }),
  });

  return {
    ok: true,
    websiteBuilderUrl,
    trialEndsAt: updated.trial_ends_at,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {object} opts.site   the builder's full site state (see docs/website-builder.html)
 * @param {object} [deps]
 */
export async function submitWebsiteBuilder({ token, site }, deps = {}) {
  const {
    getSignupByToken: getSignupByTokenFn = getSignupByToken,
    saveSetupSubmission: saveSetupSubmissionFn = saveSetupSubmission,
    markWebsiteBuilderComplete: markWebsiteBuilderCompleteFn = markWebsiteBuilderComplete,
    sendEmail: sendEmailFn = sendEmail,
  } = deps;

  if (!token || typeof token !== 'string') {
    throw new SetupFormError('bad_request', 'token is required');
  }
  if (!site || typeof site !== 'object') {
    throw new SetupFormError('bad_request', 'site is required');
  }

  const signup = getSignupByTokenFn(token);
  if (!signup) throw new SetupFormError('not_found', 'No signup found for this link');

  saveSetupSubmissionFn({ signupId: signup.id, kind: 'website_builder', data: site });
  markWebsiteBuilderCompleteFn(signup.id);

  await sendEmailFn({
    to: config.notifyEmail,
    subject: `Website Builder complete: ${signup.business_name}`,
    html: websiteBuilderNotifyHtml({ signup }),
  });

  return { ok: true };
}
