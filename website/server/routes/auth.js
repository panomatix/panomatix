// /api/v1/auth — accounts (email + password) and sessions.
import { now } from '../db.js';
import { readJson, send, serializeCookie } from '../http.js';
import {
  ApiError, SESSION_COOKIE, checkPasswordPolicy, clearRateLimit, createSession, hashPassword, needsRehash,
  rateLimit, requireUser, revokeSession, revokeUserSessions, verifyPassword,
} from '../security.js';

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

export const publicUser = (u) => ({ id: u.id, email: u.email, display_name: u.display_name, role: u.role, created_at: u.created_at });

export function cleanEmail(v) {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new ApiError(400, 'invalid_email', 'Enter a valid email address.');
  return email;
}

export function cleanName(v) {
  const name = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  // eslint-disable-next-line no-control-regex
  if ([...name].length < 2 || [...name].length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ApiError(400, 'invalid_display_name', 'The display name must be 2 to 60 characters long.');
  }
  return name;
}

function sessionResponse(ctx, user, kind, status = 200) {
  const { token, csrf } = createSession(ctx, user.id, kind);
  if (kind === 'token') return send(ctx, status, { user: publicUser(user), token, token_type: 'Bearer' });
  return send(ctx, status, { user: publicUser(user), csrf_token: csrf }, {
    'Set-Cookie': serializeCookie(SESSION_COOKIE, token, { maxAge: ctx.config.sessionDays * 86400, secure: ctx.config.cookieSecure }),
  });
}

export function registerAuthRoutes(router) {
  router.add('POST', '/api/v1/auth/register', async (ctx) => {
    const body = await readJson(ctx);
    rateLimit(ctx.db, `register:${ctx.ip}`, ctx.config.registerLimit, 3600);
    if (!ctx.config.registrationOpen) throw new ApiError(403, 'registration_closed', 'Registration is currently closed.');
    const email = cleanEmail(body.email);
    const name = cleanName(body.display_name);
    checkPasswordPolicy(body.password, email);
    if (ctx.db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      throw new ApiError(409, 'email_taken', 'An account already exists with this email address.');
    }
    const hash = await hashPassword(body.password);
    const ts = now();
    let id;
    try {
      ({ lastInsertRowid: id } = ctx.db.prepare(
        'INSERT INTO users (email, display_name, password_hash, role, created_at, last_login_at) VALUES (?,?,?,?,?,?)',
      ).run(email, name, hash, 'contributor', ts, ts));
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new ApiError(409, 'email_taken', 'An account already exists with this email address.');
      throw err;
    }
    const user = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    return sessionResponse(ctx, user, 'cookie', 201);
  });

  router.add('POST', '/api/v1/auth/login', async (ctx) => {
    const body = await readJson(ctx);
    const email = cleanEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const mode = body.mode ?? 'cookie';
    if (!['cookie', 'token'].includes(mode)) throw new ApiError(400, 'invalid_mode', "mode must be 'cookie' or 'token'.");
    rateLimit(ctx.db, `login-ip:${ctx.ip}`, ctx.config.loginLimit * 3, 900);
    rateLimit(ctx.db, `login-email:${email}`, ctx.config.loginLimit, 900);
    const user = ctx.db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const ok = await verifyPassword(user?.password_hash, password);
    if (!ok) throw new ApiError(401, 'invalid_credentials', 'Wrong email or password.');
    if (!user.is_active) throw new ApiError(403, 'account_disabled', 'This account has been disabled.');
    clearRateLimit(ctx.db, `login-email:${email}`);
    ctx.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now(), user.id);
    if (needsRehash(user.password_hash)) {
      ctx.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password), user.id);
    }
    return sessionResponse(ctx, user, mode);
  });

  router.add('POST', '/api/v1/auth/logout', (ctx) => {
    if (ctx.sessionToken) revokeSession(ctx.db, ctx.sessionToken);
    send(ctx, 200, { ok: true }, {
      'Set-Cookie': serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: ctx.config.cookieSecure }),
    });
  });

  router.add('GET', '/api/v1/auth/me', (ctx) => {
    if (!ctx.user) return send(ctx, 200, { user: null });
    return send(ctx, 200, { user: ctx.user, ...(ctx.authKind === 'cookie' ? { csrf_token: ctx.csrfToken } : {}) });
  });

  router.add('PATCH', '/api/v1/auth/me', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    const name = cleanName(body.display_name);
    ctx.db.prepare('UPDATE users SET display_name=? WHERE id=?').run(name, user.id);
    send(ctx, 200, { user: { ...user, display_name: name } });
  });

  router.add('POST', '/api/v1/auth/password', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    rateLimit(ctx.db, `password:${user.id}`, 10, 900);
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    if (!(await verifyPassword(row.password_hash, String(body.current_password ?? '')))) {
      throw new ApiError(400, 'invalid_credentials', 'The current password is wrong.');
    }
    checkPasswordPolicy(body.new_password, user.email);
    ctx.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(body.new_password), user.id);
    revokeUserSessions(ctx.db, user.id, ctx.sessionToken); // sign out every other device
    send(ctx, 200, { ok: true });
  });
}
