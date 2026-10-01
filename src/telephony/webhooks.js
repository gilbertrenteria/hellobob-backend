// HTTP-framework-agnostic webhook handlers. `server.js` parses the raw
// request into `{ url, params }` and hands it to these functions — that
// keeps this file testable without spinning up a real HTTP server.

import { config } from '../config.js';
import { isValidTwilioSignature, sendSms, emptyVoiceResponseXml, dialWithWhisperXml } from './twilio.js';
import {
  getBusinessByPhone,
  upsertCustomer,
  getOpenConversation,
  createConversation,
  touchConversationInbound,
  addMessage,
} from '../db.js';
import {
  canSend,
  grantReplyConsent,
  processOptOut,
  isOptOutMessage,
  REPLY_TEXT_WORDING_TEMPLATE,
  MESSAGE_CATEGORIES,
} from '../compliance/consent.js';
import { runConversationTurn } from '../ai/conversationEngine.js';

/**
 * Incoming SMS webhook (Twilio calls this on every inbound text to the
 * business's number). `params` is the parsed application/x-www-form-urlencoded
 * body Twilio sends: From, To, Body, MessageSid, etc.
 */
export async function handleIncomingSms({ url, params, signatureHeader }) {
  if (!isValidTwilioSignature(url, params, signatureHeader)) {
    return { status: 403, body: 'invalid signature' };
  }

  const business = getBusinessByPhone(params.To);
  if (!business) {
    return { status: 404, body: 'unknown business number' };
  }

  const customer = upsertCustomer(business.id, params.From, null);
  const rawText = (params.Body || '').trim();

  // STOP handling short-circuits everything else — no AI, no other logic.
  if (isOptOutMessage(rawText)) {
    processOptOut(business, customer, rawText);
    const confirmation = "You're unsubscribed and won't receive any more texts from us. Reply START to opt back in.";
    // A STOP confirmation is legally required and is itself exempt from the
    // consent gate below (it's not a category that needs consent), but it
    // still logs like any other outbound message for the audit trail.
    await sendSms(customer.phone_e164, confirmation);
    let conv = getOpenConversation(business.id, customer.id, 'sms');
    if (!conv) conv = createConversation(business.id, customer.id, 'sms');
    addMessage({ conversationId: conv.id, direction: 'inbound', body: rawText, category: 'reply_only' });
    addMessage({ conversationId: conv.id, direction: 'outbound', body: confirmation, category: 'reply_only' });
    return { status: 200, body: emptyVoiceResponseXml() };
  }

  let conversation = getOpenConversation(business.id, customer.id, 'sms');
  if (!conversation) conversation = createConversation(business.id, customer.id, 'sms');
  touchConversationInbound(conversation.id);
  addMessage({ conversationId: conversation.id, direction: 'inbound', body: rawText, category: 'reply_only' });

  const { reply, category } = await runConversationTurn({ business, customer, conversation, inboundText: rawText });

  if (reply) {
    // This is a direct, in-conversation reply to a message the customer just
    // sent — exempt from quiet hours (see quietHours.js), but still gated on
    // consent for anything beyond a bare reply (e.g. if the AI tries to send
    // a promotional message, canSend blocks it regardless of what it wrote).
    const decision = canSend(business, customer, category || MESSAGE_CATEGORIES.REPLY_ONLY, true);
    if (decision.allowed) {
      const sent = await sendSms(customer.phone_e164, reply);
      addMessage({
        conversationId: conversation.id,
        direction: 'outbound',
        body: reply,
        category: category || MESSAGE_CATEGORIES.REPLY_ONLY,
        twilioSid: sent.sid,
      });
    } else {
      console.warn(`[compliance] blocked outbound to ${customer.phone_e164}: ${decision.reason}`);
    }
  }

  return { status: 200, body: emptyVoiceResponseXml() };
}

/**
 * Incoming voice webhook. There's no AI voice/IVR here — Bob's job happens
 * over SMS — so a call either rings through to the owner's real phone (with
 * a "HelloBob call" whisper only they hear, so they know it's the business
 * line before picking up) when OWNER_FORWARD_PHONE is configured, or — if
 * that's unset, or once the owner doesn't pick up and Twilio reports this
 * same call again with CallStatus=no-answer/busy/failed per the
 * StatusCallback configured on the number — this handler sends the caller a
 * reactive text-back instead.
 */
export async function handleIncomingVoice({ url, params, signatureHeader }) {
  if (!isValidTwilioSignature(url, params, signatureHeader)) {
    return { status: 403, body: 'invalid signature' };
  }

  const business = getBusinessByPhone(params.To);
  if (!business) {
    return { status: 404, body: emptyVoiceResponseXml() };
  }

  const missed = ['no-answer', 'busy', 'failed'].includes(params.CallStatus);
  if (missed) {
    const customer = upsertCustomer(business.id, params.From, null);
    grantReplyConsent(business, customer);

    const text = REPLY_TEXT_WORDING_TEMPLATE(business.name);
    const decision = canSend(business, customer, MESSAGE_CATEGORIES.REPLY_ONLY, false);
    if (decision.allowed) {
      const sent = await sendSms(customer.phone_e164, text);
      let conv = getOpenConversation(business.id, customer.id, 'voice_missed_call');
      if (!conv) conv = createConversation(business.id, customer.id, 'voice_missed_call');
      addMessage({ conversationId: conv.id, direction: 'outbound', body: text, category: 'reply_only', twilioSid: sent.sid });
    } else {
      // Outside quiet hours — the text-back queues for the next allowed
      // window in a fuller implementation; for the MVP we log and skip.
      console.warn(`[compliance] missed-call text-back deferred for ${customer.phone_e164}: ${decision.reason}`);
    }
    return { status: 200, body: emptyVoiceResponseXml() };
  }

  // Not yet a terminal status — this is the call actually coming in. Ring
  // the owner's phone instead of silently disconnecting, if they've set one.
  if (config.ownerForwardPhone) {
    const whisperUrl = `${config.publicBaseUrl}/webhooks/voice-whisper`;
    return { status: 200, body: dialWithWhisperXml(config.ownerForwardPhone, whisperUrl) };
  }

  return { status: 200, body: emptyVoiceResponseXml() };
}

export const _internalsForServer = { publicBaseUrl: config.publicBaseUrl };
