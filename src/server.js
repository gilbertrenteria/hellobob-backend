// Plain node:http server — no Express (npm registry is blocked in the build
// environment this was written in; see README's "Why no dependencies"
// section). Routing here is a handful of routes, so this stays readable
// without a framework.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { config } from './config.js';
import { handleIncomingSms, handleIncomingVoice } from './telephony/webhooks.js';
import {
  getBusinessRoute,
  getConversationsRoute,
  getConversationMessagesRoute,
  getAppointmentsRoute,
  getComplianceSummaryRoute,
  getCustomerConsentRoute,
  getTechniciansRoute,
  createTechnicianRoute,
  setTechnicianAvailabilityRoute,
  addTechnicianTimeOffRoute,
} from './routes/api.js';
import { handleWebsiteChat } from './webchat/websiteChat.js';
import { captureSignup, SignupError } from './signup.js';
import { listSignups, getTechnician, getConversation } from './db.js';
import { login, logout, acceptInvite, createBusinessWithOwner, sessionFromToken, AuthError } from './auth/auth.js';

const DASHBOARD_DIR = new URL('../dashboard/', import.meta.url).pathname;
const SESSION_COOKIE = 'hellobob_session';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, expiresAt) {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** @returns {{userId:number, businessId:number}|null} */
function currentSession(req) {
  return sessionFromToken(parseCookies(req)[SESSION_COOKIE]);
}

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/**
 * Serves one file under DASHBOARD_DIR for a request path like
 * "/dashboard/index.html". Returns true if it handled the response (found
 * and served, or a safe 404), false if the caller should fall through.
 */
async function serveDashboardFile(res, requestPath) {
  const relative = requestPath.replace(/^\/dashboard\//, '');
  const resolved = normalize(join(DASHBOARD_DIR, relative));
  // Path-traversal guard — a request like /dashboard/../../.env must never
  // escape DASHBOARD_DIR just because normalize() collapses the "..".
  if (!resolved.startsWith(DASHBOARD_DIR) || !existsSync(resolved)) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  const body = await readFile(resolved);
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(resolved)] || 'application/octet-stream' });
  res.end(body);
  return true;
}

/** Session must exist AND belong to the exact business being requested. */
function requireOwnBusiness(req, res, businessId) {
  const session = currentSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return null;
  }
  if (session.businessId !== businessId) {
    sendJson(res, 403, { error: 'forbidden' });
    return null;
  }
  return session;
}

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

      // ---- Dashboard auth ---------------------------------------------------

      if (req.method === 'POST' && path === '/api/login') {
        const body = await readJsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' });
        try {
          const session = login({ email: body.email, password: body.password });
          setSessionCookie(res, session.token, session.expiresAt);
          return sendJson(res, 200, { ok: true, businessId: session.businessId });
        } catch (err) {
          if (!(err instanceof AuthError)) throw err;
          return sendJson(res, 401, { error: err.code, message: err.message });
        }
      }

      if (req.method === 'GET' && path === '/api/me') {
        const session = currentSession(req);
        if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
        const business = getBusinessRoute(session.businessId);
        return sendJson(res, 200, { businessId: session.businessId, business: business.json });
      }

      if (req.method === 'POST' && path === '/api/logout') {
        logout(parseCookies(req)[SESSION_COOKIE]);
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/accept-invite') {
        const body = await readJsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' });
        try {
          const session = acceptInvite({ token: body.token, password: body.password });
          setSessionCookie(res, session.token, session.expiresAt);
          return sendJson(res, 200, { ok: true, businessId: session.businessId });
        } catch (err) {
          if (!(err instanceof AuthError)) throw err;
          const status = err.code === 'bad_request' || err.code === 'weak_password' ? 400 : 401;
          return sendJson(res, status, { error: err.code, message: err.message });
        }
      }

      // Admin-only: create a new business + email its owner a "set your
      // password" invite. Same ?key=ADMIN_KEY convention as /api/signups
      // below — only you can onboard a business, no public self-serve yet.
      if (req.method === 'POST' && path === '/api/admin/businesses') {
        if (!config.adminKey || url.searchParams.get('key') !== config.adminKey) {
          return sendJson(res, 404, { error: 'not found' });
        }
        const body = await readJsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' });
        try {
          const result = await createBusinessWithOwner(body);
          return sendJson(res, 200, {
            business: result.business,
            ownerEmail: result.user.email,
            // Included directly in the response (not just emailed) since
            // RESEND_API_KEY may not be set yet — see auth/auth.js.
            inviteUrl: result.inviteUrl,
          });
        } catch (err) {
          if (!(err instanceof AuthError)) throw err;
          const status = err.code === 'bad_request' ? 400 : err.code === 'email_taken' ? 409 : 500;
          return sendJson(res, status, { error: err.code, message: err.message });
        }
      }

      // ---- Dashboard data (all require a session for THIS business) --------

      const businessMatch = path.match(/^\/api\/businesses\/(\d+)\/(conversations|appointments|compliance-summary)$/);
      if (req.method === 'GET' && businessMatch) {
        const businessId = Number(businessMatch[1]);
        if (!requireOwnBusiness(req, res, businessId)) return;
        const resource = businessMatch[2];
        const route =
          resource === 'conversations' ? getConversationsRoute(businessId)
          : resource === 'appointments' ? getAppointmentsRoute(businessId)
          : getComplianceSummaryRoute(businessId);
        return sendJson(res, route.status, route.json);
      }

      const conversationMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
      if (req.method === 'GET' && conversationMatch) {
        const conversationId = Number(conversationMatch[1]);
        const conversation = getConversation(conversationId);
        if (!conversation) return sendJson(res, 404, { error: 'conversation not found' });
        if (!requireOwnBusiness(req, res, conversation.business_id)) return;
        const route = getConversationMessagesRoute(conversationId);
        return sendJson(res, route.status, route.json);
      }

      const consentMatch = path.match(/^\/api\/businesses\/(\d+)\/customers\/(\d+)\/consent$/);
      if (req.method === 'GET' && consentMatch) {
        const businessId = Number(consentMatch[1]);
        if (!requireOwnBusiness(req, res, businessId)) return;
        const route = getCustomerConsentRoute(businessId, Number(consentMatch[2]));
        return sendJson(res, route.status, route.json);
      }

      // In-house booking engine: technicians + their weekly hours/time off.
      const techniciansMatch = path.match(/^\/api\/businesses\/(\d+)\/technicians$/);
      if (techniciansMatch && req.method === 'GET') {
        const businessId = Number(techniciansMatch[1]);
        if (!requireOwnBusiness(req, res, businessId)) return;
        const route = getTechniciansRoute(businessId);
        return sendJson(res, route.status, route.json);
      }
      if (techniciansMatch && req.method === 'POST') {
        const businessId = Number(techniciansMatch[1]);
        if (!requireOwnBusiness(req, res, businessId)) return;
        const body = await readJsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' });
        const route = createTechnicianRoute(businessId, body);
        return sendJson(res, route.status, route.json);
      }

      const availabilityMatch = path.match(/^\/api\/technicians\/(\d+)\/availability$/);
      if (availabilityMatch && req.method === 'PUT') {
        const technicianId = Number(availabilityMatch[1]);
        const tech = getTechnician(technicianId);
        if (!tech) return sendJson(res, 404, { error: 'technician not found' });
        if (!requireOwnBusiness(req, res, tech.business_id)) return;
        const body = await readJsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' });
        const route = setTechnicianAvailabilityRoute(technicianId, body);
        return sendJson(res, route.status, route.json);
      }

      const timeOffMatch = path.match(/^\/api\/technicians\/(\d+)\/time-off$/);
      if (timeOffMatch && req.method === 'POST') {
        const technicianId = Number(timeOffMatch[1]);
        const tech = getTechnician(technicianId);
        if (!tech) return sendJson(res, 404, { error: 'technician not found' });
        if (!requireOwnBusiness(req, res, tech.business_id)) return;
        const body = await readJsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' });
        const route = addTechnicianTimeOffRoute(technicianId, body);
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

      // Static dashboard UI (plain HTML/CSS/JS, no build step — same
      // zero-dependency approach as the rest of this backend). Served from
      // this same app/origin on purpose: the dashboard's own JS calls the
      // /api/* routes above as same-origin fetches, so no CORS handling is
      // needed here the way /api/website-chat needs it for a different origin.
      if (req.method === 'GET' && (path === '/dashboard' || path.startsWith('/dashboard/'))) {
        const handled = await serveDashboardFile(res, path === '/dashboard' ? '/dashboard/index.html' : path);
        if (handled) return;
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
