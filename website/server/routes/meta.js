// /api/v1/meta — schema, closed vocabularies, countries, statistics; /api/v1/users — account administration.
import { readJson, send } from '../http.js';
import { ApiError, ROLE_RANK, checkPasswordPolicy, hashPassword, requireUser, revokeUserSessions } from '../security.js';
import { SCHEMA, vocabularies } from '../validation.js';

export function registerMetaRoutes(router) {
  router.add('GET', '/api/v1/health', (ctx) => send(ctx, 200, { ok: true }));

  router.add('GET', '/api/v1/meta/schema', (ctx) => send(ctx, 200, SCHEMA, { 'Cache-Control': 'public, max-age=300' }));

  router.add('GET', '/api/v1/meta/vocabularies', (ctx) => {
    const categories = ctx.db.prepare('SELECT category, COUNT(*) AS n FROM signs WHERE deleted=0 GROUP BY category ORDER BY category').all();
    const languages = new Set();
    // Language keys in use, so the editor can suggest them.
    for (const { data } of ctx.db.prepare("SELECT data FROM signs WHERE deleted=0 AND reference LIKE 'VIENNA%'").all()) {
      for (const k of Object.keys(JSON.parse(data).name ?? {})) languages.add(k);
    }
    send(ctx, 200, { ...vocabularies(), categories: categories.map((c) => ({ value: c.category, count: c.n })), nameLanguages: [...languages].sort() });
  });

  router.add('GET', '/api/v1/meta/countries', (ctx) => {
    const rows = ctx.db.prepare(
      `SELECT c.jurisdiction, c.country_code, COUNT(DISTINCT c.reference) AS signs
       FROM sign_codes c JOIN signs s ON s.reference=c.reference AND s.deleted=0
       GROUP BY c.jurisdiction, c.country_code ORDER BY c.jurisdiction, c.country_code`,
    ).all();
    send(ctx, 200, { items: rows });
  });

  router.add('GET', '/api/v1/meta/stats', (ctx) => {
    const one = (sql) => ctx.db.prepare(sql).get().n;
    send(ctx, 200, {
      signs: one('SELECT COUNT(*) AS n FROM signs WHERE deleted=0'),
      vienna: one("SELECT COUNT(*) AS n FROM signs WHERE deleted=0 AND reference LIKE 'VIENNA%'"),
      national: one("SELECT COUNT(*) AS n FROM signs WHERE deleted=0 AND reference LIKE 'OTHER:%'"),
      contributors: one('SELECT COUNT(*) AS n FROM users WHERE is_active=1'),
      edits: one("SELECT COUNT(*) AS n FROM revisions WHERE action <> 'import'"),
      uploaded_images: one('SELECT COUNT(*) AS n FROM images'),
    });
  });

  // --- users ---------------------------------------------------------------------

  router.add('GET', '/api/v1/users', (ctx) => {
    requireUser(ctx, 'moderator');
    const rows = ctx.db.prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.created_at, u.last_login_at,
              u.password_hash = '' AS pending,
              (SELECT COUNT(*) FROM revisions r WHERE r.user_id=u.id) AS edits
       FROM users u ORDER BY u.created_at DESC`,
    ).all();
    send(ctx, 200, { items: rows.map((r) => ({ ...r, is_active: Boolean(r.is_active), pending: Boolean(r.pending) })) });
  });

  router.add('PATCH', '/api/v1/users/:id', async (ctx) => {
    const me = requireUser(ctx, 'moderator');
    const body = await readJson(ctx);
    const target = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(Number(ctx.params.id));
    if (!target) throw new ApiError(404, 'not_found', 'No such user.');
    if (target.id === me.id) throw new ApiError(400, 'self_edit', 'You cannot change your own role or status.');
    if (ROLE_RANK[target.role] >= ROLE_RANK[me.role]) throw new ApiError(403, 'forbidden', 'You cannot manage a user with the same or a higher role.');
    if ('role' in body) {
      if (me.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only administrators can change roles.');
      if (!(body.role in ROLE_RANK)) throw new ApiError(400, 'invalid_role', 'role must be contributor, moderator or admin.');
      ctx.db.prepare('UPDATE users SET role=? WHERE id=?').run(body.role, target.id);
    }
    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') throw new ApiError(400, 'invalid_status', 'is_active must be true or false.');
      ctx.db.prepare('UPDATE users SET is_active=? WHERE id=?').run(body.is_active ? 1 : 0, target.id);
      if (!body.is_active) revokeUserSessions(ctx.db, target.id);
    }
    const u = ctx.db.prepare("SELECT id, email, display_name, role, is_active, created_at, last_login_at, password_hash = '' AS pending FROM users WHERE id=?").get(target.id);
    send(ctx, 200, { user: { ...u, is_active: Boolean(u.is_active), pending: Boolean(u.pending) } });
  });

  // An administrator sets a temporary password (users can also reset theirs by email).
  router.add('POST', '/api/v1/users/:id/password', async (ctx) => {
    const me = requireUser(ctx, 'admin');
    const body = await readJson(ctx);
    const target = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(Number(ctx.params.id));
    if (!target) throw new ApiError(404, 'not_found', 'No such user.');
    if (target.id === me.id) throw new ApiError(400, 'self_edit', 'Use the account page to change your own password.');
    checkPasswordPolicy(body.new_password, target.email);
    ctx.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(body.new_password), target.id);
    revokeUserSessions(ctx.db, target.id);
    send(ctx, 200, { ok: true });
  });
}
