# Deploying the HelloBob demo to Render

This takes about ten minutes and needs no command line. You'll end up with a
public URL running the backend, the owner dashboard, and the "Ask Bob" chat
that the marketing site talks to.

You need two things before you start:

1. A GitHub account that can see the `gilbertrenteria/hellobob-backend` repo.
2. An Anthropic API key (from https://platform.claude.com → API keys). It
   starts with `sk-ant-`. Keep it somewhere you can paste from.

## Steps

1. Go to https://render.com and click **Get Started** → **Sign up with GitHub**.
   Authorize Render to see your repositories.
2. In the Render dashboard, click **New +** (top right) → **Blueprint**.
3. Pick **`gilbertrenteria/hellobob-backend`** from the repo list and click
   **Connect**. (If it's not listed, click *Configure account* and give Render
   access to that repo.)
4. Render reads the `render.yaml` in the repo and shows one service,
   **hellobob-backend**, with its settings already filled in. Give the
   Blueprint any name you like.
5. It will ask for **ANTHROPIC_API_KEY** — paste your key there. Everything
   else is pre-filled. Nothing you type here goes into the code or the repo.
6. Click **Apply**. Render builds and starts the service; the log scrolls for a
   minute or two. Wait until the status badge says **Live**.
7. Check it's up: open
   **https://hellobob-backend.onrender.com/health** — you should see
   `{ "ok": true, ... }`.
8. Open the dashboard: **https://hellobob-backend.onrender.com/dashboard**
   and log in with

   - Email: `demo@hellobob.example`
   - Password: `demo2`

   You'll see the sample business "Coastline Air & Heat" with technicians,
   upcoming appointments and text conversations, plus a yellow *Demo
   workspace* banner across the top.

That's it. The marketing site (gilbertrenteria.github.io/hellobob-backend and
gilbertrenteria.dev) already points its "Ask Bob" chat at
`https://hellobob-backend.onrender.com`, so once the service is Live the chat
on those pages answers with real Claude replies.

## Things to know about the free plan

- **Cold starts.** After about 15 minutes with no visitors, Render puts a free
  service to sleep. The next visitor waits roughly 50 seconds for it to wake
  up (the chat widget or dashboard just looks slow for that first request).
  If you're about to show the demo to someone, open the `/health` URL a minute
  beforehand.
- **The demo resets.** The free plan has no permanent disk, so the database
  lives in temporary storage and is wiped every time the service restarts or
  redeploys. That's fine here: `DEMO_MODE=true` re-creates the sample data on
  every boot, with appointment dates always relative to "today". Anything you
  add in the dashboard (a technician, time off) disappears at the next restart.
- **No texting or email goes out.** Twilio and Resend aren't configured, so
  SMS and emails are written to the log instead of sent. Claude is live.

## Making it permanent (real data)

When you're ready to run a real business on it:

1. In Render, open the service → **Settings** → change the plan to **Starter**.
2. Add a **Disk**: mount path `/data`, 1 GB is plenty.
3. Under **Environment**, set `DB_PATH` to `/data/hellobob.db` and change
   `DEMO_MODE` to `false` (or delete it).
4. Add your Twilio and Resend keys there too (`TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `RESEND_API_KEY`), and set
   `WEBSITE_CHAT_ALLOWED_ORIGIN` to the exact site(s) allowed to use the chat,
   comma-separated, e.g. `https://gilbertrenteria.github.io,https://gilbertrenteria.dev`.
5. Point Twilio's Messaging and Voice webhooks at
   `https://hellobob-backend.onrender.com/webhooks/sms` and `/webhooks/voice`.

The commented block at the bottom of `render.yaml` is the same setup written
out as a Blueprint, if you'd rather redeploy from the file.

## If something's wrong

- **Build failed / "node: not found"** — the Blueprint pins `NODE_VERSION`
  to 22.12.0. Check that env var wasn't removed.
- **`/health` gives an error page** — open the service's **Logs** tab in
  Render; the last few lines say what went wrong. A missing
  `ANTHROPIC_API_KEY` is not fatal (the server just runs in dry-run mode).
- **Login says "Incorrect email or password"** — the demo password can be
  overridden by a `DEMO_OWNER_PASSWORD` env var; if one was added, that's the
  password to use.
- **Chat on the marketing site says it can't reach the backend** — the
  service is probably asleep; wait a minute and try again, or check
  `WEBSITE_CHAT_ALLOWED_ORIGIN` includes the site's origin (or is `*`).
