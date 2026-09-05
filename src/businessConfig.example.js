// Shape of the JSON blob stored in businesses.config_json. Mirrors the
// fields gathered in onboarding_questionnaire_full.md so the conversation
// engine's system prompt has everything Bob needs to sound like this
// specific HVAC business instead of a generic assistant.
//
// Copy this object (or generate one per business from the questionnaire
// answers) and pass it as `config` to db.js's createBusiness().

export const exampleBusinessConfig = {
  businessName: 'AccuHVAC',
  tagline: 'Heating & cooling, done right the first time.',

  hours: {
    monday: '8:00 AM–6:00 PM',
    tuesday: '8:00 AM–6:00 PM',
    wednesday: '8:00 AM–6:00 PM',
    thursday: '8:00 AM–6:00 PM',
    friday: '8:00 AM–6:00 PM',
    saturday: '9:00 AM–2:00 PM',
    sunday: 'Closed',
  },

  serviceArea: ['Tampa', 'Clearwater', 'St. Petersburg'],

  services: [
    { name: 'AC repair', typicalPrice: '$89 diagnostic + parts/labor' },
    { name: 'AC maintenance / tune-up', typicalPrice: '$129' },
    { name: 'New system install', typicalPrice: 'Free on-site quote' },
    { name: 'Emergency after-hours service', typicalPrice: '$189 diagnostic' },
  ],

  // Informational only — real scheduling now lives in the `technicians` /
  // `tech_availability` tables (see db.js + booking/scheduler.js), created
  // via POST /api/businesses/:id/technicians and PUT
  // /api/technicians/:id/availability. Bob checks THAT for real open slots;
  // this flat list isn't read by the conversation engine.
  technicians: ['Mike', 'Dave', 'Junior'],

  emergencyPolicy:
    'For no-cooling emergencies in extreme heat, offer same-day service if a slot is open; otherwise first slot next morning.',

  bookingNotes:
    'Always confirm address and preferred time window before calling it booked. ' +
    'If unsure about pricing for a job, say a technician will confirm on-site rather than guessing.',

  escalation: {
    // If the AI can't resolve something (a complaint, a price negotiation,
    // anything outside normal scheduling), it should say a team member will
    // follow up and the engine marks the conversation needs_human — it does
    // not keep improvising.
    phrase: "Let me get one of our team to follow up with you on that.",
  },
};
