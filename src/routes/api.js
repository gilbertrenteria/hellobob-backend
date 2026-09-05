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
  createTechnician,
  listTechnicians,
  getTechnician,
  getTechAvailability,
  setTechAvailability,
  addTimeOff,
} from '../db.js';

function notFound(what) {
  return { status: 404, json: { error: `${what} not found` } };
}

function badRequest(message) {
  return { status: 400, json: { error: 'bad_request', message } };
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

// ---- In-house booking engine (technicians + their weekly hours) -----------
// Unauthenticated like every other /api/businesses/:id/* route above — this
// whole file is a stopgap ahead of a real dashboard/login (see the header
// comment), not a finished access-control story. Do not expose these
// publicly as-is; a real owner login needs to gate write access to these
// before this ships to more than one trusted customer.

export function getTechniciansRoute(businessId) {
  const business = getBusiness(businessId);
  if (!business) return notFound('business');
  const technicians = listTechnicians(businessId, { activeOnly: false }).map((t) => ({
    ...t,
    availability: getTechAvailability(t.id),
  }));
  return { status: 200, json: technicians };
}

export function createTechnicianRoute(businessId, body) {
  const business = getBusiness(businessId);
  if (!business) return notFound('business');
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return badRequest('name is required');
  return { status: 200, json: createTechnician(businessId, name) };
}

/** body.rules: [{dayOfWeek: 0-6, startMinute, endMinute}, ...] — replaces ALL weekly hours for this technician. */
export function setTechnicianAvailabilityRoute(technicianId, body) {
  const tech = getTechnician(technicianId);
  if (!tech) return notFound('technician');
  const rules = Array.isArray(body?.rules) ? body.rules : null;
  if (!rules) return badRequest('rules must be an array of {dayOfWeek, startMinute, endMinute}');
  for (const r of rules) {
    if (
      !Number.isInteger(r.dayOfWeek) || r.dayOfWeek < 0 || r.dayOfWeek > 6 ||
      !Number.isInteger(r.startMinute) || !Number.isInteger(r.endMinute) || r.endMinute <= r.startMinute
    ) {
      return badRequest('each rule needs an integer dayOfWeek (0-6) and startMinute < endMinute');
    }
  }
  setTechAvailability(technicianId, rules);
  return { status: 200, json: { technicianId, availability: getTechAvailability(technicianId) } };
}

/** body: {startAt, endAt, reason?} — naive "YYYY-MM-DDTHH:MM" strings, business-local time. */
export function addTechnicianTimeOffRoute(technicianId, body) {
  const tech = getTechnician(technicianId);
  if (!tech) return notFound('technician');
  if (!body?.startAt || !body?.endAt) return badRequest('startAt and endAt are required');
  return { status: 200, json: addTimeOff(technicianId, body.startAt, body.endAt, body.reason) };
}
