// Central place that loads environment variables and fails loudly (at boot,
// not mid-request) if something required is missing. Keeping this in one
// file means every other module can just `import { config } from './config.js'`
// instead of touching process.env directly.

import { existsSync } from 'node:fs';

// Node 22.6+ can load a .env file natively — no `dotenv` package needed.
// Silently skipped if the file doesn't exist yet (e.g. first run).
if (existsSync(new URL('../.env', import.meta.url))) {
  process.loadEnvFile(new URL('../.env', import.meta.url));
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[config] Warning: ${name} is not set. Related features will not work until it is.`);
  }
  return value || '';
}

export const config = {
  port: Number(process.env.PORT || 3000),

  // Anthropic (Claude) API — powers Bob's actual conversation.
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',

  // Twilio — SMS + voice. A2P 10DLC registration must be done in the Twilio
  // console (see README) before production SMS traffic; these credentials
  // work in trial mode against verified numbers before that's finished.
  twilioAccountSid: required('TWILIO_ACCOUNT_SID'),
  twilioAuthToken: required('TWILIO_AUTH_TOKEN'),
  twilioFromNumber: required('TWILIO_FROM_NUMBER'), // E.164, e.g. +16195550142

  // Public base URL this server is reachable at (for Twilio webhook
  // signature validation, and so Bob can log a link back to itself).
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  // Path to the SQLite database file.
  dbPath: process.env.DB_PATH || new URL('../data/hellobob.db', import.meta.url).pathname,

  // Default quiet hours (local to the business's timezone) applied to every
  // automated outbound text unless a stricter state rule overrides it.
  defaultQuietHoursStart: Number(process.env.QUIET_HOURS_START ?? 8),  // 8am
  defaultQuietHoursEnd: Number(process.env.QUIET_HOURS_END ?? 21),     // 9pm

  // When true, Twilio and Anthropic calls are logged instead of actually
  // sent — lets you run the server and exercise the logic before you have
  // real API keys. Defaults on if the keys aren't set.
  dryRun: process.env.DRY_RUN === 'true' || (!process.env.ANTHROPIC_API_KEY && !process.env.TWILIO_ACCOUNT_SID),

  // The detailed 15-section setup questionnaire ("Let's Build Your Bob") —
  // still a real Jotform, kept as-is since it's already built out. The
  // quick 3-field sign-up is NOT Jotform anymore: Bob captures it directly
  // in chat and saves it to our own `signups` table (see db.js), then
  // immediately points the new signup here for the detailed part.
  jotformQuestionnaireUrl: process.env.JOTFORM_QUESTIONNAIRE_URL || 'https://form.jotform.com/262458290659065',

  // Which origins may call the public /api/website-chat endpoint from a
  // browser. '*' (default) allows any site — fine while this is only
  // reachable from a claude.ai-hosted artifact preview; once HelloBob has
  // its own domain, set this to that exact origin (e.g.
  // https://www.hellobob.com) to stop other sites from calling it and
  // burning your Claude usage.
  websiteChatAllowedOrigin: process.env.WEBSITE_CHAT_ALLOWED_ORIGIN || '*',

  // Simple shared-secret to view captured signups at GET /api/signups
  // (?key=...) until there's a real dashboard/login. Pick your own long
  // random string and put it in .env — leaving it unset disables the route.
  adminKey: process.env.ADMIN_KEY || '',

  // Resend (https://resend.com) sends the two automatic emails fired when
  // someone signs up in chat: a notification to you, and a welcome email to
  // the new customer with a link to the setup questionnaire. Plain HTTPS
  // API, no SDK — same fetch()-only style as claude.js/twilio.js. Leaving
  // RESEND_API_KEY unset just logs what would have been sent (like DRY_RUN)
  // instead of failing, so nothing breaks before you've set it up.
  resendApiKey: process.env.RESEND_API_KEY || '',
  // Must be on a domain you've verified in Resend once you have one; until
  // then Resend's own onboarding@resend.dev address works for testing.
  emailFrom: process.env.EMAIL_FROM || 'HelloBob <onboarding@resend.dev>',
  // Where new-signup notifications go — defaults to your own address.
  notifyEmail: process.env.NOTIFY_EMAIL || 'gilbertrenteria@yahoo.com',
};
