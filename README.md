# HelloBob backend

The real, working backend for HelloBob — the AI front-desk assistant. It answers
missed calls and texts on your Twilio number, has an AI-driven SMS conversation
with the customer (via Claude), books appointments, and enforces the texting
compliance rules (consent, quiet hours, STOP) worked out in the earlier planning
docs — deterministically, in code, never left up to the AI to get right.

## Why no dependencies

This was built in an environment where `npm install` couldn't reach the npm
registry at all. Rather than block on that, the whole backend is written using
only what Node.js 22 ships with:

- **`node:sqlite`** for the database — no native build step, no `better-sqlite3`.
- **Global `fetch`** for every outbound HTTP call — the Anthropic API, the
  Twilio REST API.
- **`process.loadEnvFile()`** instead of `dotenv`.
- **`node:http`** instead of Express — there are only a handful of routes.
- **`node --test`** instead of Jest/Mocha.
- Twilio's REST API and webhook-signature check are both implemented directly
  against their (published, stable) HTTP contract in `src/telephony/twilio.js`,
  instead of pulling in the `twilio` npm package.

This isn't a workaround you'll need to unwind later — it's genuinely simpler to
deploy (nothing to `npm install` in production, no native binaries to rebuild
per platform) and there's nothing here you couldn't hand to another developer
without explanation. If you ever want the official Twilio SDK for something
fancier (call recordings, TwiML Bins), that's a self-contained swap of one file.

## Running it locally

```bash
npm test          # runs the whole test suite — no API keys needed
npm start         # starts the server on :3000 (or $PORT)
```

With no `.env` file, or with `ANTHROPIC_API_KEY`/`TWILIO_ACCOUNT_SID` unset, the
server starts in **dry-run mode**: it logs exactly what it would have sent to
Claude and Twilio instead of actually calling them, and skips real webhook
signature validation. That means you can run the whole thing, hit it with curl
or Postman, and watch the compliance logic and conversation flow work end to
end before you've paid for or configured anything. `npm test` always runs in
dry-run mode regardless of your `.env`, so it never makes a real API call.

## Getting your own API keys

1. **Anthropic (Claude)** — this is what makes Bob's replies actually
   intelligent instead of scripted. Sign up at
   [console.anthropic.com](https://console.anthropic.com), add a payment
   method, and create a key under Settings → API Keys. Put it in `.env` as
   `ANTHROPIC_API_KEY`.

2. **Twilio** — this is the phone number Bob answers/texts from. Sign up at
   [twilio.com](https://www.twilio.com), and from the console dashboard copy
   your **Account SID** and **Auth Token** into `.env`. Buy a phone number
   under Phone Numbers → Buy a Number — **make sure both SMS and Voice are
   enabled on it**, not just SMS (see the note in
   `src/compliance/stateRules.js` about Florida/Oklahoma's callback-number
   theory — the number itself needs to be callable, which this can't be
   verified by code, only by how you buy the number).

3. **A2P 10DLC registration** — before Twilio will carry real production SMS
   traffic (beyond trial-mode messages to verified numbers), you need to
   register a "brand" (your business) and a "campaign" (what kind of texts
   you're sending) in the Twilio console under Messaging → Regulatory
   Compliance. This takes real business details (EIN, business address) and
   can take a day or more to get approved. It's an account-level step in
   Twilio's own console — nothing in this codebase can do it for you. Dry-run
   mode lets you build and test everything else while that's pending.

4. Set `PUBLIC_BASE_URL` once you've deployed somewhere (see below), or to
   whatever a local tunnel (ngrok, Cloudflare Tunnel) gives you for local
   testing against real Twilio traffic. In the Twilio console, set your phone
   number's webhooks to `{PUBLIC_BASE_URL}/webhooks/sms` (Messaging) and
   `{PUBLIC_BASE_URL}/webhooks/voice` (Voice, "A call comes in") — and set the
   Voice number's **status callback URL** (or the equivalent "call status
   changes" webhook) to the same `/webhooks/voice` endpoint so a missed call
   is reported back as `CallStatus=no-answer` and triggers the text-back.

## Deploying

Any host that runs a long-lived Node.js 22+ process and gives you a public
URL works — Railway, Render, and Fly.io are all reasonable, low-effort
choices for something this size. The general shape on any of them:

1. Push this folder to a git repo.
2. Point the platform at it; set the start command to `npm start`.
3. Set the environment variables from `.env.example` in the platform's
   dashboard (never commit your real `.env`).
4. Mount a persistent volume for the `data/` directory (where the SQLite file
   lives), or point `DB_PATH` at one — otherwise your data resets on every
   deploy/restart. If you outgrow SQLite (more concurrent writes than one
   file can comfortably handle), swap `src/db.js` for a Postgres client; every
   other module only calls the functions that file exports, not raw SQL.
5. Set `PUBLIC_BASE_URL` to the URL the platform gives you, and point Twilio's
   webhooks at it as described above.

## How a conversation actually flows

1. A call to the business's Twilio number goes unanswered → Twilio hits
   `/webhooks/voice` with `CallStatus=no-answer` → the missed-call customer
   gets **one** reactive text (`src/compliance/consent.js`'s
   `REPLY_TEXT_WORDING_TEMPLATE`), and that single text is what creates
   **reply-consent** — good for exactly one thing: the back-and-forth that
   follows, nothing else.
2. Whatever the customer texts back goes to `/webhooks/sms`, which hands it to
   the AI conversation engine (`src/ai/conversationEngine.js`). Bob (the AI)
   is scoped to this one business's hours/services/pricing/policies (stored
   as JSON on the `businesses` row — see `src/businessConfig.example.js`),
   and can call a `book_appointment` tool once service, address, and time are
   settled.
3. The moment an appointment is booked, the code — not the AI — appends the
   one-time **full-consent** question (`FULL_CONSENT_WORDING`), and the
   customer's next yes/no reply is parsed by a plain regex
   (`parseYesNo`), never by the model. That's deliberate: whether a customer
   is opted in to reminders/invoices/review-requests should never depend on
   how an AI feels like interpreting an ambiguous reply.
4. Every single outbound message — the missed-call text, Bob's replies, a
   reminder, whatever — goes through `canSend()` in
   `src/compliance/consent.js` first. It checks opt-out status, which
   consent type the message needs, and quiet hours (narrowed further per
   state by `src/compliance/stateRules.js`). If it says no, the message
   doesn't go out, full stop — this function never looks at what the AI
   wrote, only at what's on file for this customer.
5. Texting **STOP** (or unsubscribe/cancel/etc.) at any point revokes
   everything at once, logged as its own event, and is checked before
   anything else runs.

## Project layout

```
src/
  config.js                  env vars, dry-run detection
  db.js                      SQLite schema + all data access
  businessConfig.example.js  shape of a business's config JSON
  compliance/
    consent.js                the canSend() gate — the most important file here
    quietHours.js              quiet-hours window logic
    stateRules.js               per-state overrides (NOT legal advice — see below)
  ai/
    claude.js                  Anthropic API client
    conversationEngine.js      builds Bob's system prompt, runs one turn
  telephony/
    twilio.js                  Twilio REST client + webhook signature check
    webhooks.js                 incoming SMS/voice handlers
  routes/
    api.js                      JSON endpoints for a real owner dashboard
  server.js                     node:http server wiring it all together
test/
  consent.test.js               compliance gate logic
  quietHours.test.js             quiet-hours window logic
  webhooks.integration.test.js   full request/response flow, dry-run
```

## Not legal advice

`src/compliance/stateRules.js` and the consent design in general reflect the
research done during planning, not a lawyer's review. Get an actual attorney
familiar with TCPA/state telemarketing law to sign off on the wording and
rules in those two files specifically before relying on this for real
customers, especially before scaling volume in Texas or New York (flagged in
the code as `confirmBeforeScaling`).
