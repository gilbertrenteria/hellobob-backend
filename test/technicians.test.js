// Covers the new /api/businesses/:id/technicians and
// /api/technicians/:id/{availability,time-off} routes that back the
// in-house booking engine (src/booking/scheduler.js) — real HTTP, like
// test/websiteChat.test.js.

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';
process.env.PORT = '0';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const { createBusiness } = await import('../src/db.js');

let server;
let baseUrl;
let business;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
  business = createBusiness({ name: 'Desert Air', phoneE164: '+16195550188', state: 'CA', config: {} });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function postJson(path, body) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function putJson(path, body) {
  return fetch(`${baseUrl}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('creating a technician and reading it back', async () => {
  const created = await postJson(`/api/businesses/${business.id}/technicians`, { name: 'Mike' });
  assert.equal(created.status, 200);
  const tech = await created.json();
  assert.equal(tech.name, 'Mike');

  const listed = await fetch(`${baseUrl}/api/businesses/${business.id}/technicians`);
  const rows = await listed.json();
  assert.ok(rows.some((r) => r.id === tech.id && r.name === 'Mike'));
});

test('creating a technician for a nonexistent business is 404', async () => {
  const res = await postJson('/api/businesses/999999/technicians', { name: 'Ghost' });
  assert.equal(res.status, 404);
});

test('creating a technician without a name is 400', async () => {
  const res = await postJson(`/api/businesses/${business.id}/technicians`, {});
  assert.equal(res.status, 400);
});

test('setting weekly availability, then reading it back on the technician list', async () => {
  const created = await postJson(`/api/businesses/${business.id}/technicians`, { name: 'Dave' });
  const tech = await created.json();

  const setRes = await putJson(`/api/technicians/${tech.id}/availability`, {
    rules: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
  });
  assert.equal(setRes.status, 200);

  const listed = await fetch(`${baseUrl}/api/businesses/${business.id}/technicians`);
  const rows = await listed.json();
  const dave = rows.find((r) => r.id === tech.id);
  assert.equal(dave.availability.length, 1);
  assert.equal(dave.availability[0].day_of_week, 1);
});

test('an invalid availability rule is rejected with 400', async () => {
  const created = await postJson(`/api/businesses/${business.id}/technicians`, { name: 'Junior' });
  const tech = await created.json();

  const res = await putJson(`/api/technicians/${tech.id}/availability`, {
    rules: [{ dayOfWeek: 8, startMinute: 540, endMinute: 1020 }], // day 8 doesn't exist
  });
  assert.equal(res.status, 400);
});

test('adding time off for an unknown technician is 404', async () => {
  const res = await postJson('/api/technicians/999999/time-off', { startAt: '2026-09-07T09:00', endAt: '2026-09-07T12:00' });
  assert.equal(res.status, 404);
});

test('adding valid time off succeeds', async () => {
  const created = await postJson(`/api/businesses/${business.id}/technicians`, { name: 'Sam' });
  const tech = await created.json();
  const res = await postJson(`/api/technicians/${tech.id}/time-off`, { startAt: '2026-09-07T09:00', endAt: '2026-09-07T12:00', reason: 'Vacation' });
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.reason, 'Vacation');
});
