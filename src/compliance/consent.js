// The compliance gate every outbound message goes through. This is the code
// version of the two-layer design from the planning docs:
//
//   1. reply-consent  — created automatically the moment we send the single
//      reactive missed-call text. Covers exactly one thing: replying to
//      whatever the customer says back. Never covers reminders, invoices,
//      review requests, etc.
//   2. full-consent    — a single explicit yes, asked once (typically right
//      after booking), that covers all four transactional message types
//      together: reminders, on-my-way alerts, invoices, review requests.
//
// Nothing here decides WHAT to say — that's the AI engine's job. This module
// only decides WHETHER a given outbound message is allowed to go out right
// now, and it is intentionally deterministic (no model output feeds into a
// compliance decision) so a bad AI response can never bypass consent rules.

import {
  getCurrentConsent,
  isOptedOut,
  recordConsent,
  recordOptOut,
} from '../db.js';
import { isWithinQuietHoursWindow } from './quietHours.js';

export const MESSAGE_CATEGORIES = {
  REPLY_ONLY: 'reply_only',       // the one reactive missed-call text-back
  TRANSACTIONAL: 'transactional', // reminder / on-my-way / invoice / review request
  PROMOTIONAL: 'promotional',     // maintenance-plan renewal, seasonal offer — separate opt-in
};

export const FULL_CONSENT_WORDING =
  "Quick one-time question: OK if we text you about this job — appointment reminders, " +
  "an on-my-way alert, your invoice, and (once it's done) a quick review request? " +
  "One yes covers all of that. Reply YES to opt in, or NO if you'd rather we didn't. " +
  "Reply STOP anytime to opt out completely.";

export const REPLY_TEXT_WORDING_TEMPLATE = (businessName) =>
  `Hi, this is Bob — ${businessName}'s assistant. Sorry we missed your call! ` +
  `Reply here and I can help right now, or reply STOP to opt out.`;

/**
 * Decide whether `body` is allowed to be sent to `customer` right now.
 * Returns { allowed: true } or { allowed: false, reason: '...' }.
 *
 * @param {object} business  row from businesses table
 * @param {object} customer  row from customers table
 * @param {string} category  one of MESSAGE_CATEGORIES
 * @param {boolean} isDirectReply  true if this is a live, in-conversation
 *   reply to a message the customer just sent (exempts quiet hours — see
 *   quietHours.js header comment)
 */
export function canSend(business, customer, category, isDirectReply = false) {
  if (isOptedOut(business.id, customer.id)) {
    return { allowed: false, reason: 'customer has opted out (SMS STOP)' };
  }

  if (category === MESSAGE_CATEGORIES.TRANSACTIONAL) {
    const full = getCurrentConsent(business.id, customer.id, 'full');
    if (!full || full.status !== 'granted') {
      return { allowed: false, reason: 'no full-texting-consent on file for this customer' };
    }
  }

  if (category === MESSAGE_CATEGORIES.PROMOTIONAL) {
    const promo = getCurrentConsent(business.id, customer.id, 'promotional');
    if (!promo || promo.status !== 'granted') {
      return { allowed: false, reason: 'no promotional opt-in on file for this customer' };
    }
  }

  // REPLY_ONLY (the missed-call text-back) needs no prior consent — the
  // customer calling first is what makes the single reactive reply
  // defensible. It still respects quiet hours below, same as everything else.

  if (!isDirectReply && !isWithinQuietHoursWindow(business)) {
    return { allowed: false, reason: 'outside this business\'s quiet hours' };
  }

  return { allowed: true };
}

/** Call once, right when a missed call comes in, before the text-back is sent. */
export function grantReplyConsent(business, customer) {
  recordConsent({
    businessId: business.id,
    customerId: customer.id,
    type: 'reply',
    status: 'granted',
    wording: REPLY_TEXT_WORDING_TEMPLATE(business.name),
    source: 'missed_call_text',
  });
}

/** Call when the customer answers the full-consent question (yes/no). */
export function recordFullConsentAnswer(business, customer, granted, source = 'booking_ask') {
  recordConsent({
    businessId: business.id,
    customerId: customer.id,
    type: 'full',
    status: granted ? 'granted' : 'declined',
    wording: FULL_CONSENT_WORDING,
    source,
  });
}

/** STOP (or any recognizable opt-out phrase) revokes everything at once. */
export function processOptOut(business, customer, rawText) {
  recordOptOut(business.id, customer.id, `customer texted: "${rawText}"`);
  recordConsent({ businessId: business.id, customerId: customer.id, type: 'reply', status: 'revoked', wording: rawText, source: 'stop_keyword' });
  recordConsent({ businessId: business.id, customerId: customer.id, type: 'full', status: 'revoked', wording: rawText, source: 'stop_keyword' });
  recordConsent({ businessId: business.id, customerId: customer.id, type: 'promotional', status: 'revoked', wording: rawText, source: 'stop_keyword' });
}

const STOP_PATTERN = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)\s*[.!]?\s*$/i;
export function isOptOutMessage(text) {
  return STOP_PATTERN.test(text || '');
}

const YES_PATTERN = /^\s*(y|yes|yeah|yep|sure|ok|okay)\s*[.!]?\s*$/i;
const NO_PATTERN = /^\s*(n|no|nope|nah)\s*[.!]?\s*$/i;
export function parseYesNo(text) {
  if (YES_PATTERN.test(text || '')) return true;
  if (NO_PATTERN.test(text || '')) return false;
  return null; // ambiguous — caller should ask again rather than guess
}
