// /api/v1/signs — read, search, create, edit (optimistic locking), delete/restore, history, revert, export.
import { addRevision, iterCodes, now, storeSign, transaction } from '../db.js';
import { imagesForEntry, mediaUrl } from '../images.js';
import { readJson, send } from '../http.js';
import { ApiError, rateLimit, requireUser } from '../security.js';
import { normalizeEntry, validateEntry } from '../validation.js';

const userName = (db, id) => (id == null ? null : db.prepare('SELECT id, display_name FROM users WHERE id=?').get(id) ?? null);

function cleanComment(v) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new ApiError(400, 'invalid_comment', 'comment must be a string.');
  const c = v.replace(/\s+/g, ' ').trim();
  if (c.length > 500) throw new ApiError(400, 'invalid_comment', 'The comment must be at most 500 characters.');
  return c;
}

function expectVersion(v) {
  if (!Number.isInteger(v) || v < 1) throw new ApiError(400, 'missing_version', 'Send the `version` you edited, to detect concurrent edits.');
  return v;
}

function checkedEntry(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError(422, 'validation_failed', 'The sign does not match the database schema.', { details: [{ path: '$', message: 'an entry must be a JSON object' }] });
  }
  const entry = normalizeEntry(structuredClone(data));
  const errors = validateEntry(entry);
  if (errors.length) throw new ApiError(422, 'validation_failed', 'The sign does not match the database schema.', { details: errors });
  return entry;
}

function loadRow(db, reference) {
  const row = db.prepare('SELECT * FROM signs WHERE reference=?').get(reference);
  if (!row) throw new ApiError(404, 'not_found', `No sign ${reference}.`);
  return row;
}

function conflict(row) {
  return new ApiError(409, 'edit_conflict', 'Someone else changed this sign since you opened it. Reload it and apply your changes again.', {
    current_version: row.version,
  });
}

function fullSign(ctx, row) {
  const data = JSON.parse(row.data);
  return {
    reference: row.reference,
    version: row.version,
    deleted: Boolean(row.deleted),
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: userName(ctx.db, row.updated_by),
    data,
    images: imagesForEntry(ctx.images, data),
    vienna_images: ctx.vienna.get(row.reference, data),
  };
}

function thumbnail(ctx, reference, country) {
  const official = !country && ctx.vienna.main(reference);
  if (official) return { code: reference, url: official, official: true };
  const rows = country
    ? ctx.db.prepare('SELECT code FROM sign_codes WHERE reference=? AND (country_code=? OR jurisdiction=?)').all(reference, country, country)
    : ctx.db.prepare('SELECT code FROM sign_codes WHERE reference=?').all(reference);
  for (const { code } of rows) {
    const hit = ctx.images.lookup(code);
    if (hit.length) return { code, url: mediaUrl(hit[0]) };
  }
  return null;
}

function intParam(ctx, name, def, min, max) {
  const raw = ctx.query.get(name);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, 'invalid_parameter', `${name} must be an integer between ${min} and ${max}.`);
  return n;
}

export function registerSignRoutes(router) {
  // Search / list.
  router.add('GET', '/api/v1/signs', (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase().slice(0, 200);
    const category = ctx.query.get('category') ?? '';
    const country = (ctx.query.get('country') ?? '').toLowerCase();
    const kind = ctx.query.get('kind') ?? '';
    const deleted = ctx.query.get('deleted') === '1';
    const page = intParam(ctx, 'page', 1, 1, 100000);
    const perPage = intParam(ctx, 'per_page', 50, 1, 200);

    const where = ['s.deleted=?'];
    const args = [deleted ? 1 : 0];
    if (category) {
      where.push('s.category=?');
      args.push(category);
    }
    if (kind === 'vienna') where.push("s.reference LIKE 'VIENNA%'");
    else if (kind === 'other') where.push("s.reference LIKE 'OTHER:%'");
    else if (kind && kind !== 'all') throw new ApiError(400, 'invalid_parameter', 'kind must be vienna, other or all.');
    if (country) {
      where.push('EXISTS (SELECT 1 FROM sign_codes c WHERE c.reference=s.reference AND (c.country_code=? OR c.jurisdiction=?))');
      args.push(country, country);
    }
    for (const word of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("s.search_text LIKE ? ESCAPE '\\'");
      args.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const sqlWhere = where.join(' AND ');
    const { n: total } = ctx.db.prepare(`SELECT COUNT(*) AS n FROM signs s WHERE ${sqlWhere}`).get(...args);
    const rows = ctx.db.prepare(
      `SELECT s.reference, s.category, s.version, s.deleted, s.updated_at, s.data FROM signs s WHERE ${sqlWhere}
       ORDER BY s.sort_key LIMIT ? OFFSET ?`,
    ).all(...args, perPage, (page - 1) * perPage);
    const items = rows.map((r) => {
      const d = JSON.parse(r.data);
      const countries = new Set([...iterCodes(d)].map(([cc]) => cc));
      return {
        reference: r.reference,
        category: r.category,
        name: d.name ?? {},
        version: r.version,
        deleted: Boolean(r.deleted),
        updated_at: r.updated_at,
        designs: d.officialSign?.designs?.length ?? 0,
        countries: countries.size,
        codes: country ? [...iterCodes(d)].filter(([cc, jk]) => cc === country || jk === country).map(([, , c]) => c) : undefined,
        thumbnail: thumbnail(ctx, r.reference, country),
      };
    });
    send(ctx, 200, { total, page, per_page: perPage, items });
  });

  router.add('GET', '/api/v1/signs/:ref', (ctx) => send(ctx, 200, fullSign(ctx, loadRow(ctx.db, ctx.params.ref))));

  // Create.
  router.add('POST', '/api/v1/signs', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    rateLimit(ctx.db, `edit:${user.id}`, ctx.config.editLimit, 3600);
    const entry = checkedEntry(body.data);
    const comment = cleanComment(body.comment);
    const ts = now();
    transaction(ctx.db, () => {
      const existing = ctx.db.prepare('SELECT deleted FROM signs WHERE reference=?').get(entry.reference);
      if (existing) {
        throw new ApiError(409, 'already_exists', existing.deleted
          ? `${entry.reference} exists but was deleted; a moderator can restore it.`
          : `${entry.reference} already exists.`);
      }
      storeSign(ctx.db, entry, { version: 1, userId: user.id, ts, insert: true });
      ctx.images.learnEntry(entry);
      addRevision(ctx.db, { reference: entry.reference, version: 1, action: 'create', entry, comment, userId: user.id, ts });
    });
    send(ctx, 201, fullSign(ctx, loadRow(ctx.db, entry.reference)));
  });

  // Replace (optimistic locking on `version`).
  router.add('PUT', '/api/v1/signs/:ref', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    rateLimit(ctx.db, `edit:${user.id}`, ctx.config.editLimit, 3600);
    const version = expectVersion(body.version);
    const entry = checkedEntry(body.data);
    if (entry.reference !== ctx.params.ref) {
      throw new ApiError(400, 'reference_mismatch', 'The reference cannot be changed: create a new sign and delete this one instead.');
    }
    const comment = cleanComment(body.comment);
    const ts = now();
    const unchanged = transaction(ctx.db, () => {
      const row = loadRow(ctx.db, ctx.params.ref);
      if (row.deleted) throw new ApiError(409, 'deleted', 'This sign was deleted; a moderator must restore it first.');
      if (row.version !== version) throw conflict(row);
      if (row.data === JSON.stringify(entry)) return true;
      storeSign(ctx.db, entry, { version: version + 1, userId: user.id, ts, insert: false });
      ctx.images.learnEntry(entry);
      addRevision(ctx.db, { reference: entry.reference, version: version + 1, action: 'update', entry, comment, userId: user.id, ts });
      return false;
    });
    send(ctx, 200, { ...fullSign(ctx, loadRow(ctx.db, ctx.params.ref)), unchanged });
  });

  // Soft delete (moderators).
  router.add('DELETE', '/api/v1/signs/:ref', async (ctx) => {
    const user = requireUser(ctx, 'moderator');
    const body = await readJson(ctx);
    const version = expectVersion(body.version);
    const comment = cleanComment(body.comment);
    const ts = now();
    transaction(ctx.db, () => {
      const row = loadRow(ctx.db, ctx.params.ref);
      if (row.deleted) throw new ApiError(409, 'deleted', 'This sign is already deleted.');
      if (row.version !== version) throw conflict(row);
      const entry = JSON.parse(row.data);
      storeSign(ctx.db, entry, { version: version + 1, userId: user.id, ts, deleted: true, insert: false });
      ctx.images.learnEntry(entry);
      addRevision(ctx.db, { reference: row.reference, version: version + 1, action: 'delete', entry: null, comment, userId: user.id, ts });
    });
    send(ctx, 200, fullSign(ctx, loadRow(ctx.db, ctx.params.ref)));
  });

  router.add('POST', '/api/v1/signs/:ref/restore', async (ctx) => {
    const user = requireUser(ctx, 'moderator');
    const body = await readJson(ctx);
    const version = expectVersion(body.version);
    const comment = cleanComment(body.comment);
    const ts = now();
    transaction(ctx.db, () => {
      const row = loadRow(ctx.db, ctx.params.ref);
      if (!row.deleted) throw new ApiError(409, 'not_deleted', 'This sign is not deleted.');
      if (row.version !== version) throw conflict(row);
      const entry = JSON.parse(row.data);
      storeSign(ctx.db, entry, { version: version + 1, userId: user.id, ts, insert: false });
      ctx.images.learnEntry(entry);
      addRevision(ctx.db, { reference: row.reference, version: version + 1, action: 'restore', entry, comment, userId: user.id, ts });
    });
    send(ctx, 200, fullSign(ctx, loadRow(ctx.db, ctx.params.ref)));
  });

  // History.
  router.add('GET', '/api/v1/signs/:ref/revisions', (ctx) => {
    loadRow(ctx.db, ctx.params.ref);
    const rows = ctx.db.prepare(
      `SELECT r.version, r.action, r.comment, r.created_at, r.user_id, u.display_name FROM revisions r
       LEFT JOIN users u ON u.id = r.user_id WHERE r.reference=? ORDER BY r.version DESC`,
    ).all(ctx.params.ref);
    send(ctx, 200, {
      reference: ctx.params.ref,
      revisions: rows.map((r) => ({
        version: r.version, action: r.action, comment: r.comment, created_at: r.created_at,
        user: r.user_id == null ? null : { id: r.user_id, display_name: r.display_name },
      })),
    });
  });

  router.add('GET', '/api/v1/signs/:ref/revisions/:version', (ctx) => {
    const r = ctx.db.prepare(
      `SELECT r.*, u.display_name FROM revisions r LEFT JOIN users u ON u.id = r.user_id WHERE r.reference=? AND r.version=?`,
    ).get(ctx.params.ref, Number(ctx.params.version));
    if (!r) throw new ApiError(404, 'not_found', 'No such revision.');
    send(ctx, 200, {
      reference: r.reference, version: r.version, action: r.action, comment: r.comment, created_at: r.created_at,
      user: r.user_id == null ? null : { id: r.user_id, display_name: r.display_name },
      data: r.data == null ? null : JSON.parse(r.data),
    });
  });

  // Revert to an earlier revision (moderators) — recorded as a new revision, nothing is lost.
  router.add('POST', '/api/v1/signs/:ref/revert', async (ctx) => {
    const user = requireUser(ctx, 'moderator');
    const body = await readJson(ctx);
    const version = expectVersion(body.version);
    const target = expectVersion(body.to_version);
    const comment = cleanComment(body.comment) || `Revert to version ${target}`;
    const ts = now();
    transaction(ctx.db, () => {
      const row = loadRow(ctx.db, ctx.params.ref);
      if (row.version !== version) throw conflict(row);
      const rev = ctx.db.prepare('SELECT data FROM revisions WHERE reference=? AND version=?').get(row.reference, target);
      if (!rev || rev.data == null) throw new ApiError(404, 'not_found', 'This revision has no content to revert to.');
      const entry = checkedEntry(JSON.parse(rev.data));
      storeSign(ctx.db, entry, { version: version + 1, userId: user.id, ts, insert: false });
      ctx.images.learnEntry(entry);
      addRevision(ctx.db, { reference: row.reference, version: version + 1, action: 'revert', entry, comment, userId: user.id, ts });
    });
    send(ctx, 200, fullSign(ctx, loadRow(ctx.db, ctx.params.ref)));
  });

  // Dry-run validation, used by the editor before saving.
  router.add('POST', '/api/v1/validate', async (ctx) => {
    const body = await readJson(ctx);
    const entry = normalizeEntry(structuredClone(body.data ?? null) ?? {});
    const errors = validateEntry(entry);
    send(ctx, 200, { valid: errors.length === 0, errors, normalized: errors.length ? undefined : entry });
  });

  // Recent changes feed.
  router.add('GET', '/api/v1/changes', (ctx) => {
    const page = intParam(ctx, 'page', 1, 1, 100000);
    const perPage = intParam(ctx, 'per_page', 50, 1, 200);
    const userId = ctx.query.get('user');
    const where = ["r.action <> 'import'"];
    const args = [];
    if (userId) {
      where.push('r.user_id=?');
      args.push(Number(userId));
    }
    const rows = ctx.db.prepare(
      `SELECT r.reference, r.version, r.action, r.comment, r.created_at, r.user_id, u.display_name FROM revisions r
       LEFT JOIN users u ON u.id = r.user_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    ).all(...args, perPage, (page - 1) * perPage);
    send(ctx, 200, {
      page, per_page: perPage,
      items: rows.map((r) => ({
        reference: r.reference, version: r.version, action: r.action, comment: r.comment, created_at: r.created_at,
        user: r.user_id == null ? null : { id: r.user_id, display_name: r.display_name },
      })),
    });
  });

  // Autocomplete for national codes and Vienna references (used for panels / panonceaux).
  router.add('GET', '/api/v1/codes', (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim().slice(0, 100);
    if (q.length < 1) return send(ctx, 200, { items: [] });
    const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const codes = ctx.db.prepare(
      `SELECT c.code AS value, c.reference, s.data FROM sign_codes c JOIN signs s ON s.reference=c.reference
       WHERE s.deleted=0 AND c.code LIKE ? ESCAPE '\\' GROUP BY c.code ORDER BY length(c.code), c.code LIMIT 20`,
    ).all(like);
    const refs = ctx.db.prepare(
      `SELECT reference AS value, reference, data FROM signs WHERE deleted=0 AND reference LIKE ? ESCAPE '\\' ORDER BY sort_key LIMIT 20`,
    ).all(like);
    const items = [...refs, ...codes].slice(0, 30).map((r) => {
      const d = JSON.parse(r.data);
      return { value: r.value, reference: r.reference, category: d.category, name: d.name?.en ?? Object.values(d.name ?? {})[0] ?? '' };
    });
    send(ctx, 200, { items });
  });

  // Full export in the full_database.json format (deleted signs excluded).
  router.add('GET', '/api/v1/export', (ctx) => {
    const { res } = ctx;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="full_database.json"');
    res.setHeader('Cache-Control', 'no-store');
    if (ctx.req.method === 'HEAD') return res.end();
    const iter = ctx.db.prepare('SELECT data FROM signs WHERE deleted=0 ORDER BY position').iterate();
    res.write('[\n');
    let first = true;
    for (const { data } of iter) {
      res.write(`${first ? '' : ',\n'}${data}`);
      first = false;
    }
    res.end('\n]\n');
  });
}
