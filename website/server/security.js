// Passwords (argon2id), sessions, CSRF, permissions and rate limiting.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { now } from './db.js';

const argon2 = promisify(crypto.argon2);

export const ROLE_RANK = { contributor: 1, moderator: 2, admin: 3 };
export const SESSION_COOKIE = 'pmx_session';
export const CSRF_HEADER = 'x-csrf-token';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Endpoints used while signed out (they open a session or send an email): a stale cookie must not block them.
const NO_CSRF = new Set(['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/forgot-password',
  '/api/v1/auth/link', '/api/v1/auth/set-password']);

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

// --- one-use links sent by email ---------------------------------------------------

/** Issue a link token for a user; it replaces any earlier link of the same user. */
export function createEmailToken(db, userId, purpose, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ts = now();
  db.prepare('DELETE FROM email_tokens WHERE user_id=?').run(userId);
  db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(tokenHash(token), userId, purpose, ts, ts + hours * 3600);
  return token;
}

/** The valid link token and its active user, or an error. */
export function findEmailToken(db, token) {
  const row = typeof token === 'string' && token.length <= 100 && db.prepare(
    `SELECT t.token_hash, t.purpose, t.expires_at, u.* FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash=?`,
  ).get(tokenHash(token));
  if (!row || row.expires_at < now() || !row.is_active) {
    throw new ApiError(400, 'invalid_token', 'This link is invalid or has expired. Ask for a new one.');
  }
  return row;
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
  // (These endpoints only accept application/json, which a cross-site form cannot send.)
  if (NO_CSRF.has(ctx.url.pathname)) return;
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

// --- pace of external API clients --------------------------------------------------------------------
// Scripts and bots may call the API at most config.apiRatePerSecond times a second (per Bearer token, or
// per IP without one). The site's own pages are exempt: browsers mark their requests with
// "Sec-Fetch-Site: same-origin", a header no other web page can forge. Kept in memory: the server is a
// single process, and a one-second window needs no persistence.
const lastApiCall = new Map(); // client key -> time of its last accepted request (ms)

export function paceApiClient(ctx) {
  const perSecond = ctx.config.apiRatePerSecond;
  if (!perSecond || !ctx.url.pathname.startsWith('/api/')) return;
  if (ctx.req.headers['sec-fetch-site'] === 'same-origin') return;
  const key = ctx.authKind === 'token' && ctx.user ? `user:${ctx.user.id}` : `ip:${ctx.ip}`;
  const gap = 1000 / perSecond;
  const t = Date.now();
  const last = lastApiCall.get(key);
  ctx.res.setHeader('RateLimit-Policy', `${perSecond};w=1`);
  if (last !== undefined && t - last < gap) {
    ctx.res.setHeader('Retry-After', String(Math.max(1, Math.ceil((gap - (t - last)) / 1000))));
    throw new ApiError(429, 'too_many_requests',
      `API clients are limited to ${perSecond} request${perSecond > 1 ? 's' : ''} per second. Wait for the delay given in Retry-After, then retry.`);
  }
  lastApiCall.set(key, t);
  if (lastApiCall.size > 5000) for (const [k, v] of lastApiCall) if (t - v > 10_000) lastApiCall.delete(k);
}
