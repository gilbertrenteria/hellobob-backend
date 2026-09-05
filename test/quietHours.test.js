// Tests for src/compliance/quietHours.js. Anything that depends on the
// actual current wall-clock hour is deliberately avoided here (it would
// make the suite flaky depending on when it's run) — these test the
// deterministic parts: state-rule narrowing, and the always-allowed
// start===end shortcut.

process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { getQuietHoursWindow, isWithinQuietHoursWindow } = await import('../src/compliance/quietHours.js');

test('with no state rule, the business/site default window applies unchanged', () => {
  const business = { state: null, quiet_hours_start: null, quiet_hours_end: null };
  assert.deepEqual(getQuietHoursWindow(business), { start: 8, end: 21 });
});

test('a state rule only ever narrows the window, never widens it', () => {
  // Business configured wider than the site default; MD's rule is {8,21}.
  const business = { state: 'MD', quiet_hours_start: 6, quiet_hours_end: 22 };
  assert.deepEqual(getQuietHoursWindow(business), { start: 8, end: 21 });
});

test('a state with no quietHours rule (e.g. FL) does not narrow anything', () => {
  const business = { state: 'FL', quiet_hours_start: 7, quiet_hours_end: 20 };
  assert.deepEqual(getQuietHoursWindow(business), { start: 7, end: 20 });
});

test('an unknown state code is ignored rather than throwing', () => {
  const business = { state: 'ZZ', quiet_hours_start: 9, quiet_hours_end: 18 };
  assert.deepEqual(getQuietHoursWindow(business), { start: 9, end: 18 });
});

test('start === end means sending is always allowed (24/7 override)', () => {
  const business = { state: null, quiet_hours_start: 5, quiet_hours_end: 5, timezone: 'America/New_York' };
  assert.equal(isWithinQuietHoursWindow(business), true);
});
