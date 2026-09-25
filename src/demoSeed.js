// Public-demo seed. When DEMO_MODE=true and the database is empty, this
// creates one fictional HVAC business ("Coastline Air & Heat", Houston) with
// technicians, customers, SMS transcripts, consent history, appointments and
// a demo owner login — so the hosted dashboard has something real-looking to
// show the moment it boots. Everything is fictional (555 numbers, made-up
// names/addresses), and every date is computed RELATIVE TO NOW so the demo
// never looks stale: upcoming appointments are always in the next two weeks,
// completed ones always in the past week.
//
// Rows are inserted through db.prepare so each can carry a realistic
// created_at (the exported db.js helpers all default to datetime('now')).
// The demo owner is created through the same createUserInvite +
// hashPassword/setUserPassword path the real invite flow uses (see
// auth/auth.js acceptInvite), so /api/login works exactly as it does for a
// real owner.
//
// Idempotent: a second call finds businesses already present and does
// nothing. On Render's free plan (no disk) the DB lives in /tmp, so every
// restart starts empty and re-seeds — that's by design for a demo.

import { createTechnician, createUserInvite, setUserPassword, getUserByEmail, getBusinessByPhone } from './db.js';
import { hashPassword } from './auth/auth.js';
import { FULL_CONSENT_WORDING, REPLY_TEXT_WORDING_TEMPLATE } from './compliance/consent.js';
import { randomBytes } from 'node:crypto';

export const DEMO_BUSINESS = {
  name: 'Coastline Air & Heat',
  phoneE164: '+17135550100',
  state: 'TX',
  timezone: 'America/Chicago',
};

// Same shape as src/businessConfig.example.js — the conversation engine
// reads these fields to build Bob's system prompt for this business.
export const DEMO_BUSINESS_CONFIG = {
  businessName: 'Coastline Air & Heat',
  tagline: 'Keeping Houston cool since 2009.',

  hours: {
    monday: '7:00 AM–7:00 PM',
    tuesday: '7:00 AM–7:00 PM',
    wednesday: '7:00 AM–7:00 PM',
    thursday: '7:00 AM–7:00 PM',
    friday: '7:00 AM–7:00 PM',
    saturday: '7:00 AM–7:00 PM',
    sunday: 'Closed',
  },

  serviceArea: ['Houston', 'Sugar Land', 'Spring', 'Katy', 'Pearland', 'Bellaire'],

  services: [
    { name: 'AC repair', typicalPrice: '$89 diagnostic + parts/labor' },
    { name: 'AC maintenance / tune-up', typicalPrice: '$129' },
    { name: 'Thermostat replacement', typicalPrice: '$249 installed (standard smart thermostat)' },
    { name: 'Duct inspection', typicalPrice: '$99' },
    { name: 'New system install', typicalPrice: 'Free on-site quote' },
    { name: 'Emergency after-hours service', typicalPrice: '$189 diagnostic' },
  ],

  // Informational only — real scheduling lives in the technicians /
  // tech_availability tables seeded below (see businessConfig.example.js).
  technicians: ['Mike R.', 'Dana P.', 'Luis T.'],

  emergencyPolicy:
    'For no-cooling calls in extreme heat, or any home with an elderly resident, infant, or medical condition, ' +
    'treat as urgent: offer same-day service if a slot is open, otherwise the first slot next morning.',

  bookingNotes:
    'Always confirm the service address and preferred time window before calling it booked. ' +
    'If unsure about pricing for a job, say a technician will confirm on-site rather than guessing.',

  escalation: {
    phrase: "Let me get one of our team to follow up with you on that.",
  },
};

const STOP_CONFIRM = "You're unsubscribed and won't receive any more texts from us. Reply START to opt back in.";

// ---- Date helpers -----------------------------------------------------------
// Two formats are in play, matching what the rest of the app writes:
//   * created_at / started_at columns: SQLite datetime('now') style,
//     'YYYY-MM-DD HH:MM:SS' in UTC.
//   * appointments.scheduled_at / ends_at / tech_time_off: naive
//     'YYYY-MM-DDTHH:MM' wall-clock strings in the business's timezone
//     (see booking/scheduler.js).

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sqlTs(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD' for `date` as seen on a wall clock in `timezone`. */
function localDateIso(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dayOfWeekOf(dayIso) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Minutes east of UTC for `timezone` at instant `date` (e.g. -300 for CDT). */
function tzOffsetMinutes(date, timezone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName').value; // "GMT-05:00" or "GMT"
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** A Date for wall-clock `hhmm` on local day `dayIso` in `timezone`. */
function localToUtc(dayIso, hhmm, timezone) {
  const [y, m, d] = dayIso.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - tzOffsetMinutes(new Date(guess), timezone) * 60_000);
}

function addMinutesNaive(dayIso, hhmm, minutes) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const total = hh * 60 + mm + minutes;
  return `${dayIso}T${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fmtHour(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** "Fri 9/25 9:00 AM" — how Bob lists slots in a text. */
function slotLabel(dayIso, hhmm) {
  const [, m, d] = dayIso.split('-').map(Number);
  return `${WEEKDAY_SHORT[dayOfWeekOf(dayIso)]} ${m}/${d} ${fmtHour(hhmm)}`;
}

/** "Fri Sep 25 at 9:00 AM" — how Bob confirms a booking. */
function bookedLabel(dayIso, hhmm) {
  const [, m, d] = dayIso.split('-').map(Number);
  return `${WEEKDAY_SHORT[dayOfWeekOf(dayIso)]} ${MONTH_SHORT[m - 1]} ${d} at ${fmtHour(hhmm)}`;
}

/**
 * Builds the relative calendar used by the seed: `day(offset)` is the local
 * calendar date `offset` days from now; nextWorkday/prevWorkday step until a
 * day the technicians actually work (Mon–Fri, or Mon–Sat when allowSat).
 */
function makeCalendar(now, timezone) {
  const day = (offset) => localDateIso(new Date(now.getTime() + offset * DAY_MS), timezone);
  const isWorkday = (dayIso, allowSat) => {
    const dow = dayOfWeekOf(dayIso);
    return dow >= 1 && dow <= (allowSat ? 6 : 5);
  };
  const nextWorkday = (offset, { allowSat = false } = {}) => {
    let o = offset;
    while (!isWorkday(day(o), allowSat)) o += 1;
    return { iso: day(o), offset: o };
  };
  const prevWorkday = (offset, { allowSat = false } = {}) => {
    let o = offset;
    while (!isWorkday(day(o), allowSat)) o -= 1;
    return { iso: day(o), offset: o };
  };
  return { day, nextWorkday, prevWorkday };
}

// ---- The seed -----------------------------------------------------------------

/**
 * @param {import('node:sqlite').DatabaseSync} db  the app's open database
 * @param {object} cfg  the app config (demoMode, demoOwnerEmail, demoOwnerPassword)
 * @param {object} [opts]
 * @param {Date} [opts.now]  injectable clock for tests
 * @returns {{seeded: boolean, reason?: string, businessId?: number, ownerEmail?: string}}
 */
export function seedDemoIfEmpty(db, cfg, { now = new Date() } = {}) {
  if (!cfg.demoMode) return { seeded: false, reason: 'demo_mode_off' };

  const ownerEmail = cfg.demoOwnerEmail || 'demo@hellobob.example';
  const ownerPassword = cfg.demoOwnerPassword || 'demo2';

  const businessCount = db.prepare(`SELECT COUNT(*) AS n FROM businesses`).get().n;
  if (businessCount > 0) {
    // Data is already there. The one repair we do make: if the demo
    // business exists but its owner login somehow doesn't (e.g. DEMO_MODE
    // was switched on after a manual setup), create the login so the
    // published demo credentials keep working.
    const existing = getBusinessByPhone(DEMO_BUSINESS.phoneE164);
    if (existing && !getUserByEmail(ownerEmail)) {
      createDemoOwner(existing.id, ownerEmail, ownerPassword);
    }
    console.log('[demo] demo data present');
    return { seeded: false, reason: 'not_empty', businessId: existing?.id, ownerEmail };
  }

  const tz = DEMO_BUSINESS.timezone;
  const cal = makeCalendar(now, tz);
  const ago = (minutes) => new Date(now.getTime() - minutes * 60_000);
  const at = (dayIso, hhmm, plusMinutes = 0) => new Date(localToUtc(dayIso, hhmm, tz).getTime() + plusMinutes * 60_000);

  db.exec('BEGIN');
  try {
    // ---- Business + owner
    const bInfo = db.prepare(
      `INSERT INTO businesses (name, phone_e164, state, timezone, config_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(DEMO_BUSINESS.name, DEMO_BUSINESS.phoneE164, DEMO_BUSINESS.state, tz,
      JSON.stringify(DEMO_BUSINESS_CONFIG), sqlTs(ago(60 * 24 * 21)));
    const B = Number(bInfo.lastInsertRowid);
    createDemoOwner(B, ownerEmail, ownerPassword);

    const TEXT_BACK = REPLY_TEXT_WORDING_TEMPLATE(DEMO_BUSINESS.name);

    // ---- Technicians: Mon–Fri 7:00–19:00 (Luis starts at 8); Dana also Sat 8–14.
    const weekday = (s, e) => [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, startMinute: s, endMinute: e }));
    const techs = {};
    // Same rows setTechAvailability() writes, inserted directly because that
    // helper opens its own transaction and we're already inside one.
    const insertRule = db.prepare(
      `INSERT INTO tech_availability (technician_id, day_of_week, start_minute, end_minute) VALUES (?, ?, ?, ?)`
    );
    for (const [name, rules] of [
      ['Mike R.', weekday(420, 1140)],
      ['Dana P.', [...weekday(420, 1140), { dayOfWeek: 6, startMinute: 480, endMinute: 840 }]],
      ['Luis T.', weekday(480, 1140)],
    ]) {
      const t = createTechnician(B, name);
      for (const r of rules) insertRule.run(t.id, r.dayOfWeek, r.startMinute, r.endMinute);
      techs[name] = t;
    }
    // One-off time off next week so that part of the data isn't empty either.
    const dayOff = cal.nextWorkday(7).iso;
    db.prepare(`INSERT INTO tech_time_off (technician_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)`)
      .run(techs['Luis T.'].id, `${dayOff}T07:00`, `${dayOff}T19:00`, 'Day off');

    // ---- Row helpers (all with explicit timestamps)
    const customer = (phone, name, createdAt) => Number(
      db.prepare(`INSERT INTO customers (business_id, phone_e164, name, created_at) VALUES (?, ?, ?, ?)`)
        .run(B, phone, name, sqlTs(createdAt)).lastInsertRowid
    );
    const consent = (customerId, type, status, wording, source, createdAt) =>
      db.prepare(`INSERT INTO consent_records (business_id, customer_id, type, status, wording, source, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(B, customerId, type, status, wording, source, sqlTs(createdAt));
    const conversation = (customerId, status, startedAt, lastInboundAt) => Number(
      db.prepare(`INSERT INTO conversations (business_id, customer_id, channel, status, started_at, last_inbound_at)
                  VALUES (?, ?, 'sms', ?, ?, ?)`).run(B, customerId, status, sqlTs(startedAt), sqlTs(lastInboundAt)).lastInsertRowid
    );
    const msg = (convId, direction, body, category, createdAt) =>
      db.prepare(`INSERT INTO messages (conversation_id, direction, body, category, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(convId, direction, body, category, sqlTs(createdAt));
    const appt = ({ customerId, convId, service, address, day, time, tech, status, createdAt, minutes = 60 }) =>
      db.prepare(`INSERT INTO appointments (business_id, customer_id, conversation_id, service, address, scheduled_at, status,
                    technician, technician_id, duration_minutes, ends_at, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(B, customerId, convId, service, address, `${day}T${time}`, status, tech.name, tech.id, minutes,
          addMinutesNaive(day, time, minutes), sqlTs(createdAt));

    // ---- Customers (fictional 555 numbers)
    const mariaStart = ago(2 * 60 + 15);            // texted in about two hours ago
    const priyaStart = ago(40);                     // mid-conversation right now
    const derekAppt = cal.prevWorkday(-3);          // job done a few days ago
    const derekStart = at(derekAppt.iso, '08:12', -24 * 60); // called the day before the job
    const jamesAppt = cal.prevWorkday(-4);
    const tomAppt = cal.prevWorkday(-2);
    const angelaCancelled = cal.prevWorkday(-1);

    const maria = customer('+17135550147', 'Maria Gonzalez', mariaStart);
    const derek = customer('+12815550183', 'Derek Thompson', derekStart);
    const priya = customer('+18325550162', 'Priya Natarajan', priyaStart);
    const james = customer('+17135550109', 'James Whitfield', ago(60 * 24 * 7 + 95));
    const angela = customer('+12815550171', 'Angela Okafor', ago(60 * 24 * 6 + 130));
    const tom = customer('+18325550128', 'Tom Reyes', ago(60 * 24 * 8 + 40));

    // ---- Conversation 1: Maria — missed call → warm air → urgent → real slots → booked + consent YES
    {
      const t0 = mariaStart;
      const m = (n) => new Date(t0.getTime() + n * 1000); // seconds after the missed call
      const bookDay = cal.nextWorkday(1);
      const altDay = cal.nextWorkday(bookDay.offset + 1, { allowSat: true });
      const c = conversation(maria, 'booked', t0, m(11 * 60 + 46));
      consent(maria, 'reply', 'granted', TEXT_BACK, 'missed_call_text', t0);
      msg(c, 'outbound', TEXT_BACK, 'reply_only', m(1));
      msg(c, 'inbound', "Hi yes - our AC is running but it's blowing warm air. House is at 84 and climbing.", 'reply_only', m(138));
      msg(c, 'outbound', "Sorry to hear that, especially in this heat. Can I get the service address, and is anyone in the home who's at risk in the heat (elderly, infants, a medical condition)?", 'reply_only', m(142));
      msg(c, 'inbound', '4412 Bellaire Blvd, Houston 77035. My mom is 78 and lives with us.', 'reply_only', m(289));
      msg(c, 'outbound', `Got it, I'll treat this as urgent. Here are the earliest openings: ${slotLabel(bookDay.iso, '09:00')} with Mike R., ${slotLabel(bookDay.iso, '13:00')} with Luis T., or ${slotLabel(altDay.iso, '08:00')} with Dana P. Which works best?`, 'reply_only', m(296));
      const bookDayWord = bookDay.offset === 1 ? 'tomorrow' : WEEKDAY_LONG[dayOfWeekOf(bookDay.iso)];
      msg(c, 'inbound', `9am ${bookDayWord} works`, 'reply_only', m(485));
      msg(c, 'outbound', `You're booked: ${bookedLabel(bookDay.iso, '09:00')}, AC repair at 4412 Bellaire Blvd with Mike R. He'll text when he's on the way.`, 'reply_only', m(490));
      msg(c, 'outbound', FULL_CONSENT_WORDING, 'reply_only', m(491));
      msg(c, 'inbound', 'Yes', 'reply_only', m(11 * 60 + 46));
      consent(maria, 'full', 'granted', FULL_CONSENT_WORDING, 'booking_ask', m(11 * 60 + 46));
      msg(c, 'outbound', `Thanks Maria, you're all set. See you ${bookDayWord} morning.`, 'transactional', m(11 * 60 + 48));
      appt({ customerId: maria, convId: c, service: 'AC repair — blowing warm air', address: '4412 Bellaire Blvd, Houston 77035',
        day: bookDay.iso, time: '09:00', tech: techs['Mike R.'], status: 'confirmed', createdAt: m(490), minutes: 90 });
    }

    // ---- Conversation 2: Derek — booked, job done, review request → STOP (opt-out)
    {
      const t0 = derekStart;
      const m = (n) => new Date(t0.getTime() + n * 1000);
      const alt = cal.nextWorkday(derekAppt.offset + 1);
      const onMyWay = at(derekAppt.iso, '16:00', -22);
      const review = at(derekAppt.iso, '16:00', 24 * 60 + 5);
      const stopAt = new Date(review.getTime() + 5 * 60_000 + 33_000);
      const c = conversation(derek, 'closed', t0, stopAt);
      consent(derek, 'reply', 'granted', TEXT_BACK, 'missed_call_text', t0);
      msg(c, 'outbound', TEXT_BACK, 'reply_only', m(1));
      msg(c, 'inbound', 'The outside unit is making a loud grinding noise when it kicks on', 'reply_only', m(142));
      msg(c, 'outbound', "Thanks for the details. Is it still cooling, and what's the service address?", 'reply_only', m(146));
      msg(c, 'inbound', 'Still cooling for now. 8810 Cypresswood Dr, Spring 77379', 'reply_only', m(304));
      msg(c, 'outbound', `Here are the next openings: ${slotLabel(derekAppt.iso, '16:00')} with Dana P., ${slotLabel(alt.iso, '08:00')} with Mike R., or ${slotLabel(alt.iso, '11:00')} with Luis T. Which works?`, 'reply_only', m(310));
      msg(c, 'inbound', `${WEEKDAY_SHORT[dayOfWeekOf(derekAppt.iso)]} at 4`, 'reply_only', m(455));
      msg(c, 'outbound', `You're booked: ${bookedLabel(derekAppt.iso, '16:00')}, AC repair at 8810 Cypresswood Dr with Dana P.`, 'reply_only', m(459));
      msg(c, 'outbound', FULL_CONSENT_WORDING, 'reply_only', m(460));
      msg(c, 'inbound', 'yes', 'reply_only', m(502));
      consent(derek, 'full', 'granted', FULL_CONSENT_WORDING, 'booking_ask', m(502));
      msg(c, 'outbound', 'Hi Derek, Dana is on the way and should be there in about 20 minutes.', 'transactional', onMyWay);
      msg(c, 'outbound', "How did everything go with Dana yesterday? If you have a minute, we'd really appreciate a quick Google review.", 'transactional', review);
      msg(c, 'inbound', 'STOP', 'reply_only', stopAt);
      db.prepare(`INSERT INTO opt_outs (business_id, customer_id, reason, created_at) VALUES (?, ?, ?, ?)`)
        .run(B, derek, 'customer texted: "STOP"', sqlTs(stopAt));
      for (const type of ['reply', 'full', 'promotional']) consent(derek, type, 'revoked', 'STOP', 'stop_keyword', stopAt);
      msg(c, 'outbound', STOP_CONFIRM, 'reply_only', new Date(stopAt.getTime() + 1000));
      appt({ customerId: derek, convId: c, service: 'AC repair — grinding condenser', address: '8810 Cypresswood Dr, Spring 77379',
        day: derekAppt.iso, time: '16:00', tech: techs['Dana P.'], status: 'complete', createdAt: m(459) });
    }

    // ---- Conversation 3: Priya — open, mid-conversation (system replacement quote)
    {
      const t0 = priyaStart;
      const m = (n) => new Date(t0.getTime() + n * 1000);
      const c = conversation(priya, 'open', t0, m(386));
      consent(priya, 'reply', 'granted', TEXT_BACK, 'missed_call_text', t0);
      msg(c, 'outbound', TEXT_BACK, 'reply_only', m(1));
      msg(c, 'inbound', "Hi, I'm looking to get a quote on replacing our whole system. It's about 15 years old.", 'reply_only', m(195));
      msg(c, 'outbound', 'Happy to help. For a replacement we do a free on-site quote. Can I get the address, and is it a single-story or two-story home?', 'reply_only', m(200));
      msg(c, 'inbound', 'Two-story in Sugar Land, around 2,800 sq ft. 1907 Lakefield Dr.', 'reply_only', m(386));
      msg(c, 'outbound', "Thanks. Do mornings or afternoons work better for the visit? I'll check what's open this week and next.", 'reply_only', m(391));
    }

    // ---- Other customers: consent on file + appointments across the past week / next two weeks
    const jamesCreated = ago(60 * 24 * 7 + 95);
    const angelaCreated = ago(60 * 24 * 6 + 130);
    const tomCreated = ago(60 * 24 * 8 + 40);
    consent(james, 'reply', 'granted', TEXT_BACK, 'missed_call_text', jamesCreated);
    consent(james, 'full', 'granted', FULL_CONSENT_WORDING, 'booking_ask', new Date(jamesCreated.getTime() + 9 * 60_000));
    consent(angela, 'reply', 'granted', TEXT_BACK, 'missed_call_text', angelaCreated);
    consent(angela, 'full', 'granted', FULL_CONSENT_WORDING, 'booking_ask', new Date(angelaCreated.getTime() + 8 * 60_000));
    consent(tom, 'reply', 'granted', TEXT_BACK, 'missed_call_text', tomCreated);
    consent(tom, 'full', 'granted', FULL_CONSENT_WORDING, 'booking_ask', new Date(tomCreated.getTime() + 11 * 60_000));

    // Past week: completed jobs.
    appt({ customerId: james, convId: null, service: 'AC tune-up', address: '3315 Braeswood Blvd, Houston 77025',
      day: jamesAppt.iso, time: '10:00', tech: techs['Dana P.'], status: 'complete', createdAt: new Date(jamesCreated.getTime() + 9 * 60_000) });
    appt({ customerId: tom, convId: null, service: 'AC repair — short cycling', address: '12207 Westheimer Rd, Houston 77077',
      day: tomAppt.iso, time: '13:00', tech: techs['Luis T.'], status: 'complete', createdAt: new Date(tomCreated.getTime() + 11 * 60_000), minutes: 90 });
    // One cancelled, then rebooked.
    appt({ customerId: angela, convId: null, service: 'Thermostat replacement', address: '5514 Kirby Dr, Houston 77005',
      day: angelaCancelled.iso, time: '15:00', tech: techs['Mike R.'], status: 'cancelled', createdAt: new Date(angelaCreated.getTime() + 8 * 60_000) });
    // Next two weeks: confirmed.
    appt({ customerId: angela, convId: null, service: 'Thermostat replacement', address: '5514 Kirby Dr, Houston 77005',
      day: cal.nextWorkday(4).iso, time: '08:00', tech: techs['Mike R.'], status: 'confirmed', createdAt: ago(60 * 26) });
    appt({ customerId: tom, convId: null, service: 'Duct inspection', address: '12207 Westheimer Rd, Houston 77077',
      day: cal.nextWorkday(6).iso, time: '11:00', tech: techs['Dana P.'], status: 'confirmed', createdAt: ago(60 * 51) });
    appt({ customerId: james, convId: null, service: 'Fall furnace check', address: '3315 Braeswood Blvd, Houston 77025',
      day: cal.nextWorkday(9).iso, time: '14:00', tech: techs['Luis T.'], status: 'confirmed', createdAt: ago(60 * 20) });

    db.exec('COMMIT');
    console.log('[demo] seeded demo business');
    return { seeded: true, businessId: B, ownerEmail };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Same path acceptInvite() takes: invite row → scrypt hash → password set, token cleared. */
function createDemoOwner(businessId, email, password) {
  const user = createUserInvite({
    businessId,
    email,
    inviteToken: randomBytes(32).toString('hex'),
    inviteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  setUserPassword(user.id, hashPassword(password));
  return user;
}
