// /api/v1/auth — accounts (email + password), links sent by email, sessions.
import { now, transaction } from '../db.js';
import { readJson, send, serializeCookie } from '../http.js';
import { MAIL_LANGUAGES, linkMessage } from '../mail.js';
import {
  ApiError, SESSION_COOKIE, checkPasswordPolicy, clearRateLimit, createEmailToken, createSession, findEmailToken,
  hashPassword, needsRehash, rateLimit, requireUser, revokeSession, revokeUserSessions, verifyPassword,
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

/** Honeypot: the forms carry a "website" field that people never see; robots fill every field.
 *  They get the usual answer, and nothing is sent. */
const isBot = (body) => typeof body.website === 'string' && body.website !== '';

/** An account created by sign-up whose owner has not opened the emailed link yet. */
const isPending = (u) => u.password_hash === '';

/** Email a one-use link to the set-password page. Sent in the background: the answer does not wait for
 *  the mail server (and takes the same time whether a message is sent or not). */
function sendLink(ctx, user, kind, lang) {
  const purpose = kind === 'verify' ? 'verify' : 'reset';
  const hours = purpose === 'verify' ? ctx.config.verifyHours : ctx.config.resetHours;
  const token = createEmailToken(ctx.db, user.id, purpose, hours);
  const link = `${ctx.config.publicUrl}/#/set-password?token=${token}`;
  const msg = linkMessage({ kind, lang: MAIL_LANGUAGES.includes(lang) ? lang : 'en', name: user.display_name, link, hours });
  Promise.resolve()
    .then(() => ctx.mailer.send({ to: user.email, ...msg }))
    .catch((err) => console.error(`Email to ${user.email} failed: ${err.message}`));
}

function sessionResponse(ctx, user, kind, status = 200) {
  const { token, csrf } = createSession(ctx, user.id, kind);
  if (kind === 'token') return send(ctx, status, { user: publicUser(user), token, token_type: 'Bearer' });
  return send(ctx, status, { user: publicUser(user), csrf_token: csrf }, {
    'Set-Cookie': serializeCookie(SESSION_COOKIE, token, { maxAge: ctx.config.sessionDays * 86400, secure: ctx.config.cookieSecure }),
  });
}

export function registerAuthRoutes(router) {
  // Step 1 of sign-up: email + display name. The password is chosen from the emailed link (set-password).
  // The answer is the same whether the address is new or not, so it cannot reveal who has an account.
  router.add('POST', '/api/v1/auth/register', async (ctx) => {
    const body = await readJson(ctx);
    rateLimit(ctx.db, `register:${ctx.ip}`, ctx.config.registerLimit, 3600);
    if (!ctx.config.registrationOpen) throw new ApiError(403, 'registration_closed', 'Registration is currently closed.');
    if (isBot(body)) return send(ctx, 202, { ok: true });
    const email = cleanEmail(body.email);
    const name = cleanName(body.display_name);
    rateLimit(ctx.db, `mail:${email}`, ctx.config.mailLimit, 3600);
    const find = () => ctx.db.prepare('SELECT * FROM users WHERE email=?').get(email);
    let user = find();
    if (!user) {
      try {
        ctx.db.prepare('INSERT INTO users (email, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
          .run(email, name, '', 'contributor', now());
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err;
      }
      user = find();
    } else if (isPending(user)) {
      ctx.db.prepare('UPDATE users SET display_name=? WHERE id=?').run(name, user.id);
      user.display_name = name;
    }
    if (user.is_active) sendLink(ctx, user, isPending(user) ? 'verify' : 'exists', body.lang);
    send(ctx, 202, { ok: true });
  });

  router.add('POST', '/api/v1/auth/forgot-password', async (ctx) => {
    const body = await readJson(ctx);
    rateLimit(ctx.db, `forgot:${ctx.ip}`, ctx.config.registerLimit * 2, 3600);
    if (isBot(body)) return send(ctx, 202, { ok: true });
    const email = cleanEmail(body.email);
    rateLimit(ctx.db, `mail:${email}`, ctx.config.mailLimit, 3600);
    const user = ctx.db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (user?.is_active) sendLink(ctx, user, isPending(user) ? 'verify' : 'reset', body.lang);
    send(ctx, 202, { ok: true });
  });

  // What an emailed link is for, so the page can greet the user (or say the link is dead) before they type.
  router.add('POST', '/api/v1/auth/link', async (ctx) => {
    const body = await readJson(ctx);
    rateLimit(ctx.db, `link:${ctx.ip}`, 30, 900);
    const row = findEmailToken(ctx.db, body.token);
    send(ctx, 200, { purpose: row.purpose, email: row.email, display_name: row.display_name });
  });

  // Step 2: the emailed link sets the password, confirms the address and signs the user in.
  router.add('POST', '/api/v1/auth/set-password', async (ctx) => {
    const body = await readJson(ctx);
    rateLimit(ctx.db, `link:${ctx.ip}`, 30, 900);
    const row = findEmailToken(ctx.db, body.token);
    checkPasswordPolicy(body.password, row.email);
    const hash = await hashPassword(body.password);
    // Consume the link; if a concurrent request used it first, this one fails.
    if (ctx.db.prepare('DELETE FROM email_tokens WHERE token_hash=?').run(row.token_hash).changes !== 1) {
      throw new ApiError(400, 'invalid_token', 'This link is invalid or has expired. Ask for a new one.');
    }
    const ts = now();
    ctx.db.prepare('UPDATE users SET password_hash=?, email_verified_at=COALESCE(email_verified_at, ?), last_login_at=? WHERE id=?')
      .run(hash, ts, ts, row.id);
    ctx.db.prepare('DELETE FROM email_tokens WHERE user_id=?').run(row.id);
    revokeUserSessions(ctx.db, row.id); // a reset signs out every device
    clearRateLimit(ctx.db, `login-email:${row.email}`);
    const user = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(row.id);
    return sessionResponse(ctx, user, 'cookie');
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

  // Delete one's own account. Edits stay in the history, without the author's name.
  router.add('DELETE', '/api/v1/auth/me', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    rateLimit(ctx.db, `password:${user.id}`, 10, 900);
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    if (!(await verifyPassword(row.password_hash, String(body.password ?? '')))) {
      throw new ApiError(400, 'invalid_credentials', 'The password is wrong.');
    }
    if (user.role === 'admin' && ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1").get().n <= 1) {
      throw new ApiError(409, 'last_admin', 'You are the only administrator: make someone else administrator first.');
    }
    transaction(ctx.db, () => {
      ctx.db.prepare('UPDATE revisions SET user_id=NULL WHERE user_id=?').run(user.id);
      ctx.db.prepare('UPDATE signs SET updated_by=NULL WHERE updated_by=?').run(user.id);
      ctx.db.prepare('UPDATE images SET uploaded_by=NULL WHERE uploaded_by=?').run(user.id);
      ctx.db.prepare('DELETE FROM rate_events WHERE bucket LIKE ?').run(`%:${user.email}`);
      ctx.db.prepare('DELETE FROM users WHERE id=?').run(user.id); // sessions and links go with it (ON DELETE CASCADE)
    });
    send(ctx, 200, { ok: true }, {
      'Set-Cookie': serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: ctx.config.cookieSecure }),
    });
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
