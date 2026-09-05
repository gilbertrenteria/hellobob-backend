// Plain node:http server — no Express (npm registry is blocked in the build
// environment this was written in; see README's "Why no dependencies"
// section). Routing here is a handful of routes, so this stays readable
// without a framework.

import { createServer } from 'node:http';
import { config } from './config.js';
import { handleIncomingSms, handleIncomingVoice } from './telephony/webhooks.js';
import {
  getConversationsRoute,
  getConversationMessagesRoute,
  getAppointmentsRoute,
  getComplianceSummaryRoute,
  getCustomerConsentRoute,
} from './routes/api.js';
import { handleWebsiteChat } from './webchat/websiteChat.js';
import { captureSignup, SignupError } from './signup.js';
import { listSignups } from './db.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseFormBody(raw) {
  const params = {};
  for (const [key, value] of new URLSearchParams(raw)) params[key] = value;
  return params;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sendXml(res, status, xml) {
  res.writeHead(status, { 'content-type': 'text/xml' });
  res.end(xml);
}

/** The exact URL Twilio hit, for signature validation — see telephony/twilio.js. */
function fullUrlFor(req) {
  return `${config.publicBaseUrl}${req.url}`;
}

function readJsonBody(req) {
  return readBody(req).then((raw) => {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return null; // signals "bad JSON" to the caller
    }
  });
}

/** Real client IP behind Render's proxy — falls back to the raw socket for local dev. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// /api/website-chat is called directly from the browser (the marketing
// site's "Ask Bob" widget), from whatever origin that site is hosted on —
// unlike every other route here, which is only ever called server-to-server
// (Twilio) or from your own dashboard. CORS headers are what let a browser
// on a different origin call it at all.
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', config.websiteChatAllowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, config.publicBaseUrl || 'http://localhost');
      const path = url.pathname;

      if (req.method === 'POST' && path === '/webhooks/sms') {
        const raw = await readBody(req);
        const params = parseFormBody(raw);
        const result = await handleIncomingSms({
          url: fullUrlFor(req),
          params,
          signatureHeader: req.headers['x-twilio-signature'],
        });
        return sendXml(res, result.status, result.body);
      }

      if (req.method === 'POST' && path === '/webhooks/voice') {
        const raw = await readBody(req);
        const params = parseFormBody(raw);
        const result = await handleIncomingVoice({
          url: fullUrlFor(req),
          params,
          signatureHeader: req.headers['x-twilio-signature'],
        });
        return sendXml(res, result.status, result.body);
      }

      const businessMatch = path.match(/^\/api\/businesses\/(\d+)\/(conversations|appointments|compliance-summary)$/);
      if (req.method === 'GET' && businessMatch) {
        const businessId = Number(businessMatch[1]);
        const resource = businessMatch[2];
        const route =
          resource === 'conversations' ? getConversationsRoute(businessId)
          : resource === 'appointments' ? getAppointmentsRoute(businessId)
          : getComplianceSummaryRoute(businessId);
        return sendJson(res, route.status, route.json);
      }

      const conversationMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
      if (req.method === 'GET' && conversationMatch) {
        const route = getConversationMessagesRoute(Number(conversationMatch[1]));
        return sendJson(res, route.status, route.json);
      }

      const consentMatch = path.match(/^\/api\/businesses\/(\d+)\/customers\/(\d+)\/consent$/);
      if (req.method === 'GET' && consentMatch) {
        const route = getCustomerConsentRoute(Number(consentMatch[1]), Number(consentMatch[2]));
        return sendJson(res, route.status, route.json);
      }

      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true, dryRun: config.dryRun });
      }

      if (path === '/api/website-chat') {
        if (req.method === 'OPTIONS') {
          setCors(res);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'POST') {
          setCors(res);
          const body = await readJsonBody(req);
          if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' });
          try {
            const result = await handleWebsiteChat({
              ip: clientIp(req),
              lang: body.lang,
              history: body.history,
            });
            return sendJson(res, 200, result);
          } catch (err) {
            const status = err.code === 'bad_request' ? 400
              : err.code === 'rate_limited' || err.code === 'daily_cap' ? 429
              : 500;
            return sendJson(res, status, { error: err.code || 'internal_error', message: err.message });
          }
        }
      }

      // Plain on-page "Start My Free Trial" form (accuhvac.html's
      // #signupSteps) — the OTHER way (besides the Ask Bob chat) a visitor
      // can sign up. Same shared captureSignup() as the chat's
      // capture_signup tool call, so both land in the exact same place.
      if (path === '/api/signup') {
        if (req.method === 'OPTIONS') {
          setCors(res);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'POST') {
          setCors(res);
          const body = await readJsonBody(req);
          if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' });
          try {
            const result = await captureSignup({
              businessName: typeof body.businessName === 'string' ? body.businessName.trim() : '',
              contactEmail: typeof body.contactEmail === 'string' ? body.contactEmail.trim() : '',
              contactPhone: typeof body.contactPhone === 'string' ? body.contactPhone.trim() : '',
              source: 'website_form',
            });
            return sendJson(res, 200, result);
          } catch (err) {
            const status = err instanceof SignupError && err.code === 'bad_request' ? 400 : 500;
            return sendJson(res, status, { error: err.code || 'internal_error', message: err.message });
          }
        }
      }

      // Simple stopgap for viewing captured signups before there's a real
      // dashboard/login — set ADMIN_KEY in .env, then visit
      // /api/signups?key=<that value>. Disabled entirely if ADMIN_KEY isn't set.
      if (req.method === 'GET' && path === '/api/signups') {
        if (!config.adminKey || url.searchParams.get('key') !== config.adminKey) {
          return sendJson(res, 404, { error: 'not found' });
        }
        return sendJson(res, 200, listSignups());
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: 'internal error', message: err.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`HelloBob backend listening on port ${config.port}${config.dryRun ? ' (DRY RUN — no API keys set)' : ''}`);
  });
}
