// Public-demo mode (src/demoSeed.js + the demo flag in server.js): the
// seed fills an empty DB with the sample business, is idempotent, creates a
// demo owner who can really log in through /api/login, and keeps every
// appointment relative to "now" so the hosted demo never goes stale.

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';
process.env.DEMO_MODE = 'true';
process.env.PORT = '0';
delete process.env.DEMO_OWNER_PASSWORD;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { seedDemoIfEmpty, DEMO_BUSINESS } = await import('../src/demoSeed.js');

let server;
let baseUrl;

function counts() {
  const n = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    businesses: n('businesses'), users: n('users'), technicians: n('technicians'), customers: n('customers'),
    conversations: n('conversations'), messages: n('messages'), appointments: n('appointments'),
    consent: n('consent_records'), optOuts: n('opt_outs'),
  };
}

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('config exposes demo mode and the default demo credentials', () => {
  assert.equal(config.demoMode, true);
  assert.equal(config.demoOwnerEmail, 'demo@hellobob.example');
  assert.equal(config.demoOwnerPassword, 'demo2');
});

test('seed fills an empty database and is idempotent on a second call', () => {
  assert.equal(counts().businesses, 0);

  const first = seedDemoIfEmpty(db, config);
  assert.equal(first.seeded, true);
  const after1 = counts();
  assert.equal(after1.businesses, 1);
  assert.equal(after1.users, 1);
  assert.equal(after1.technicians, 3);
  assert.equal(after1.customers, 6);
  assert.equal(after1.conversations, 3);
  assert.equal(after1.appointments, 8);
  assert.equal(after1.optOuts, 1);
  assert.ok(after1.messages >= 25, `expected realistic multi-turn transcripts, got ${after1.messages} messages`);
  assert.ok(after1.consent >= 12);

  const second = seedDemoIfEmpty(db, config);
  assert.equal(second.seeded, false);
  assert.equal(second.reason, 'not_empty');
  assert.deepEqual(counts(), after1, 'a second seed must not add anything');
});

test('seed does nothing when demo mode is off', () => {
  const before = counts();
  const result = seedDemoIfEmpty(db, { ...config, demoMode: false });
  assert.equal(result.seeded, false);
  assert.equal(result.reason, 'demo_mode_off');
  assert.deepEqual(counts(), before);
});

test('the demo business matches the spec (HVAC, Houston, Chicago time, 7–7 Mon–Sat)', () => {
  const business = db.prepare(`SELECT * FROM businesses WHERE phone_e164 = ?`).get(DEMO_BUSINESS.phoneE164);
  assert.equal(business.name, 'Coastline Air & Heat');
  assert.equal(business.timezone, 'America/Chicago');
  assert.equal(business.state, 'TX');
  const cfg = JSON.parse(business.config_json);
  // Same keys as src/businessConfig.example.js
  assert.deepEqual(Object.keys(cfg).sort(), ['bookingNotes', 'businessName', 'emergencyPolicy', 'escalation', 'hours', 'serviceArea', 'services', 'tagline', 'technicians'].sort());
  assert.equal(cfg.hours.monday, '7:00 AM–7:00 PM');
  assert.equal(cfg.hours.saturday, '7:00 AM–7:00 PM');
  assert.equal(cfg.hours.sunday, 'Closed');
  assert.deepEqual(cfg.technicians, ['Mike R.', 'Dana P.', 'Luis T.']);

  const techs = db.prepare(`SELECT name FROM technicians WHERE business_id = ? ORDER BY id`).all(business.id).map((t) => t.name);
  assert.deepEqual(techs, ['Mike R.', 'Dana P.', 'Luis T.']);
  const weekdayRows = db.prepare(`SELECT COUNT(*) AS n FROM tech_availability WHERE day_of_week BETWEEN 1 AND 5`).get().n;
  assert.equal(weekdayRows, 15, 'each of 3 technicians has Mon–Fri availability');

  const phones = db.prepare(`SELECT phone_e164 FROM customers`).all().map((c) => c.phone_e164);
  assert.ok(phones.every((p) => /^\+1\d{3}555\d{4}$/.test(p)), 'all demo customers use fictional 555 numbers');
});

test('appointments are relative to now: 4 confirmed ahead, 3 complete in the past week, 1 cancelled', () => {
  const rows = db.prepare(`SELECT status, scheduled_at FROM appointments`).all();
  const byStatus = (s) => rows.filter((r) => r.status === s);
  assert.equal(byStatus('confirmed').length, 4);
  assert.equal(byStatus('complete').length, 3);
  assert.equal(byStatus('cancelled').length, 1);

  // scheduled_at is a naive business-local "YYYY-MM-DDTHH:MM" string; compare
  // by calendar date, allowing a day of slack for the UTC/Chicago offset.
  const today = new Date();
  const dayOffset = (naive) => Math.round((Date.parse(naive + ':00Z') - today.getTime()) / 86_400_000);
  for (const r of byStatus('confirmed')) {
    const d = dayOffset(r.scheduled_at);
    assert.ok(d >= 0 && d <= 14, `confirmed appointment ${r.scheduled_at} should be within the next 14 days (offset ${d})`);
  }
  for (const r of byStatus('complete')) {
    const d = dayOffset(r.scheduled_at);
    assert.ok(d <= 0 && d >= -8, `complete appointment ${r.scheduled_at} should be within the past week (offset ${d})`);
  }
  // Nothing is ever booked on a Sunday — technicians don't work then.
  for (const r of rows) {
    const dow = new Date(r.scheduled_at.slice(0, 10) + 'T12:00:00Z').getUTCDay();
    assert.notEqual(dow, 0, `appointment on a Sunday: ${r.scheduled_at}`);
  }
});

test('transcripts: one booked with consent YES, one STOP opt-out, one still open', () => {
  const convs = db.prepare(`SELECT * FROM conversations ORDER BY id`).all();
  assert.deepEqual(convs.map((c) => c.status).sort(), ['booked', 'closed', 'open']);

  const booked = convs.find((c) => c.status === 'booked');
  const bookedMsgs = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, id`).all(booked.id);
  assert.match(bookedMsgs[0].body, /Sorry we missed your call/);
  assert.ok(bookedMsgs.some((m) => /blowing warm air/.test(m.body)));
  assert.ok(bookedMsgs.some((m) => m.direction === 'inbound' && /^yes$/i.test(m.body.trim())));
  const fullConsent = db.prepare(`SELECT * FROM consent_records WHERE customer_id = ? AND type = 'full' ORDER BY created_at DESC LIMIT 1`).get(booked.customer_id);
  assert.equal(fullConsent.status, 'granted');

  const closed = convs.find((c) => c.status === 'closed');
  const closedMsgs = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, id`).all(closed.id);
  assert.ok(closedMsgs.some((m) => m.direction === 'inbound' && m.body === 'STOP'));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM opt_outs WHERE customer_id = ?`).get(closed.customer_id).n, 1);

  // Every customer has at least a reply-consent row, so nothing in the dashboard looks broken.
  const withoutConsent = db.prepare(
    `SELECT COUNT(*) AS n FROM customers c WHERE NOT EXISTS (SELECT 1 FROM consent_records r WHERE r.customer_id = c.id)`
  ).get().n;
  assert.equal(withoutConsent, 0);
});

test('the demo owner can log in through the real /api/login and sees the demo flag', async () => {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@hellobob.example', password: 'demo2' }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /hellobob_session=/);

  const me = await fetch(`${baseUrl}/api/me`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(me.status, 200);
  const json = await me.json();
  assert.equal(json.demo, true);
  assert.equal(json.business.name, 'Coastline Air & Heat');

  const bad = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@hellobob.example', password: 'wrong' }),
  });
  assert.equal(bad.status, 401);
});

test('GET /api/demo-info is public and reports demo mode', async () => {
  const res = await fetch(`${baseUrl}/api/demo-info`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.demo, true);
  assert.equal(json.ownerEmail, 'demo@hellobob.example');
});

test('GET /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
});
