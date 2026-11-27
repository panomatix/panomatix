// SQLite storage (node:sqlite): one row per sign holding its JSON document, plus full revision history.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,              -- '' until the owner sets a password from the emailed link
  role          TEXT NOT NULL DEFAULT 'contributor' CHECK (role IN ('contributor','moderator','admin')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  email_verified_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('cookie','token')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- One-use links sent by email: account confirmation ('verify') and password reset ('reset').
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id);

CREATE TABLE IF NOT EXISTS signs (
  reference   TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  data        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  sort_key    TEXT NOT NULL,
  search_text TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS signs_category ON signs(category, sort_key);
CREATE INDEX IF NOT EXISTS signs_sort ON signs(sort_key);
CREATE INDEX IF NOT EXISTS signs_position ON signs(position);

CREATE TABLE IF NOT EXISTS sign_codes (
  reference    TEXT NOT NULL REFERENCES signs(reference) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  code         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sign_codes_ref ON sign_codes(reference);
CREATE INDEX IF NOT EXISTS sign_codes_country ON sign_codes(country_code, reference);
CREATE INDEX IF NOT EXISTS sign_codes_jur ON sign_codes(jurisdiction, reference);
CREATE INDEX IF NOT EXISTS sign_codes_code ON sign_codes(code);

CREATE TABLE IF NOT EXISTS revisions (
  id         INTEGER PRIMARY KEY,
  reference  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('import','create','update','delete','restore','revert')),
  data       TEXT,
  comment    TEXT NOT NULL DEFAULT '',
  user_id    INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (reference, version)
);
CREATE INDEX IF NOT EXISTS revisions_recent ON revisions(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS revisions_user ON revisions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS images (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  country_code TEXT NOT NULL,
  code         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   INTEGER NOT NULL
);

-- One row per backup run (see backup.js); the high-water marks say where the next one starts.
CREATE TABLE IF NOT EXISTS backups (
  id               INTEGER PRIMARY KEY,
  file             TEXT,              -- NULL when nothing had changed
  created_at       INTEGER NOT NULL,
  last_revision_id INTEGER NOT NULL,
  last_image_id    INTEGER NOT NULL,
  last_user_id     INTEGER NOT NULL,
  revisions        INTEGER NOT NULL DEFAULT 0,
  images           INTEGER NOT NULL DEFAULT 0,
  users            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_events (
  bucket TEXT NOT NULL,
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_bucket ON rate_events(bucket, ts);
`;

export const now = () => Math.floor(Date.now() / 1000);

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

/** Bring a database created by an older version up to the current schema. */
function migrate(db) {
  const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!userCols.has('email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
    // Accounts created before email confirmation existed are trusted as they are.
    db.exec('UPDATE users SET email_verified_at = created_at');
  }
}

/** Run fn inside a write transaction. node:sqlite is synchronous, so the whole
 *  read-check-write sequence runs without interleaving with other requests. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- derived columns ----------------------------------------------------------

export function sortKey(reference) {
  const i = reference.indexOf(':');
  const prefix = reference.slice(0, i);
  const rest = reference.slice(i + 1).toLowerCase();
  const rank = { VIENNA: '0', VIENNA2006: '1', OTHER: '2' }[prefix] ?? '9';
  return rank + rest.replace(/\d+/g, (d) => d.padStart(8, '0'));
}

/** Every (countryCode, jurisdiction key, national code) of the official designs. */
export function* iterCodes(entry) {
  const seen = new Set();
  for (const design of entry?.officialSign?.designs ?? []) {
    for (const [jk, jur] of Object.entries(design.jurisdictions ?? {})) {
      for (const lang of Object.values(jur.languages ?? {})) {
        for (const code of lang.codes ?? []) {
          const key = `${jur.countryCode}\u0000${jk}\u0000${code}`;
          if (!seen.has(key)) {
            seen.add(key);
            yield [jur.countryCode, jk, code];
          }
        }
      }
    }
  }
}

export function searchText(entry) {
  const parts = [entry.reference, entry.category, ...Object.values(entry.name ?? {})];
  for (const [, , code] of iterCodes(entry)) parts.push(code);
  for (const design of entry?.officialSign?.designs ?? []) {
    for (const jur of Object.values(design.jurisdictions ?? {})) {
      for (const lang of Object.values(jur.languages ?? {})) if (lang.text) parts.push(lang.text);
    }
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function storeSign(db, entry, { version, userId, ts, deleted = false, insert }) {
  const ref = entry.reference;
  const data = JSON.stringify(entry);
  if (insert) {
    db.prepare(
      `INSERT INTO signs (reference, category, data, version, deleted, sort_key, search_text, created_at, updated_at, updated_by, position)
       VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position), 0) + 1 FROM signs))`,
    ).run(ref, entry.category, data, version, deleted ? 1 : 0, sortKey(ref), searchText(entry), ts, ts, userId ?? null);
  } else {
    db.prepare(
      `UPDATE signs SET category=?, data=?, version=?, deleted=?, sort_key=?, search_text=?, updated_at=?, updated_by=?
       WHERE reference=?`,
    ).run(entry.category, data, version, deleted ? 1 : 0, sortKey(ref), searchText(entry), ts, userId ?? null, ref);
  }
  db.prepare('DELETE FROM sign_codes WHERE reference=?').run(ref);
  if (!deleted) {
    const ins = db.prepare('INSERT INTO sign_codes (reference, country_code, jurisdiction, code) VALUES (?,?,?,?)');
    for (const [cc, jk, code] of iterCodes(entry)) ins.run(ref, cc, jk, code);
  }
}

export function addRevision(db, { reference, version, action, entry, comment = '', userId = null, ts }) {
  db.prepare(
    'INSERT INTO revisions (reference, version, action, data, comment, user_id, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(reference, version, action, entry == null ? null : JSON.stringify(entry), comment, userId, ts);
}
