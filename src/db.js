// Database layer, built on Node's own built-in `node:sqlite` (stable enough
// for this MVP, no native compile step, no npm dependency). If you outgrow
// SQLite later (multiple app servers, heavy concurrent writes), swap this
// file for a Postgres client — every other module only talks to the small
// set of functions exported here, not to SQL directly.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

const dbDir = dirname(config.dbPath);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// SQLite's datetime('now') / datetime(x, '+N days') produce "YYYY-MM-DD
// HH:MM:SS" in UTC with no offset marker. Parsed by hand (same spirit as
// booking/scheduler.js's parseNaive) rather than handed to `new Date()`,
// since date-string parsing without a 'T'/'Z' is implementation-defined
// across JS engines/versions.
const SQLITE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
export function sqliteDatetimeToMs(str) {
  const m = SQLITE_DATETIME_RE.exec(str);
  if (!m) throw new Error(`Not a valid SQLite datetime string: "${str}"`);
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  return Date.UTC(y, mo - 1, d, hh, mm, ss);
}

// ---- Schema ---------------------------------------------------------------
// Mirrors the design worked out in the planning docs: reply-consent and
// full-texting-consent are tracked as separate rows so "yes to reminders"
// and "replied to a missed-call text" are never conflated. Every consent
// change is inserted as a new row (never updated in place) so there's a
// full, timestamped history — the exact wording shown is stored with it.

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone_e164 TEXT NOT NULL UNIQUE,     -- the Twilio number customers text/call
    state TEXT,                          -- 2-letter state code, drives stateRules.js
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    quiet_hours_start INTEGER,           -- overrides config default if set
    quiet_hours_end INTEGER,
    config_json TEXT NOT NULL,           -- BusinessConfig, see businessConfig.example.js
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    phone_e164 TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(business_id, phone_e164)
  );

  -- One row per consent EVENT, not per customer — never UPDATEd, only
  -- inserted, so history is preserved. "current" state = most recent row
  -- per (customer_id, type).
  CREATE TABLE IF NOT EXISTS consent_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    type TEXT NOT NULL CHECK (type IN ('reply', 'full', 'promotional')),
    status TEXT NOT NULL CHECK (status IN ('granted', 'declined', 'revoked')),
    wording TEXT NOT NULL,               -- exact text shown to the customer
    source TEXT NOT NULL,                -- 'missed_call_text' | 'booking_ask' | 'stop_keyword' | ...
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    channel TEXT NOT NULL DEFAULT 'sms', -- 'sms' | 'website_chat' | 'voice_missed_call'
    status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'booked' | 'needs_human' | 'closed'
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_inbound_at TEXT               -- used for the "direct reply" quiet-hours exception
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    body TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'transactional', -- 'transactional' | 'promotional' | 'reply_only'
    twilio_sid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    conversation_id INTEGER REFERENCES conversations(id),
    service TEXT NOT NULL,
    address TEXT,
    scheduled_at TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'complete' | 'cancelled'
    technician TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- In-house booking engine (see src/booking/scheduler.js). A business can
  -- have several technicians, each with their own recurring weekly hours
  -- and one-off time off — this is what lets Bob check REAL availability
  -- instead of just recording whatever time a human already agreed to.
  CREATE TABLE IF NOT EXISTS technicians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Recurring weekly working windows. A technician can have more than one
  -- row per day (e.g. a split shift), so this is one window per row, not
  -- one row per technician.
  CREATE TABLE IF NOT EXISTS tech_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    technician_id INTEGER NOT NULL REFERENCES technicians(id),
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
    start_minute INTEGER NOT NULL, -- minutes after midnight, business-local wall clock
    end_minute INTEGER NOT NULL,
    CHECK (end_minute > start_minute)
  );

  -- One-off blocks (vacation, a holiday, a half-day) that override the
  -- recurring weekly hours above for a specific date/time range.
  CREATE TABLE IF NOT EXISTS tech_time_off (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    technician_id INTEGER NOT NULL REFERENCES technicians(id),
    start_at TEXT NOT NULL, -- ISO datetime, business-local wall clock (naive, no offset)
    end_at TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS opt_outs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Prospective HelloBob customers captured by the "Ask Bob" marketing-site
  -- chat (see webchat/websiteChat.js) — NOT one of the 'businesses' rows
  -- above. 'businesses' is an already-onboarded HelloBob customer whose own
  -- customers Bob talks to over SMS; 'signups' is someone who just told the
  -- marketing-site chat they want to sign up FOR HelloBob itself. Nothing
  -- here is Jotform, or any other third party — the quick sign-up AND the
  -- detailed Guided Setup / Website Builder forms are all our own pages
  -- (docs/setup.html, docs/website-builder.html), submitting straight to
  -- this backend. See setupForms.js for how those two forms are handled.
  --
  -- setup_token: an unguessable per-signup token (not the row id) used in
  -- the setup/website-builder links we email/text out, so a signup can't be
  -- found or tampered with by guessing sequential ids.
  -- trial_ends_at: NULL until Guided Setup is completed — the 10-day free
  -- trial only starts once Bob is actually built and working, not at
  -- signup. Set once, to (completed_at + 10 days), in
  -- markGuidedSetupComplete(). This means every customer gets a full, fair
  -- 10 days of a working system, with no "were they late" special-casing.
  -- guided_setup_status / website_builder_status: 'pending' | 'completed'.
  -- website_builder_status also uses 'not_applicable' when the Guided Setup
  -- answer says they already have a website they don't want to change.
  -- reminder1/2/3_sent_at: timestamps for the day-2/5/8-since-SIGNUP nudges
  -- to finish Guided Setup (see reminders.js) — these fire before the trial
  -- has even started, so they're purely "finish your form," never
  -- trial/payment language. reminders_paused flips to 1 once a signup
  -- passes the abandonment cutoff without finishing — the row is never
  -- deleted, it just stops being on the automatic drip.
  -- trial_ending_reminder_sent_at: separate, later reminder sent once the
  -- trial (started by Guided Setup completion) is about to end — see
  -- reminders.js. This is the one that can mention payment.
  CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_pref TEXT NOT NULL DEFAULT 'email', -- 'email' | 'text' — which channel they asked for at signup
    source TEXT NOT NULL DEFAULT 'website_chat',
    status TEXT NOT NULL DEFAULT 'new', -- 'new' | 'onboarded' | 'abandoned'
    setup_token TEXT UNIQUE,
    trial_ends_at TEXT,
    guided_setup_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'completed'
    guided_setup_completed_at TEXT,
    website_choice TEXT, -- 'no_website' | 'wants_upgrade' | 'has_website' — set once Guided Setup is submitted
    website_builder_status TEXT NOT NULL DEFAULT 'not_applicable', -- 'not_applicable' | 'pending' | 'completed'
    website_builder_completed_at TEXT,
    reminder1_sent_at TEXT,
    reminder2_sent_at TEXT,
    reminder3_sent_at TEXT,
    reminders_paused INTEGER NOT NULL DEFAULT 0,
    trial_ending_reminder_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per Guided Setup or Website Builder submission. Kept separate
  -- from signups (rather than cramming JSON into a column there) so a
  -- resubmission or a future third form doesn't require a schema change —
  -- and so the full raw answers are always available for the admin
  -- "Approve & Activate" step even after signups.* has moved on.
  CREATE TABLE IF NOT EXISTS setup_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signup_id INTEGER NOT NULL REFERENCES signups(id),
    kind TEXT NOT NULL CHECK (kind IN ('guided_setup', 'website_builder')),
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Dashboard login. One business can have more than one user (an owner
  -- plus e.g. an office manager) later, but nothing here assumes that yet.
  -- password_hash is NULL until the invite is accepted — see auth/auth.js.
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    invite_token TEXT,
    invite_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_consent_lookup ON consent_records(business_id, customer_id, type, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_tech_availability ON tech_availability(technician_id, day_of_week);
  CREATE INDEX IF NOT EXISTS idx_tech_time_off ON tech_time_off(technician_id, start_at, end_at);
  CREATE INDEX IF NOT EXISTS idx_setup_submissions_signup ON setup_submissions(signup_id, kind);
`);

// ---- Migrations -------------------------------------------------------------
// SQLite has no "ADD COLUMN IF NOT EXISTS", so guard each ALTER by checking
// the table's current columns first. Runs once at boot; cheap either way.
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Added for the in-house booking engine: a real appointment now has a
// specific technician (by id, not just a free-text name) and a duration, so
// availability can be computed instead of just recorded. The old free-text
// `technician` column stays for display/back-compat with rows saved before
// this existed.
addColumnIfMissing('appointments', 'technician_id', 'technician_id INTEGER REFERENCES technicians(id)');
addColumnIfMissing('appointments', 'duration_minutes', 'duration_minutes INTEGER NOT NULL DEFAULT 60');
addColumnIfMissing('appointments', 'ends_at', 'ends_at TEXT');

// Added when the Jotform-based setup questionnaire was replaced with our own
// Guided Setup / Website Builder pages (docs/setup.html, docs/website-builder.html)
// submitting straight to this backend. See setup_submissions above and
// setupForms.js / reminders.js for how these are used.
addColumnIfMissing('signups', 'contact_pref', "contact_pref TEXT NOT NULL DEFAULT 'email'");
addColumnIfMissing('signups', 'setup_token', 'setup_token TEXT');
addColumnIfMissing('signups', 'trial_ends_at', 'trial_ends_at TEXT');
addColumnIfMissing('signups', 'guided_setup_status', "guided_setup_status TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing('signups', 'guided_setup_completed_at', 'guided_setup_completed_at TEXT');
addColumnIfMissing('signups', 'website_choice', 'website_choice TEXT');
addColumnIfMissing('signups', 'website_builder_status', "website_builder_status TEXT NOT NULL DEFAULT 'not_applicable'");
addColumnIfMissing('signups', 'website_builder_completed_at', 'website_builder_completed_at TEXT');
addColumnIfMissing('signups', 'reminder1_sent_at', 'reminder1_sent_at TEXT');
addColumnIfMissing('signups', 'reminder2_sent_at', 'reminder2_sent_at TEXT');
addColumnIfMissing('signups', 'reminder3_sent_at', 'reminder3_sent_at TEXT');
addColumnIfMissing('signups', 'reminders_paused', 'reminders_paused INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('signups', 'trial_ending_reminder_sent_at', 'trial_ending_reminder_sent_at TEXT');

// Backfill setup_token for any signup rows that existed before this
// migration (ALTER TABLE ADD COLUMN leaves it NULL) — every row needs a
// real token before setup.html/website-builder.html links can work for it.
// trial_ends_at is deliberately NOT backfilled here: under the current
// model it's only ever set by markGuidedSetupComplete(), and none of these
// pre-existing rows have completed Guided Setup through this flow yet, so
// NULL (no trial started) is the correct, honest state for them.
for (const row of db.prepare(`SELECT id FROM signups WHERE setup_token IS NULL`).all()) {
  db.prepare(`UPDATE signups SET setup_token = ? WHERE id = ?`).run(randomBytes(20).toString('hex'), row.id);
}

// ---- Small typed helpers ---------------------------------------------------
// Every other module goes through these instead of writing raw SQL, so the
// query shapes stay in one place.

export function upsertCustomer(businessId, phoneE164, name) {
  db.prepare(
    `INSERT INTO customers (business_id, phone_e164, name)
     VALUES (?, ?, ?)
     ON CONFLICT(business_id, phone_e164) DO UPDATE SET
       name = COALESCE(excluded.name, customers.name)`
  ).run(businessId, phoneE164, name || null);
  return db.prepare(`SELECT * FROM customers WHERE business_id = ? AND phone_e164 = ?`)
    .get(businessId, phoneE164);
}

export function getBusinessByPhone(phoneE164) {
  return db.prepare(`SELECT * FROM businesses WHERE phone_e164 = ?`).get(phoneE164);
}

export function getBusiness(id) {
  return db.prepare(`SELECT * FROM businesses WHERE id = ?`).get(id);
}

export function createBusiness({ name, phoneE164, state, timezone, config: cfg }) {
  const info = db.prepare(
    `INSERT INTO businesses (name, phone_e164, state, timezone, config_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(name, phoneE164, state || null, timezone || 'America/New_York', JSON.stringify(cfg));
  return getBusiness(Number(info.lastInsertRowid));
}

/** Most recent consent row of a given type for this customer, or null if none exists. */
export function getCurrentConsent(businessId, customerId, type) {
  return db.prepare(
    `SELECT * FROM consent_records
     WHERE business_id = ? AND customer_id = ? AND type = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(businessId, customerId, type) || null;
}

export function recordConsent({ businessId, customerId, type, status, wording, source }) {
  db.prepare(
    `INSERT INTO consent_records (business_id, customer_id, type, status, wording, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(businessId, customerId, type, status, wording, source);
}

export function isOptedOut(businessId, customerId) {
  const row = db.prepare(
    `SELECT id FROM opt_outs WHERE business_id = ? AND customer_id = ? LIMIT 1`
  ).get(businessId, customerId);
  return !!row;
}

export function recordOptOut(businessId, customerId, reason) {
  db.prepare(`INSERT INTO opt_outs (business_id, customer_id, reason) VALUES (?, ?, ?)`)
    .run(businessId, customerId, reason || 'customer replied STOP');
}

export function getOpenConversation(businessId, customerId, channel = 'sms') {
  return db.prepare(
    `SELECT * FROM conversations
     WHERE business_id = ? AND customer_id = ? AND channel = ? AND status != 'closed'
     ORDER BY started_at DESC LIMIT 1`
  ).get(businessId, customerId, channel);
}

export function createConversation(businessId, customerId, channel = 'sms') {
  const info = db.prepare(
    `INSERT INTO conversations (business_id, customer_id, channel) VALUES (?, ?, ?)`
  ).run(businessId, customerId, channel);
  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function getConversation(conversationId) {
  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId) || null;
}

export function touchConversationInbound(conversationId) {
  db.prepare(`UPDATE conversations SET last_inbound_at = datetime('now') WHERE id = ?`)
    .run(conversationId);
}

export function setConversationStatus(conversationId, status) {
  db.prepare(`UPDATE conversations SET status = ? WHERE id = ?`).run(status, conversationId);
}

export function addMessage({ conversationId, direction, body, category, twilioSid }) {
  db.prepare(
    `INSERT INTO messages (conversation_id, direction, body, category, twilio_sid)
     VALUES (?, ?, ?, ?, ?)`
  ).run(conversationId, direction, body, category || 'transactional', twilioSid || null);
}

export function getConversationMessages(conversationId, limit = 30) {
  return db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`
  ).all(conversationId, limit);
}

export function createAppointment({
  businessId, customerId, conversationId, service, address, scheduledAt, technician,
  technicianId, durationMinutes, endsAt,
}) {
  const info = db.prepare(
    `INSERT INTO appointments
       (business_id, customer_id, conversation_id, service, address, scheduled_at, technician,
        technician_id, duration_minutes, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    businessId, customerId, conversationId || null, service, address || null, scheduledAt || null, technician || null,
    technicianId || null, durationMinutes || 60, endsAt || null
  );
  return db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function listAppointments(businessId, limit = 50) {
  return db.prepare(
    `SELECT a.*, c.phone_e164, c.name AS customer_name
     FROM appointments a JOIN customers c ON c.id = a.customer_id
     WHERE a.business_id = ? ORDER BY a.created_at DESC LIMIT ?`
  ).all(businessId, limit);
}

/** Non-cancelled appointments that overlap [rangeStart, rangeEnd), for conflict checks. */
export function listAppointmentsInRange(businessId, rangeStart, rangeEnd, { technicianId } = {}) {
  const rows = db.prepare(
    `SELECT * FROM appointments
     WHERE business_id = ? AND status != 'cancelled'
       AND scheduled_at IS NOT NULL AND ends_at IS NOT NULL
       AND scheduled_at < ? AND ends_at > ?
       ${technicianId ? 'AND technician_id = ?' : ''}`
  ).all(...(technicianId ? [businessId, rangeEnd, rangeStart, technicianId] : [businessId, rangeEnd, rangeStart]));
  return rows;
}

// ---- Technicians & availability (in-house booking engine) -----------------

export function createTechnician(businessId, name) {
  const info = db.prepare(`INSERT INTO technicians (business_id, name) VALUES (?, ?)`).run(businessId, name);
  return db.prepare(`SELECT * FROM technicians WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function getTechnician(technicianId) {
  return db.prepare(`SELECT * FROM technicians WHERE id = ?`).get(technicianId);
}

export function listTechnicians(businessId, { activeOnly = true } = {}) {
  return db.prepare(
    `SELECT * FROM technicians WHERE business_id = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY id ASC`
  ).all(businessId);
}

export function setTechnicianActive(technicianId, active) {
  db.prepare(`UPDATE technicians SET active = ? WHERE id = ?`).run(active ? 1 : 0, technicianId);
}

/** Replaces ALL weekly availability rows for this technician with `rules`. */
export function setTechAvailability(technicianId, rules) {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM tech_availability WHERE technician_id = ?`).run(technicianId);
    const insert = db.prepare(
      `INSERT INTO tech_availability (technician_id, day_of_week, start_minute, end_minute) VALUES (?, ?, ?, ?)`
    );
    for (const rule of rules) {
      insert.run(technicianId, rule.dayOfWeek, rule.startMinute, rule.endMinute);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getTechAvailability(technicianId) {
  return db.prepare(
    `SELECT * FROM tech_availability WHERE technician_id = ? ORDER BY day_of_week ASC, start_minute ASC`
  ).all(technicianId);
}

export function addTimeOff(technicianId, startAt, endAt, reason) {
  const info = db.prepare(
    `INSERT INTO tech_time_off (technician_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)`
  ).run(technicianId, startAt, endAt, reason || null);
  return db.prepare(`SELECT * FROM tech_time_off WHERE id = ?`).get(Number(info.lastInsertRowid));
}

/** Time-off rows for this technician overlapping [rangeStart, rangeEnd). */
export function listTimeOff(technicianId, rangeStart, rangeEnd) {
  return db.prepare(
    `SELECT * FROM tech_time_off WHERE technician_id = ? AND start_at < ? AND end_at > ?`
  ).all(technicianId, rangeEnd, rangeStart);
}

export function listConversations(businessId, limit = 50) {
  return db.prepare(
    `SELECT conv.*, c.phone_e164, c.name AS customer_name
     FROM conversations conv JOIN customers c ON c.id = conv.customer_id
     WHERE conv.business_id = ? ORDER BY conv.started_at DESC LIMIT ?`
  ).all(businessId, limit);
}

export function listConsentForCustomer(businessId, customerId) {
  return db.prepare(
    `SELECT * FROM consent_records WHERE business_id = ? AND customer_id = ? ORDER BY created_at ASC`
  ).all(businessId, customerId);
}

export function createSignup({ businessName, contactEmail, contactPhone, contactPref, source }) {
  // trial_ends_at is deliberately NOT set here — the free trial only starts
  // once Guided Setup is completed (see markGuidedSetupComplete below), so
  // it stays NULL until then.
  const setupToken = randomBytes(20).toString('hex');
  const info = db.prepare(
    `INSERT INTO signups (business_name, contact_email, contact_phone, contact_pref, source, setup_token)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(businessName, contactEmail, contactPhone, contactPref === 'text' ? 'text' : 'email', source || 'website_chat', setupToken);
  return db.prepare(`SELECT * FROM signups WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function listSignups(limit = 100) {
  // created_at has only second-level resolution, so two signups saved within
  // the same second would otherwise tie — 'id DESC' as a tiebreaker keeps
  // this genuinely newest-first regardless.
  return db.prepare(`SELECT * FROM signups ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit);
}

export function getSignupByToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM signups WHERE setup_token = ?`).get(token) || null;
}

export function getSignupById(id) {
  return db.prepare(`SELECT * FROM signups WHERE id = ?`).get(id) || null;
}

export function saveSetupSubmission({ signupId, kind, data }) {
  db.prepare(
    `INSERT INTO setup_submissions (signup_id, kind, data_json) VALUES (?, ?, ?)`
  ).run(signupId, kind, JSON.stringify(data));
}

/** Most recent submission of this kind for a signup, parsed, or null. */
export function getLatestSubmission(signupId, kind) {
  const row = db.prepare(
    `SELECT * FROM setup_submissions WHERE signup_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(signupId, kind);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data_json) };
}

/**
 * Marks Guided Setup complete and STARTS THE TRIAL: trial_ends_at is set
 * here, to (now + 10 days), and only here — this is the one and only trial
 * clock, and it never runs before Bob is actually built and working. No
 * "were they late" special-casing needed: everyone gets a full, fair 10
 * days from this moment. websiteChoice is one of 'no_website' |
 * 'wants_upgrade' | 'has_website', which decides whether
 * website_builder_status becomes 'pending' or 'not_applicable'.
 */
export function markGuidedSetupComplete(signupId, websiteChoice) {
  const signup = getSignupById(signupId);
  if (!signup) return null;

  const needsWebsiteBuilder = websiteChoice === 'no_website' || websiteChoice === 'wants_upgrade';

  db.prepare(
    `UPDATE signups SET
       guided_setup_status = 'completed',
       guided_setup_completed_at = datetime('now'),
       website_choice = ?,
       website_builder_status = ?,
       trial_ends_at = datetime('now', '+10 days')
     WHERE id = ?`
  ).run(websiteChoice, needsWebsiteBuilder ? 'pending' : 'not_applicable', signupId);

  return getSignupById(signupId);
}

export function markWebsiteBuilderComplete(signupId) {
  db.prepare(
    `UPDATE signups SET website_builder_status = 'completed', website_builder_completed_at = datetime('now') WHERE id = ?`
  ).run(signupId);
}

export function markSignupOnboarded(signupId) {
  db.prepare(`UPDATE signups SET status = 'onboarded' WHERE id = ?`).run(signupId);
}

/**
 * Signups still mid-trial (not onboarded, not paused) whose Guided Setup
 * isn't done yet, for the hourly reminder sweep — see reminders.js, which
 * decides per row whether day 2/5/8 is actually due.
 */
export function listSignupsForReminderSweep() {
  return db.prepare(
    `SELECT * FROM signups
     WHERE status = 'new' AND guided_setup_status = 'pending' AND reminders_paused = 0`
  ).all();
}

export function markReminderSent(signupId, n) {
  const col = { 1: 'reminder1_sent_at', 2: 'reminder2_sent_at', 3: 'reminder3_sent_at' }[n];
  if (!col) throw new Error(`markReminderSent: invalid reminder number ${n}`);
  db.prepare(`UPDATE signups SET ${col} = datetime('now') WHERE id = ?`).run(signupId);
}

export function markRemindersPaused(signupId) {
  db.prepare(`UPDATE signups SET status = 'abandoned', reminders_paused = 1 WHERE id = ?`).run(signupId);
}

/**
 * Signups whose trial has actually started (Guided Setup done) and hasn't
 * been approved into a real account yet — candidates for the "trial's
 * ending soon" reminder (see reminders.js), which decides per row whether
 * it's actually within the trigger window.
 */
export function listSignupsForTrialEndingReminder() {
  return db.prepare(
    `SELECT * FROM signups
     WHERE status = 'new' AND guided_setup_status = 'completed'
       AND trial_ending_reminder_sent_at IS NULL AND trial_ends_at IS NOT NULL`
  ).all();
}

export function markTrialEndingReminderSent(signupId) {
  db.prepare(`UPDATE signups SET trial_ending_reminder_sent_at = datetime('now') WHERE id = ?`).run(signupId);
}

/**
 * Signups that finished Guided Setup (and, if it applied, the Website
 * Builder too) but haven't been approved into a real business/dashboard
 * account yet — what the admin "Approve & Activate" list shows.
 */
export function listPendingApprovals() {
  return db.prepare(
    `SELECT * FROM signups
     WHERE status = 'new' AND guided_setup_status = 'completed'
       AND (website_builder_status != 'pending')
     ORDER BY guided_setup_completed_at ASC`
  ).all();
}

export function complianceSummary(businessId) {
  const totalCustomers = db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE business_id = ?`).get(businessId).n;
  const withFullConsent = db.prepare(`
    SELECT COUNT(DISTINCT customer_id) AS n FROM consent_records
    WHERE business_id = ? AND type = 'full' AND status = 'granted'
      AND customer_id NOT IN (
        SELECT customer_id FROM consent_records c2
        WHERE c2.business_id = consent_records.business_id AND c2.customer_id = consent_records.customer_id
          AND c2.type = 'full' AND c2.created_at > consent_records.created_at
          AND c2.status != 'granted'
      )
  `).get(businessId).n;
  const optedOut = db.prepare(`SELECT COUNT(*) AS n FROM opt_outs WHERE business_id = ?`).get(businessId).n;
  return { totalCustomers, withFullConsent, optedOut };
}

// ---- Dashboard accounts & sessions (see auth/auth.js for the actual
// password hashing / token logic — these are just the raw reads/writes) ---

export function createUserInvite({ businessId, email, inviteToken, inviteExpiresAt }) {
  const info = db.prepare(
    `INSERT INTO users (business_id, email, invite_token, invite_expires_at) VALUES (?, ?, ?, ?)`
  ).run(businessId, email, inviteToken, inviteExpiresAt);
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function getUserByEmail(email) {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) || null;
}

export function getUserByInviteToken(token) {
  return db.prepare(`SELECT * FROM users WHERE invite_token = ?`).get(token) || null;
}

export function getUserById(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) || null;
}

/** Sets the real password and clears the (now used) invite token. */
export function setUserPassword(userId, passwordHash) {
  db.prepare(
    `UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires_at = NULL WHERE id = ?`
  ).run(passwordHash, userId);
}

export function createSession({ token, userId, businessId, expiresAt }) {
  db.prepare(
    `INSERT INTO sessions (token, user_id, business_id, expires_at) VALUES (?, ?, ?, ?)`
  ).run(token, userId, businessId, expiresAt);
}

/** Returns the session row if it exists AND hasn't expired, else null (an expired row is treated as absent, not cleaned up here). */
export function getValidSession(token) {
  return db.prepare(
    `SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).get(token) || null;
}

export function deleteSession(token) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}
