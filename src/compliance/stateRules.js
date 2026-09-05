// Per-state texting rules, as researched in the planning pass. This is a
// starting table, not a legal opinion — get a real attorney's sign-off on
// this file specifically before relying on it in production (see the
// "Not legal advice" note in onboarding_questionnaire_full.md).
//
// `quietHours` narrows the site-wide default (8am–9pm) where a state
// requires something tighter. `requiresCallbackCapableNumber` flags the
// FL/OK theory that a texting number must itself be able to receive a call
// back — enforced at the infrastructure level (see README: buy numbers with
// both SMS + Voice enabled), not something this code can check at runtime,
// but recorded here so it shows up in the compliance dashboard. `dailyCap`
// and `confirmBeforeScaling` are the two extra flags called out in the
// launch-stack planning doc for TX/NY.

export const STATE_RULES = {
  FL: { quietHours: null, requiresCallbackCapableNumber: true, note: 'FTSA: callback-number theory. Confirm the Twilio number has Voice enabled, not just SMS.' },
  OK: { quietHours: null, requiresCallbackCapableNumber: true, note: 'OTSA: same callback-number theory as FL.' },
  WA: { quietHours: { start: 8, end: 21 }, dailyCap: 3, note: 'Washington caps unsolicited commercial texts — kept transactional-only here to stay clear of it.' },
  MD: { quietHours: { start: 8, end: 21 }, dailyCap: 3, note: 'Maryland telephone solicitation act — same posture as WA.' },
  CT: { quietHours: { start: 8, end: 21 }, dailyCap: 3, note: 'Connecticut telemarketing rules — same posture as WA.' },
  TX: { quietHours: null, confirmBeforeScaling: true, note: 'Texas has an active plaintiffs’ bar around texting claims — confirm approach with counsel before high volume.' },
  NY: { quietHours: null, confirmBeforeScaling: true, note: 'Same posture as TX — confirm before scaling.' },
};

export function getStateRule(stateCode) {
  if (!stateCode) return null;
  return STATE_RULES[stateCode.toUpperCase()] || null;
}
