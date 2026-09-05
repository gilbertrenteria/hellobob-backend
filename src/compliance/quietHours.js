// Quiet-hours enforcement. Applies to every AUTOMATED outbound text
// (reminders, on-my-way alerts, invoices, review requests, the missed-call
// text-back) by default — matching the design in onboarding_questionnaire's
// Q50: "Applies to every automated text by default, transactional and
// promotional alike." A direct, in-the-moment reply to a customer who is
// actively texting right now is exempt (see isDirectReply in consent.js) —
// the customer initiated contact, so there's no "waking them up" concern.

import { config } from '../config.js';
import { getStateRule } from './stateRules.js';

/** Returns { start, end } as local hours (0–23) for this business. */
export function getQuietHoursWindow(business) {
  let start = business.quiet_hours_start ?? config.defaultQuietHoursStart;
  let end = business.quiet_hours_end ?? config.defaultQuietHoursEnd;

  const stateRule = getStateRule(business.state);
  if (stateRule?.quietHours) {
    // The state rule only ever narrows the window, never widens it.
    start = Math.max(start, stateRule.quietHours.start);
    end = Math.min(end, stateRule.quietHours.end);
  }
  return { start, end };
}

/** Current local hour (0–23) in the business's timezone. */
function currentLocalHour(timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  // Intl can format midnight as "24" in some locales/environments — normalize.
  const hour = Number(formatter.format(new Date()));
  return hour === 24 ? 0 : hour;
}

/** True if it is currently within the business's allowed sending window. */
export function isWithinQuietHoursWindow(business) {
  const { start, end } = getQuietHoursWindow(business);
  const hour = currentLocalHour(business.timezone);
  if (start === end) return true; // 24/7 allowed (not used by default, but supported)
  if (start < end) return hour >= start && hour < end;
  // Window wraps midnight (e.g. start 20, end 6) — not our default, but handled correctly.
  return hour >= start || hour < end;
}
