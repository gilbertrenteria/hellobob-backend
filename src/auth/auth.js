// Dashboard login: password hashing, invite tokens, and sessions. All
// built on Node's own built-in `node:crypto` — no bcrypt/jsonwebtoken
// dependency, same zero-dependency approach as the rest of this backend.
//
// Deliberately simple for the current scale (you onboarding a handful of
// businesses by hand): one business creation path, admin-only, sends the
// owner a "set your password" invite email. No self-serve signup, no
// password-reset flow yet — see the README/roadmap for what's still missing
// before this should be opened up to many customers.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import {
  createBusiness,
  createUserInvite,
  getUserByEmail,
  getUserByInviteToken,
  getUserById,
  setUserPassword,
  createSession,
  getValidSession,
  deleteSession,
} from '../db.js';
import { sendEmail } from '../email/resend.js';

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCRYPT_KEYLEN = 64;

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

// ---- Passwords --------------------------------------------------------------

/** "saltHex:hashHex" — scrypt's own recommended params, no external tuning needed at this scale. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  // Lengths always match here (fixed SCRYPT_KEYLEN), but guard anyway —
  // timingSafeEqual throws on mismatched lengths instead of returning false.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function newToken() {
  return randomBytes(32).toString('hex');
}

// ---- Account creation (admin-only — see routes/api.js) ---------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inviteEmailHtml(businessName, inviteUrl) {
  return `
    <p>Hi there,</p>
    <p>Your HelloBob dashboard for <strong>${escapeHtml(businessName)}</strong> is ready.</p>
    <p><a href="${inviteUrl}" style="display:inline-block;background:#E5231A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Set your password</a></p>
    <p>This link works once and expires in 7 days.</p>
    <p>&mdash; The HelloBob team</p>
  `;
}

/**
 * @param {object} opts
 * @param {string} opts.name business name
 * @param {string} opts.phoneE164 the Twilio number customers text/call
 * @param {string} [opts.state] 2-letter state code
 * @param {string} [opts.timezone]
 * @param {object} [opts.config] BusinessConfig (see businessConfig.example.js)
 * @param {string} opts.ownerEmail where the "set your password" invite goes
 * @param {object} [deps] injectable for tests, same seam used elsewhere in this codebase
 * @returns {{business: object, user: object, inviteUrl: string}}
 */
export async function createBusinessWithOwner(
  { name, phoneE164, state, timezone, config: businessConfig, ownerEmail },
  deps = {}
) {
  const { sendEmail: sendEmailFn = sendEmail } = deps;

  if (!name || !phoneE164 || !ownerEmail) {
    throw new AuthError('bad_request', 'name, phoneE164, and ownerEmail are all required');
  }
  if (getUserByEmail(ownerEmail)) {
    throw new AuthError('email_taken', `${ownerEmail} already has a dashboard account`);
  }

  const business = createBusiness({ name, phoneE164, state, timezone, config: businessConfig || {} });
  const inviteToken = newToken();
  const user = createUserInvite({
    businessId: business.id,
    email: ownerEmail,
    inviteToken,
    inviteExpiresAt: isoIn(INVITE_TTL_MS),
  });

  const inviteUrl = `${config.publicBaseUrl}/dashboard/accept-invite.html?token=${inviteToken}`;
  await sendEmailFn({ to: ownerEmail, subject: 'Set up your HelloBob dashboard', html: inviteEmailHtml(name, inviteUrl) });

  return { business, user, inviteUrl };
}

// ---- Accepting an invite / logging in ---------------------------------------

/** @returns {{token: string, businessId: number, expiresAt: string}} a new session */
export function acceptInvite({ token, password }) {
  if (!token || !password) throw new AuthError('bad_request', 'token and password are required');
  if (password.length < 8) throw new AuthError('weak_password', 'Password must be at least 8 characters');

  const user = getUserByInviteToken(token);
  if (!user) throw new AuthError('invalid_invite', 'This invite link is invalid or was already used');
  if (new Date(user.invite_expires_at).getTime() < Date.now()) {
    throw new AuthError('expired_invite', 'This invite link has expired');
  }

  setUserPassword(user.id, hashPassword(password));
  return startSession(user.id, user.business_id);
}

/** @returns {{token: string, businessId: number, expiresAt: string}} a new session */
export function login({ email, password }) {
  if (!email || !password) throw new AuthError('bad_request', 'email and password are required');
  const user = getUserByEmail(email);
  // Same generic error whether the email doesn't exist or the password is
  // wrong — never reveal which one it was.
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    throw new AuthError('invalid_credentials', 'Incorrect email or password');
  }
  return startSession(user.id, user.business_id);
}

function startSession(userId, businessId) {
  const token = newToken();
  const expiresAt = isoIn(SESSION_TTL_MS);
  createSession({ token, userId, businessId, expiresAt });
  return { token, businessId, expiresAt };
}

export function logout(token) {
  if (token) deleteSession(token);
}

/** @returns {{userId: number, businessId: number}|null} */
export function sessionFromToken(token) {
  if (!token) return null;
  const session = getValidSession(token);
  if (!session) return null;
  return { userId: session.user_id, businessId: session.business_id };
}

export function getUser(userId) {
  return getUserById(userId);
}
