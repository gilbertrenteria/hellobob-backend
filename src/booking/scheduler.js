// The in-house booking engine: lets Bob check REAL technician availability
// and book a specific slot, instead of just recording whatever time a human
// already agreed to (which is all the old book_appointment tool call did —
// see conversationEngine.js).
//
// Datetimes throughout this file are plain "YYYY-MM-DDTHH:MM" strings in the
// business's own local wall-clock time — no UTC offset, no timezone
// conversion. That matches how the rest of this codebase already treats
// `scheduled_at` (a loosely-typed string) and keeps the arithmetic below
// simple and dependency-free: we parse each string as if it were UTC purely
// as an internal computation trick (so `Date` math doesn't drift), never
// mixing it with anything that's genuinely UTC elsewhere in the app.

import {
  listTechnicians,
  getTechnician,
  getTechAvailability,
  listTimeOff,
  listAppointmentsInRange,
  createAppointment,
} from '../db.js';

export class SlotUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SlotUnavailableError';
    this.code = 'slot_unavailable';
  }
}

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function parseNaive(str) {
  const m = NAIVE_RE.exec(str);
  if (!m) throw new Error(`Not a valid naive datetime string: "${str}"`);
  const [, y, mo, d, hh, mm] = m.map(Number);
  return Date.UTC(y, mo - 1, d, hh, mm);
}

function toNaive(ms) {
  const dt = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}` +
    `T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`
  );
}

function addMinutes(str, minutes) {
  return toNaive(parseNaive(str) + minutes * 60_000);
}

function addDays(str, days) {
  return addMinutes(str, days * 24 * 60);
}

function dayOfWeekOf(ms) {
  return new Date(ms).getUTCDay(); // 0 = Sunday, matches tech_availability.day_of_week
}

function startOfDay(ms) {
  const dt = new Date(ms);
  return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Current wall-clock time in a business's own timezone, as a naive
 * "YYYY-MM-DDTHH:MM" string — the same shape as every other datetime this
 * module works with. Uses Node's built-in Intl (same approach already used
 * in compliance/quietHours.js), so no timezone-data dependency is needed.
 */
export function nowInBusinessTimezone(timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour; // Intl can format midnight as "24"
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/**
 * Real open slots across one or all of a business's technicians, within
 * [rangeStart, rangeEnd). Each candidate slot is `durationMinutes` long and
 * starts on a boundary within a technician's recurring weekly hours, minus
 * anything already booked and minus time off.
 *
 * @returns {Array<{technicianId:number, technicianName:string, start:string, end:string}>}
 *   sorted earliest-first. `start`/`end` are naive "YYYY-MM-DDTHH:MM" strings.
 */
export function getAvailableSlots({ businessId, rangeStart, rangeEnd, durationMinutes = 60, technicianId, now }) {
  if (!now) {
    // Deliberately no silent fallback to Date.now(): every other datetime
    // here is business-local wall-clock time, and Date.now() is UTC epoch
    // ms — mixing the two would silently offer/hide the wrong slots by
    // however many hours the business's timezone differs from UTC. Callers
    // must pass `now` from nowInBusinessTimezone(business.timezone).
    throw new Error('getAvailableSlots requires `now` — pass nowInBusinessTimezone(business.timezone)');
  }
  const rangeStartMs = parseNaive(rangeStart);
  const rangeEndMs = parseNaive(rangeEnd);
  const nowMs = parseNaive(now);

  const technicians = technicianId
    ? [getTechnician(technicianId)].filter(Boolean)
    : listTechnicians(businessId, { activeOnly: true });

  const existingAppointments = listAppointmentsInRange(businessId, rangeStart, rangeEnd, technicianId ? { technicianId } : {});

  const slots = [];

  for (const tech of technicians) {
    const availability = getTechAvailability(tech.id);
    if (availability.length === 0) continue;

    const timeOff = listTimeOff(tech.id, rangeStart, rangeEnd);
    const techAppointments = existingAppointments.filter((a) => a.technician_id === tech.id);

    // Walk day by day across the requested range.
    for (let dayMs = startOfDay(rangeStartMs); dayMs < rangeEndMs; dayMs += 24 * 60 * 60_000) {
      const dow = dayOfWeekOf(dayMs);
      const windowsToday = availability.filter((a) => a.day_of_week === dow);

      for (const window of windowsToday) {
        const windowStartMs = dayMs + window.start_minute * 60_000;
        const windowEndMs = dayMs + window.end_minute * 60_000;

        for (let slotStartMs = windowStartMs; slotStartMs + durationMinutes * 60_000 <= windowEndMs; slotStartMs += durationMinutes * 60_000) {
          const slotEndMs = slotStartMs + durationMinutes * 60_000;

          if (slotStartMs < rangeStartMs || slotEndMs > rangeEndMs) continue;
          if (slotStartMs < nowMs) continue; // never offer a slot in the past

          const blockedByAppointment = techAppointments.some((a) =>
            overlaps(slotStartMs, slotEndMs, parseNaive(a.scheduled_at), parseNaive(a.ends_at))
          );
          if (blockedByAppointment) continue;

          const blockedByTimeOff = timeOff.some((t) =>
            overlaps(slotStartMs, slotEndMs, parseNaive(t.start_at), parseNaive(t.end_at))
          );
          if (blockedByTimeOff) continue;

          slots.push({
            technicianId: tech.id,
            technicianName: tech.name,
            start: toNaive(slotStartMs),
            end: toNaive(slotEndMs),
          });
        }
      }
    }
  }

  slots.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.technicianId - b.technicianId));
  return slots;
}

/** Re-checks one specific technician/slot right before booking, to close the race-condition window. */
export function isSlotAvailable({ businessId, technicianId, start, end }) {
  const startMs = parseNaive(start);
  const endMs = parseNaive(end);

  const tech = getTechnician(technicianId);
  if (!tech || !tech.active || tech.business_id !== businessId) return false;

  const dow = dayOfWeekOf(startMs);
  const availability = getTechAvailability(technicianId).filter((a) => a.day_of_week === dow);
  const dayStartMs = startOfDay(startMs);
  const withinWorkingHours = availability.some(
    (w) => startMs >= dayStartMs + w.start_minute * 60_000 && endMs <= dayStartMs + w.end_minute * 60_000
  );
  if (!withinWorkingHours) return false;

  const conflicting = listAppointmentsInRange(businessId, start, end, { technicianId });
  if (conflicting.some((a) => overlaps(startMs, endMs, parseNaive(a.scheduled_at), parseNaive(a.ends_at)))) return false;

  const timeOff = listTimeOff(technicianId, start, end);
  if (timeOff.some((t) => overlaps(startMs, endMs, parseNaive(t.start_at), parseNaive(t.end_at)))) return false;

  return true;
}

/**
 * Books a specific technician/slot. Re-validates availability first (the
 * customer may have taken a few minutes to reply, or two conversations could
 * pick the same slot at once) — throws SlotUnavailableError rather than
 * silently double-booking.
 */
export function bookAppointment({ businessId, customerId, conversationId, service, address, technicianId, start, durationMinutes = 60 }) {
  const end = addMinutes(start, durationMinutes);

  if (!isSlotAvailable({ businessId, technicianId, start, end })) {
    throw new SlotUnavailableError(`Technician ${technicianId} is not available ${start}–${end}`);
  }

  const tech = getTechnician(technicianId);
  return createAppointment({
    businessId,
    customerId,
    conversationId,
    service,
    address,
    scheduledAt: start,
    endsAt: end,
    durationMinutes,
    technicianId,
    technician: tech?.name,
  });
}

/** True once a business has at least one active technician with any working hours set. */
export function businessHasSchedulingConfigured(businessId) {
  return listTechnicians(businessId, { activeOnly: true }).some((t) => getTechAvailability(t.id).length > 0);
}

/** Finds an active technician by name (case-insensitive) for tool-calling code that only has a name, not an id. */
export function resolveTechnicianByName(businessId, name) {
  if (!name) return null;
  const needle = name.trim().toLowerCase();
  return listTechnicians(businessId, { activeOnly: true }).find((t) => t.name.trim().toLowerCase() === needle) || null;
}

export { addMinutes, addDays };
export const __internal = { parseNaive, toNaive, addMinutes, addDays, dayOfWeekOf, startOfDay, overlaps };
