// Database layer, built on Node's own built-in `node:sqlite` (stable enough
// for this MVP, no native compile step, no npm dependency). If you outgrow
// SQLite later (multiple app servers, heavy concurrent writes), swap this
// file for a Postgres client — every other module only talks to the small
// set of functions exported here, not to SQL directly.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const dbDir = dirname(config.dbPath);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

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
  -- marketing-site chat they want to sign up FOR HelloBob itself. This is
  -- our own replacement for the old "quick sign-up" Jotform — the detailed
  -- setup questionnaire is still a separate Jotform (see config.js), which
  -- every new signup gets pointed to right after this row is created.
  CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'website_chat',
    status TEXT NOT NULL DEFAULT 'new', -- 'new' | 'questionnaire_sent' | 'onboarded'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_consent_lookup ON consent_records(business_id, customer_id, type, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
`);

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

export function createAppointment({ businessId, customerId, conversationId, service, address, scheduledAt, technician }) {
  const info = db.prepare(
    `INSERT INTO appointments (business_id, customer_id, conversation_id, service, address, scheduled_at, technician)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(businessId, customerId, conversationId || null, service, address || null, scheduledAt || null, technician || null);
  return db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function listAppointments(businessId, limit = 50) {
  return db.prepare(
    `SELECT a.*, c.phone_e164, c.name AS customer_name
     FROM appointments a JOIN customers c ON c.id = a.customer_id
     WHERE a.business_id = ? ORDER BY a.created_at DESC LIMIT ?`
  ).all(businessId, limit);
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

export function createSignup({ businessName, contactEmail, contactPhone, source }) {
  const info = db.prepare(
    `INSERT INTO signups (business_name, contact_email, contact_phone, source)
     VALUES (?, ?, ?, ?)`
  ).run(businessName, contactEmail, contactPhone, source || 'website_chat');
  return db.prepare(`SELECT * FROM signups WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function listSignups(limit = 100) {
  // created_at has only second-level resolution, so two signups saved within
  // the same second would otherwise tie — 'id DESC' as a tiebreaker keeps
  // this genuinely newest-first regardless.
  return db.prepare(`SELECT * FROM signups ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit);
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
