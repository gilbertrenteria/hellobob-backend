// JSON API backing a real owner dashboard (the eventual live version of the
// dashboard-mockup.html / dashboard.html blueprints from the planning pass).
// Framework-agnostic on purpose, same as webhooks.js — server.js calls these
// with already-parsed path params and turns the return value into a response.

import {
  getBusiness,
  listConversations,
  listAppointments,
  complianceSummary,
  listConsentForCustomer,
  getConversationMessages,
} from '../db.js';

function notFound(what) {
  return { status: 404, json: { error: `${what} not found` } };
}

export function getConversationsRoute(businessId) {
  const business = getBusiness(businessId);
  if (!business) return notFound('business');
  return { status: 200, json: listConversations(businessId) };
}

export function getConversationMessagesRoute(conversationId) {
  return { status: 200, json: getConversationMessages(conversationId, 200) };
}

export function getAppointmentsRoute(businessId) {
  const business = getBusiness(businessId);
  if (!business) return notFound('business');
  return { status: 200, json: listAppointments(businessId) };
}

export function getComplianceSummaryRoute(businessId) {
  const business = getBusiness(businessId);
  if (!business) return notFound('business');
  return { status: 200, json: complianceSummary(businessId) };
}

export function getCustomerConsentRoute(businessId, customerId) {
  return { status: 200, json: listConsentForCustomer(businessId, customerId) };
}
