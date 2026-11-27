// Incremental backups: each file holds only what changed since the previous backup — new revisions of
// the signs (full snapshots), uploaded images (with their bytes) and the accounts involved (without
// passwords). Together with full_database.json from git, replaying them in order rebuilds the content:
//   npm run import -- --replace && npm run restore -- backups/*.json.gz
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { now, storeSign, transaction } from './db.js';

const FORMAT = 'panomatix-changes';

const USER_COLS = 'id, email, display_name, role, is_active, created_at, email_verified_at';

/** Write a backup of everything since the previous one. Returns {file, revisions, images, users};
 *  file is null when nothing changed (the run is still recorded, so the next one starts from here). */
export function runBackup(db, config) {
  const last = db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get()
    ?? { last_revision_id: 0, last_image_id: 0, last_user_id: 0 };
  const top = {
    revision: db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM revisions').get().n,
    image: db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM images').get().n,
    user: db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM users').get().n,
  };
  // Imports come from full_database.json, which git already keeps.
  const revisions = db.prepare(
    "SELECT * FROM revisions WHERE id > ? AND id <= ? AND action <> 'import' ORDER BY id",
  ).all(last.last_revision_id, top.revision).map((r) => ({ ...r, data: r.data == null ? null : JSON.parse(r.data) }));
  const images = [];
  for (const im of db.prepare('SELECT * FROM images WHERE id > ? AND id <= ? ORDER BY id').all(last.last_image_id, top.image)) {
    const file = path.join(config.imagesDir, im.path);
    if (fs.existsSync(file)) images.push({ ...im, data: fs.readFileSync(file).toString('base64') });
  }
  const authorIds = new Set([...revisions.map((r) => r.user_id), ...images.map((i) => i.uploaded_by)].filter((x) => x != null));
  const users = db.prepare(`SELECT ${USER_COLS} FROM users WHERE password_hash <> '' AND (id > ? AND id <= ? OR id IN (SELECT value FROM json_each(?)))`)
    .all(last.last_user_id, top.user, JSON.stringify([...authorIds]));

  const ts = now();
  let file = null;
  if (revisions.length || images.length || users.length) {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const stamp = new Date(ts * 1000).toISOString().replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z');
    // The revision number keeps two backups of the same second apart and in order.
    file = path.join(config.backupDir, `panomatix-changes-${stamp}-r${String(top.revision).padStart(10, '0')}.json.gz`);
    const payload = { format: FORMAT, version: 1, created_at: ts, since: last.created_at ?? null, revisions, images, users };
    fs.writeFileSync(`${file}.tmp`, zlib.gzipSync(JSON.stringify(payload), { level: 9 }));
    fs.renameSync(`${file}.tmp`, file);
  }
  db.prepare('INSERT INTO backups (file, created_at, last_revision_id, last_image_id, last_user_id, revisions, images, users) VALUES (?,?,?,?,?,?,?,?)')
    .run(file && path.basename(file), ts, top.revision, top.image, top.user, revisions.length, images.length, users.length);
  return { file, revisions: revisions.length, images: images.length, users: users.length };
}

/** Back up if the last backup is older than config.backupDays (called hourly by the server). */
export function backupIfDue(db, config) {
  if (!config.backupDays) return null;
  const last = db.prepare('SELECT created_at FROM backups ORDER BY id DESC LIMIT 1').get();
  if (last && last.created_at > now() - config.backupDays * 86400) return null;
  return runBackup(db, config);
}

/** Replay backup files (oldest first) into the database. Revisions already present are skipped, so
 *  replaying a file twice is harmless. Accounts come back without a password: their owners use
 *  "Forgot your password?". */
export function restoreBackups(db, config, files) {
  const totals = { revisions: 0, images: 0, users: 0 };
  for (const file of [...files].sort()) {
    const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    if (payload.format !== FORMAT) throw new Error(`${file} is not a Panomatix backup.`);
    transaction(db, () => {
      const userId = new Map(); // id in the backup -> id here
      for (const u of payload.users) {
        let row = db.prepare('SELECT id FROM users WHERE email=?').get(u.email);
        if (!row) {
          db.prepare('INSERT INTO users (email, display_name, password_hash, role, is_active, created_at, email_verified_at) VALUES (?,?,?,?,?,?,?)')
            .run(u.email, u.display_name, '', u.role, u.is_active, u.created_at, u.email_verified_at ?? u.created_at);
          row = db.prepare('SELECT id FROM users WHERE email=?').get(u.email);
          totals.users += 1;
        }
        userId.set(u.id, row.id);
      }
      const author = (id) => (id == null ? null : userId.get(id) ?? null);
      for (const r of payload.revisions) {
        const added = db.prepare(
          'INSERT OR IGNORE INTO revisions (reference, version, action, data, comment, user_id, created_at) VALUES (?,?,?,?,?,?,?)',
        ).run(r.reference, r.version, r.action, r.data == null ? null : JSON.stringify(r.data), r.comment, author(r.user_id), r.created_at);
        if (!added.changes) continue;
        totals.revisions += 1;
        const cur = db.prepare('SELECT version, data FROM signs WHERE reference=?').get(r.reference);
        if (cur && cur.version >= r.version) continue; // the database already holds a newer state
        const entry = r.data ?? (cur && JSON.parse(cur.data));
        if (!entry) continue;
        storeSign(db, entry, { version: r.version, userId: author(r.user_id), ts: r.created_at, deleted: r.action === 'delete', insert: !cur });
      }
      for (const im of payload.images) {
        const target = path.resolve(config.imagesDir, im.path);
        if (!target.startsWith(path.resolve(config.imagesDir) + path.sep)) continue;
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, Buffer.from(im.data, 'base64'));
        }
        const added = db.prepare('INSERT OR IGNORE INTO images (path, country_code, code, sha256, uploaded_by, created_at) VALUES (?,?,?,?,?,?)')
          .run(im.path, im.country_code, im.code, im.sha256, author(im.uploaded_by), im.created_at);
        totals.images += added.changes;
      }
    });
    console.log(`Restored ${path.basename(file)}`);
  }
  return totals;
}
