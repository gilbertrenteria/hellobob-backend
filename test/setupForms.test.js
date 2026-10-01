// Covers the real, own-domain Guided Setup / Website Builder submission
// flow (setupForms.js) and the trial-start rule it triggers in db.js
// (markGuidedSetupComplete), plus both reminder tracks in reminders.js —
// none of this talks to Jotform or any other third party.

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';
process.env.PORT = '0';
process.env.SITE_BASE_URL = 'https://example.test';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createSignup, getSignupById, markGuidedSetupComplete, listSignupsForReminderSweep, listSignupsForTrialEndingReminder, db } =
  await import('../src/db.js');
const { submitGuidedSetup, submitWebsiteBuilder, SetupFormError } = await import('../src/setupForms.js');
const { runReminderSweep } = await import('../src/reminders.js');

function noopEmail() {
  return async () => ({ sent: true });
}
function noopSms() {
  return async () => ({ sid: 'TEST', status: 'test' });
}

test('Guided Setup: an unknown token is rejected with not_found, nothing is saved', async () => {
  await assert.rejects(
    () => submitGuidedSetup({ token: 'does-not-exist', answers: { hasWebsite: 'no_website' } }, { sendEmail: noopEmail() }),
    (err) => err instanceof SetupFormError && err.code === 'not_found'
  );
});

test('Guided Setup: missing answers is a bad_request, not a crash', async () => {
  const signup = createSignup({ businessName: 'Test Co', contactEmail: 'a@b.com', contactPhone: '555-0100' });
  await assert.rejects(
    () => submitGuidedSetup({ token: signup.setup_token, answers: null }, { sendEmail: noopEmail() }),
    (err) => err instanceof SetupFormError && err.code === 'bad_request'
  );
});

test('Guided Setup completion STARTS the trial (was NULL before) and sets it to +10 days', async () => {
  const signup = createSignup({ businessName: 'Late Riser LLC', contactEmail: 'late@riser.com', contactPhone: '555-0101' });
  assert.equal(getSignupById(signup.id).trial_ends_at, null, 'no trial before Guided Setup is done');

  const result = await submitGuidedSetup(
    { token: signup.setup_token, answers: { hasWebsite: 'yes', bizName: 'Late Riser LLC' }, websiteChoice: 'has_website' },
    { sendEmail: noopEmail() }
  );

  const updated = getSignupById(signup.id);
  assert.equal(updated.guided_setup_status, 'completed');
  assert.ok(updated.trial_ends_at, 'trial_ends_at is now set');
  const daysUntilEnd = (new Date(`${updated.trial_ends_at.replace(' ', 'T')}Z`).getTime() - Date.now()) / 86_400_000;
  assert.ok(daysUntilEnd > 9.9 && daysUntilEnd < 10.1, `expected ~10 days out, got ${daysUntilEnd}`);
  assert.equal(result.websiteBuilderUrl, null, 'has_website means no Website Builder follow-up');
});

test('Guided Setup: "no_website" answer sets website_builder_status pending and returns its URL', async () => {
  const signup = createSignup({ businessName: 'No Site Co', contactEmail: 'nosite@co.com', contactPhone: '555-0102' });
  const result = await submitGuidedSetup(
    { token: signup.setup_token, answers: { hasWebsite: 'no' }, websiteChoice: 'no_website' },
    { sendEmail: noopEmail() }
  );
  assert.equal(getSignupById(signup.id).website_builder_status, 'pending');
  assert.equal(result.websiteBuilderUrl, `https://example.test/website-builder.html?t=${signup.setup_token}`);
});

test('Guided Setup: "wants_upgrade" also triggers the Website Builder follow-up', async () => {
  const signup = createSignup({ businessName: 'Upgrade Co', contactEmail: 'upgrade@co.com', contactPhone: '555-0103' });
  const result = await submitGuidedSetup(
    { token: signup.setup_token, answers: { hasWebsite: 'yes' }, websiteChoice: 'wants_upgrade' },
    { sendEmail: noopEmail() }
  );
  assert.ok(result.websiteBuilderUrl);
  assert.equal(getSignupById(signup.id).website_builder_status, 'pending');
});

test('Website Builder: submitting for a signup marks it completed and saves the site data', async () => {
  const signup = createSignup({ businessName: 'Builder Co', contactEmail: 'b@co.com', contactPhone: '555-0104' });
  await submitGuidedSetup({ token: signup.setup_token, answers: { hasWebsite: 'no' }, websiteChoice: 'no_website' }, { sendEmail: noopEmail() });

  const result = await submitWebsiteBuilder(
    { token: signup.setup_token, site: { template: 'hvac-03', accentColor: '#E5231A' } },
    { sendEmail: noopEmail() }
  );
  assert.equal(result.ok, true);
  assert.equal(getSignupById(signup.id).website_builder_status, 'completed');
});

test('reminders: day-2 tier fires for a 3-day-old unfinished signup, day-5/8 do not yet', async () => {
  const signup = createSignup({ businessName: 'Three Day Co', contactEmail: 'three@day.com', contactPhone: '555-0105' });
  db.prepare(`UPDATE signups SET created_at = datetime('now', '-3 days') WHERE id = ?`).run(signup.id);

  const sent = [];
  await runReminderSweep({
    sendEmail: async ({ to, subject }) => { sent.push({ to, subject }); return { sent: true }; },
    sendSms: noopSms(),
  });

  const updated = getSignupById(signup.id);
  assert.ok(updated.reminder1_sent_at, 'tier 1 (day 2) should have fired');
  assert.equal(updated.reminder2_sent_at, null, 'tier 2 (day 5) should not have fired yet');
  assert.equal(updated.reminder3_sent_at, null, 'tier 3 (day 8) should not have fired yet');
  assert.ok(sent.some((e) => e.to === 'three@day.com'));
});

test('reminders: no trial/payment language before Guided Setup is done', async () => {
  const signup = createSignup({ businessName: 'No Rush Co', contactEmail: 'norush@co.com', contactPhone: '555-0106' });
  db.prepare(`UPDATE signups SET created_at = datetime('now', '-9 days') WHERE id = ?`).run(signup.id);

  const sent = [];
  await runReminderSweep({
    sendEmail: async ({ to, subject, html }) => { sent.push({ to, subject, html }); return { sent: true }; },
    sendSms: noopSms(),
  });

  const mail = sent.find((e) => e.to === 'norush@co.com');
  assert.ok(mail, 'tier 3 should have fired by day 9');
  assert.doesNotMatch(mail.html, /payment|trial ends|extension/i);
});

test('reminders: a signup 31 days old with no completed setup is paused (abandoned), not nagged again', async () => {
  const signup = createSignup({ businessName: 'Ghost Co', contactEmail: 'ghost@co.com', contactPhone: '555-0107' });
  db.prepare(`UPDATE signups SET created_at = datetime('now', '-31 days') WHERE id = ?`).run(signup.id);

  const sent = [];
  await runReminderSweep({
    sendEmail: async ({ to }) => { sent.push(to); return { sent: true }; },
    sendSms: noopSms(),
  });

  const updated = getSignupById(signup.id);
  assert.equal(updated.status, 'abandoned');
  assert.equal(updated.reminders_paused, 1);
  assert.ok(!sent.includes('ghost@co.com'), 'an abandoned signup should not also get a reminder in the same sweep');

  // A second sweep should skip it entirely now (it's off the pending list).
  const stillCandidates = listSignupsForReminderSweep();
  assert.ok(!stillCandidates.some((s) => s.id === signup.id));
});

test('reminders: trial-ending nudge fires once a completed-setup signup is within 2 days of trial_ends_at, and skips payment language without Stripe configured', async () => {
  const signup = createSignup({ businessName: 'Almost Done Co', contactEmail: 'almost@done.com', contactPhone: '555-0108' });
  await submitGuidedSetup({ token: signup.setup_token, answers: { hasWebsite: 'yes' }, websiteChoice: 'has_website' }, { sendEmail: noopEmail() });
  // Force the trial to look like it's about to end.
  db.prepare(`UPDATE signups SET trial_ends_at = datetime('now', '+1 days') WHERE id = ?`).run(signup.id);

  const preCandidates = listSignupsForTrialEndingReminder();
  assert.ok(preCandidates.some((s) => s.id === signup.id));

  const sent = [];
  await runReminderSweep({
    sendEmail: async ({ to, subject, html }) => { sent.push({ to, subject, html }); return { sent: true }; },
    sendSms: noopSms(),
  });

  const mail = sent.find((e) => e.to === 'almost@done.com');
  assert.ok(mail, 'trial-ending reminder should have fired');
  assert.doesNotMatch(mail.html, /stripe|checkout\.stripe\.com/i, 'no payment link without Stripe configured');
  assert.equal(getSignupById(signup.id).trial_ending_reminder_sent_at !== null, true);
});
