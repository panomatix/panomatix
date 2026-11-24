// Passwords (argon2id), sessions, CSRF, permissions and rate limiting.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { now } from './db.js';

const argon2 = promisify(crypto.argon2);

export const ROLE_RANK = { contributor: 1, moderator: 2, admin: 3 };
export const SESSION_COOKIE = 'pmx_session';
export const CSRF_HEADER = 'x-csrf-token';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// --- passwords ----------------------------------------------------------------
// OWASP 2024 recommendation for argon2id: m=19 MiB, t=2, p=1.
const ARGON = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

export async function hashPassword(password) {
  const nonce = crypto.randomBytes(16);
  const tag = await argon2('argon2id', { message: password, nonce, ...ARGON });
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${nonce.toString('base64url')}$${tag.toString('base64url')}`;
}

const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

/** Always performs one argon2 computation, also for unknown accounts (no timing oracle). */
export async function verifyPassword(stored, password) {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored || DUMMY_HASH);
  if (!m) return false;
  const expected = Buffer.from(m[5], 'base64url');
  const tag = await argon2('argon2id', {
    message: String(password).slice(0, 256),
    nonce: Buffer.from(m[4], 'base64url'),
    memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), tagLength: expected.length,
  });
  return Boolean(stored) && crypto.timingSafeEqual(tag, expected);
}

export const needsRehash = (stored) => !stored.startsWith(`$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$`);

export function checkPasswordPolicy(password, email = '') {
  if (typeof password !== 'string' || [...password].length < 10) throw new ApiError(400, 'weak_password', 'The password must be at least 10 characters long.');
  if (password.length > 256) throw new ApiError(400, 'weak_password', 'The password must be at most 256 characters long.');
  if (email && password.toLowerCase() === email.toLowerCase()) throw new ApiError(400, 'weak_password', 'The password must not be your email address.');
  if (new Set(password).size < 5) throw new ApiError(400, 'weak_password', 'The password is too repetitive.');
}

// --- sessions -------------------------------------------------------------------
// The token is only ever stored hashed: a leaked database does not leak live sessions.
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(ctx, userId, kind) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const ts = now();
  const days = kind === 'cookie' ? ctx.config.sessionDays : ctx.config.tokenDays;
  ctx.db.prepare(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, kind, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(tokenHash(token), userId, csrf, kind, ts, ts + days * 86400, ts, String(ctx.req.headers['user-agent'] ?? '').slice(0, 300), ctx.ip);
  return { token, csrf };
}

export const revokeSession = (db, token) => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));

export function revokeUserSessions(db, userId, keepToken = null) {
  if (keepToken) db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, tokenHash(keepToken));
  else db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}

/** Identify the caller from `Authorization: Bearer <token>` or the session cookie. */
export function authenticate(ctx) {
  ctx.user = null;
  const auth = ctx.req.headers.authorization ?? '';
  let token;
  let kind;
  if (auth.startsWith('Bearer ')) {
    token = auth.slice(7).trim();
    kind = 'token';
  } else {
    token = ctx.cookies[SESSION_COOKIE];
    kind = 'cookie';
  }
  if (!token) return;
  const row = ctx.db.prepare(
    `SELECT s.csrf_token, s.expires_at, s.last_seen_at, s.kind, u.id, u.email, u.display_name, u.role, u.is_active, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=?`,
  ).get(tokenHash(token));
  const ts = now();
  if (!row || row.expires_at < ts || !row.is_active || row.kind !== kind) return;
  if (ts - row.last_seen_at > 300) ctx.db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(ts, tokenHash(token));
  ctx.user = { id: row.id, email: row.email, display_name: row.display_name, role: row.role, created_at: row.created_at };
  ctx.sessionToken = token;
  ctx.authKind = kind;
  ctx.csrfToken = row.csrf_token;
}

/** Browsers attach cookies automatically, so a cookie-authenticated state-changing request
 *  must prove it comes from our own page by echoing the per-session CSRF token. */
export function enforceCsrf(ctx) {
  if (!MUTATING.has(ctx.req.method) || ctx.authKind !== 'cookie') return;
  // Signing in or up replaces the session: a stale cookie must not lock the user out.
  // (These endpoints only accept application/json, which a cross-site form cannot send.)
  if (ctx.url.pathname === '/api/v1/auth/login' || ctx.url.pathname === '/api/v1/auth/register') return;
  const sent = String(ctx.req.headers[CSRF_HEADER] ?? '');
  const a = Buffer.from(sent);
  const b = Buffer.from(ctx.csrfToken ?? '');
  if (!sent || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(403, 'csrf_failed', 'Missing or invalid CSRF token. Reload the page and try again.');
  }
}

export function requireUser(ctx, minRole = 'contributor') {
  if (!ctx.user) throw new ApiError(401, 'unauthenticated', 'You must be signed in.');
  if (ROLE_RANK[ctx.user.role] < ROLE_RANK[minRole]) throw new ApiError(403, 'forbidden', `This action requires the ${minRole} role.`);
  return ctx.user;
}

// --- rate limiting (in SQLite so limits survive restarts) ---------------------------

export function rateLimit(db, bucket, limit, windowS) {
  const ts = now();
  db.prepare('DELETE FROM rate_events WHERE bucket=? AND ts<?').run(bucket, ts - windowS);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket=?').get(bucket);
  if (n >= limit) throw new ApiError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.');
  db.prepare('INSERT INTO rate_events (bucket, ts) VALUES (?,?)').run(bucket, ts);
}

export const clearRateLimit = (db, bucket) => db.prepare('DELETE FROM rate_events WHERE bucket=?').run(bucket);
