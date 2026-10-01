// Minimal Stripe REST client using nothing but built-in `fetch` — same
// zero-dependency approach as telephony/twilio.js and email/resend.js. Only
// implements the one thing this app needs: a hosted Checkout page that
// starts a $197/mo subscription.
//
// Nothing here runs unless config.stripeConfigured is true (both
// STRIPE_SECRET_KEY and STRIPE_PRICE_ID set). Every caller checks that
// first — see billingRoute() in routes/billing.js — so a deployment
// without real Stripe keys yet behaves exactly like one with Twilio unset:
// the feature is just not offered, nothing throws.
//
// KNOWN FOLLOW-UP: this creates the Checkout Session but does not yet
// listen for Stripe's webhook (checkout.session.completed /
// customer.subscription.*) to mark a signup as actually paid in our own
// database. Wire that up once real Stripe keys are in place and a webhook
// endpoint can be registered/tested against them — until then, "did they
// actually pay" is checked in the Stripe Dashboard, not this app.

import { config } from '../config.js';

const API_BASE = 'https://api.stripe.com/v1';

function authHeader() {
  return `Bearer ${config.stripeSecretKey}`;
}

/** Stripe's REST API takes classic form-urlencoded bodies, including for
 * nested params like `line_items[0][price]` — not JSON. */
function toFormBody(params) {
  const out = new URLSearchParams();
  const walk = (key, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${key}[${i}]`, v));
    } else if (typeof value === 'object') {
      Object.entries(value).forEach(([k, v]) => walk(`${key}[${k}]`, v));
    } else {
      out.append(key, String(value));
    }
  };
  Object.entries(params).forEach(([k, v]) => walk(k, v));
  return out;
}

/**
 * Creates a hosted Stripe Checkout Session for the $197/mo subscription and
 * returns its URL to redirect the customer to.
 *
 * trialEndsAtMs, if given and more than 48 hours in the future (Stripe's
 * own minimum), is passed as the subscription's trial_end — so Stripe
 * itself won't actually charge the card until our own trial (including any
 * extension already applied — see db.js markGuidedSetupComplete) ends.
 * Otherwise the subscription starts billing immediately on checkout.
 *
 * @param {object} opts
 * @param {string} opts.signupToken   used as client_reference_id, so a
 *   webhook (once wired up) can match the completed checkout back to a signup
 * @param {string} opts.contactEmail
 * @param {string} opts.successUrl
 * @param {string} opts.cancelUrl
 * @param {number} [opts.trialEndsAtMs]
 */
export async function createCheckoutSession({ signupToken, contactEmail, successUrl, cancelUrl, trialEndsAtMs }) {
  if (!config.stripeConfigured) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY / STRIPE_PRICE_ID unset)');
  }

  const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
  const trialEndUnix =
    trialEndsAtMs && trialEndsAtMs - Date.now() > FORTY_EIGHT_HOURS_MS
      ? Math.floor(trialEndsAtMs / 1000)
      : undefined;

  const body = toFormBody({
    mode: 'subscription',
    line_items: [{ price: config.stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: contactEmail,
    client_reference_id: signupToken,
    ...(trialEndUnix ? { subscription_data: { trial_end: trialEndUnix } } : {}),
  });

  const res = await fetch(`${API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe checkout session failed (${res.status}): ${data.error?.message || JSON.stringify(data)}`);
  }
  return { url: data.url, id: data.id };
}
