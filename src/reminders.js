// Two separate automatic-reminder tracks, both run from one hourly sweep
// (see startReminderScheduler(), called from server.js):
//
// TRACK 1 — "finish your setup" nudges (day 2/5/8 since SIGNUP). The free
// trial hasn't started yet at this point (it only starts once Guided Setup
// is actually completed — see db.js markGuidedSetupComplete), so these are
// purely about completing the form. No trial/payment language belongs
// here. After 30 days with no completed Guided Setup, the drip stops
// (markRemindersPaused) — deliverability/compliance/cost reasons; the
// record itself is never deleted, and Gilbert can always manually follow
// up. Sent on BOTH email and text regardless of contact_pref, per
// Gilbert's call — maximize the chance it's actually seen.
//
// TRACK 2 — "your trial is ending" nudge, sent once, a couple of days
// before trial_ends_at, for a signup whose Guided Setup IS done (trial
// actually running) but hasn't been approved into a real account yet. This
// is the one place payment comes up, and only when config.stripeConfigured
// is true — see config.js's comment on stripeConfigured. The moment real
// Stripe keys are added, this reminder starts including a real "add your
// payment method" link with no further code change needed; until then it's
// skipped entirely (no reminder promising a payment step that doesn't exist).

import { config } from './config.js';
import {
  listSignupsForReminderSweep,
  markReminderSent,
  markRemindersPaused,
  listSignupsForTrialEndingReminder,
  markTrialEndingReminderSent,
  sqliteDatetimeToMs,
} from './db.js';
import { sendEmail } from './email/resend.js';
import { sendSms } from './telephony/twilio.js';
import { createCheckoutSession } from './billing/stripe.js';
import { escapeHtml } from './util/html.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ABANDON_AFTER_DAYS = 30;
const TRIAL_ENDING_WINDOW_DAYS = 2; // send once the trial has this many days (or fewer) left

function setupUrlFor(signup) {
  return `${config.siteBaseUrl}/setup.html?t=${signup.setup_token}`;
}

const SETUP_TIERS = [
  {
    n: 1,
    afterDays: 2,
    subject: (biz) => `Quick reminder: finish setting up ${biz} on HelloBob`,
    body: (biz, url) =>
      `Whenever you get a chance, finishing Guided Setup is what turns on Bob for ${biz} — it only takes 10-15 minutes, your free 10-day trial starts as soon as you're done, and you can pick up where you left off: ${url}`,
  },
  {
    n: 2,
    afterDays: 5,
    subject: (biz) => `Still time to finish Bob's setup for ${biz}`,
    body: (biz, url) =>
      `Just checking in — Bob isn't answering anything for ${biz} yet, and your free trial hasn't started, until Guided Setup is done. Takes about 10-15 minutes: ${url}`,
  },
  {
    n: 3,
    afterDays: 8,
    subject: (biz) => `Don't miss out — finish ${biz}'s setup to start your free trial`,
    body: (biz, url) =>
      `Bob is ready to go for ${biz} as soon as you finish Guided Setup — your free 10-day trial doesn't start until then, so there's no rush against a clock, but we don't want you to miss out: ${url}`,
  },
];

async function paymentAddendum(signup) {
  if (!config.stripeConfigured) return '';
  try {
    const session = await createCheckoutSession({
      signupToken: signup.setup_token,
      contactEmail: signup.contact_email,
      successUrl: `${config.siteBaseUrl}/setup.html?t=${signup.setup_token}&paid=1`,
      cancelUrl: `${config.siteBaseUrl}/setup.html?t=${signup.setup_token}`,
      trialEndsAtMs: sqliteDatetimeToMs(signup.trial_ends_at),
    });
    return ` Add your payment method here to keep Bob running when your trial ends (nothing is charged until then): ${session.url}`;
  } catch (err) {
    console.error('[reminders] Stripe checkout session failed, skipping payment link:', err.message);
    return '';
  }
}

async function runSetupReminders({ listFn, markSentFn, markPausedFn, sendEmailFn, sendSmsFn }) {
  for (const signup of listFn()) {
    const ageDays = (Date.now() - sqliteDatetimeToMs(signup.created_at)) / DAY_MS;

    if (ageDays >= ABANDON_AFTER_DAYS) {
      markPausedFn(signup.id);
      continue;
    }

    // Send the highest-numbered tier that's due and not yet sent — a sweep
    // that runs hourly normally catches each tier separately, but this also
    // does the right thing if the server was down for a few days.
    const dueTier = [...SETUP_TIERS].reverse().find((t) => {
      const sentCol = { 1: 'reminder1_sent_at', 2: 'reminder2_sent_at', 3: 'reminder3_sent_at' }[t.n];
      return ageDays >= t.afterDays && !signup[sentCol];
    });
    if (!dueTier) continue;

    const url = setupUrlFor(signup);
    const bodyText = dueTier.body(signup.business_name, url);

    await Promise.all([
      sendEmailFn({
        to: signup.contact_email,
        subject: dueTier.subject(signup.business_name),
        html: `<p>${escapeHtml(bodyText)}</p>`,
      }),
      sendSmsFn(signup.contact_phone, bodyText).catch((err) => {
        console.error('[reminders] setup-nudge SMS failed:', err.message);
      }),
    ]);

    markSentFn(signup.id, dueTier.n);
  }
}

async function runTrialEndingReminders({ listFn, markSentFn, sendEmailFn, sendSmsFn }) {
  for (const signup of listFn()) {
    const msLeft = sqliteDatetimeToMs(signup.trial_ends_at) - Date.now();
    if (msLeft > TRIAL_ENDING_WINDOW_DAYS * DAY_MS) continue; // not due yet

    const daysLeftPhrase = msLeft <= 0 ? 'has ended' : 'ends in the next couple of days';
    const addendum = await paymentAddendum(signup);
    const bodyText =
      `Heads up — ${signup.business_name}'s free HelloBob trial ${daysLeftPhrase}.` +
      (addendum || " Reach out whenever you're ready to keep Bob running and we'll get payment set up.");

    await Promise.all([
      sendEmailFn({
        to: signup.contact_email,
        subject: `${signup.business_name}'s HelloBob trial ${daysLeftPhrase}`,
        html: `<p>${escapeHtml(bodyText)}</p>`,
      }),
      sendSmsFn(signup.contact_phone, bodyText).catch((err) => {
        console.error('[reminders] trial-ending SMS failed:', err.message);
      }),
    ]);

    markSentFn(signup.id);
  }
}

/** One hourly pass across both reminder tracks. Exported for tests / manual invocation. */
export async function runReminderSweep(deps = {}) {
  const {
    listSignupsForReminderSweep: listSetupFn = listSignupsForReminderSweep,
    markReminderSent: markSetupSentFn = markReminderSent,
    markRemindersPaused: markPausedFn = markRemindersPaused,
    listSignupsForTrialEndingReminder: listTrialEndingFn = listSignupsForTrialEndingReminder,
    markTrialEndingReminderSent: markTrialEndingSentFn = markTrialEndingReminderSent,
    sendEmail: sendEmailFn = sendEmail,
    sendSms: sendSmsFn = sendSms,
  } = deps;

  await runSetupReminders({ listFn: listSetupFn, markSentFn: markSetupSentFn, markPausedFn, sendEmailFn, sendSmsFn });
  await runTrialEndingReminders({ listFn: listTrialEndingFn, markSentFn: markTrialEndingSentFn, sendEmailFn, sendSmsFn });
}

let intervalHandle = null;

/** Starts the hourly sweep. Call once at boot (see server.js) — not during tests. */
export function startReminderScheduler() {
  if (intervalHandle) return;
  const HOUR_MS = 60 * 60 * 1000;
  // Run once shortly after boot (catches anything overdue after a deploy or
  // downtime), then hourly.
  setTimeout(() => runReminderSweep().catch((err) => console.error('[reminders] sweep failed:', err)), 30_000);
  intervalHandle = setInterval(() => {
    runReminderSweep().catch((err) => console.error('[reminders] sweep failed:', err));
  }, HOUR_MS);
}
