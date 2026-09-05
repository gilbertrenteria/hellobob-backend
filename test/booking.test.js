// Covers the in-house booking engine (src/booking/scheduler.js): real slot
// generation from a technician's recurring weekly hours, conflict avoidance
// against existing appointments and time off, and the double-booking guard
// at actual booking time.

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const {
  createBusiness, upsertCustomer, createTechnician, setTechAvailability, addTimeOff,
} = await import('../src/db.js');
const { getAvailableSlots, isSlotAvailable, bookAppointment, SlotUnavailableError } = await import('../src/booking/scheduler.js');

// Mon 2026-09-07, Tue 2026-09-08, Sat 2026-09-12, Sun 2026-09-13 — fixed so
// day-of-week math in the test matches what setTechAvailability configures.
const MON = '2026-09-07';
const TUE = '2026-09-08';
const SAT = '2026-09-12';

let business;
let mike;
let dave;

before(() => {
  business = createBusiness({ name: 'Desert Air', phoneE164: '+16195550100', state: 'CA', config: {} });
  mike = createTechnician(business.id, 'Mike');
  dave = createTechnician(business.id, 'Dave');

  // Mike: Mon–Fri, 9am–5pm (540–1020 minutes after midnight).
  setTechAvailability(mike.id, [1, 2, 3, 4, 5]
    .map((dayOfWeek) => ({ dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60 })));

  // Dave: Mon only, 1pm–3pm — a short window, to test multi-tech merging.
  setTechAvailability(dave.id, [{ dayOfWeek: 1, startMinute: 13 * 60, endMinute: 15 * 60 }]);
});

function customer(phone = '+16195551234') {
  return upsertCustomer(business.id, phone, 'Jane Homeowner');
}

test('generates hourly slots within a technician\'s working hours, none outside it', () => {
  const slots = getAvailableSlots({
    businessId: business.id,
    rangeStart: `${MON}T00:00`,
    rangeEnd: `${MON}T23:59`,
    durationMinutes: 60,
    technicianId: mike.id,
    now: `${MON}T00:00`,
  });
  assert.equal(slots.length, 8); // 9,10,11,12,13,14,15,16 (last slot 16-17)
  assert.equal(slots[0].start, `${MON}T09:00`);
  assert.equal(slots[slots.length - 1].start, `${MON}T16:00`);
  assert.ok(slots.every((s) => s.technicianId === mike.id));
});

test('no slots on a day with no configured availability (weekend)', () => {
  const slots = getAvailableSlots({
    businessId: business.id,
    rangeStart: `${SAT}T00:00`,
    rangeEnd: `${SAT}T23:59`,
    durationMinutes: 60,
    now: `${SAT}T00:00`,
  });
  assert.equal(slots.length, 0);
});

test('merges slots across multiple technicians, sorted by start time then technician', () => {
  const slots = getAvailableSlots({
    businessId: business.id,
    rangeStart: `${MON}T00:00`,
    rangeEnd: `${MON}T23:59`,
    durationMinutes: 60,
    now: `${MON}T00:00`,
  });
  // Mike has 8 slots all day; Dave adds 2 more (1-2pm, 2-3pm) on Monday only.
  assert.equal(slots.length, 10);
  const at1pm = slots.filter((s) => s.start === `${MON}T13:00`);
  assert.equal(at1pm.length, 2);
  assert.deepEqual(at1pm.map((s) => s.technicianName).sort(), ['Dave', 'Mike']);
});

test('booking a slot removes it from later availability results, and double-booking is rejected', () => {
  const cust = customer();
  bookAppointment({
    businessId: business.id,
    customerId: cust.id,
    conversationId: null,
    service: 'AC repair',
    address: '123 Main St',
    technicianId: mike.id,
    start: `${TUE}T10:00`,
    durationMinutes: 60,
  });

  const slotsAfter = getAvailableSlots({
    businessId: business.id,
    rangeStart: `${TUE}T00:00`,
    rangeEnd: `${TUE}T23:59`,
    durationMinutes: 60,
    technicianId: mike.id,
    now: `${TUE}T00:00`,
  });
  assert.ok(!slotsAfter.some((s) => s.start === `${TUE}T10:00`), '10am should no longer be offered');
  assert.equal(isSlotAvailable({ businessId: business.id, technicianId: mike.id, start: `${TUE}T10:00`, end: `${TUE}T11:00` }), false);

  assert.throws(
    () => bookAppointment({
      businessId: business.id,
      customerId: cust.id,
      service: 'Second booking attempt',
      technicianId: mike.id,
      start: `${TUE}T10:00`,
      durationMinutes: 60,
    }),
    SlotUnavailableError
  );
});

test('time off blocks slots for just that technician, not others', () => {
  addTimeOff(mike.id, `${MON}T09:00`, `${MON}T12:00`, 'Vacation');

  const mikeSlots = getAvailableSlots({
    businessId: business.id,
    rangeStart: `${MON}T00:00`,
    rangeEnd: `${MON}T23:59`,
    durationMinutes: 60,
    technicianId: mike.id,
    now: `${MON}T00:00`,
  });
  assert.ok(mikeSlots.every((s) => s.start >= `${MON}T12:00`), 'nothing before noon for Mike');

  const daveSlots = getAvailableSlots({
    businessId: business.id,
    rangeStart: `${MON}T00:00`,
    rangeEnd: `${MON}T23:59`,
    durationMinutes: 60,
    technicianId: dave.id,
    now: `${MON}T00:00`,
  });
  assert.equal(daveSlots.length, 2, 'Dave is unaffected by Mike\'s time off');
});

test('never offers a slot before `now`', () => {
  const slots = getAvailableSlots({
    businessId: business.id,
    rangeStart: `${MON}T00:00`,
    rangeEnd: `${MON}T23:59`,
    durationMinutes: 60,
    technicianId: dave.id,
    now: `${MON}T14:00`, // Dave's window is 13:00-15:00; only the 14:00 slot should remain
  });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].start, `${MON}T14:00`);
});

test('booking against an inactive/unknown technician is rejected', () => {
  assert.throws(
    () => bookAppointment({
      businessId: business.id,
      customerId: customer('+16195559999').id,
      service: 'AC repair',
      technicianId: 999999,
      start: `${MON}T09:00`,
      durationMinutes: 60,
    }),
    SlotUnavailableError
  );
});
