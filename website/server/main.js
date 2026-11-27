// Entry point: `npm start`.
import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { backupIfDue } from './backup.js';

const config = loadConfig();
const db = openDatabase(config.database);
const { count } = db.prepare('SELECT COUNT(*) AS count FROM signs').get();
if (count === 0) console.warn('The database is empty. Load the signs first: npm run import');

const app = createApp({ config, db });
const server = http.createServer({ headersTimeout: 20_000, requestTimeout: 60_000 }, app.handle);
server.keepAliveTimeout = 5_000;

// Housekeeping every hour: expired sessions and links, old rate-limit events, sign-ups whose link
// was never opened within a week, and the weekly backup of the changes.
const purge = () => {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(ts);
  db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').run(ts);
  db.prepare("DELETE FROM users WHERE password_hash = '' AND email_verified_at IS NULL AND created_at < ?").run(ts - 7 * 86400);
  db.prepare('DELETE FROM rate_events WHERE ts < ?').run(ts - 86400);
  try {
    const b = backupIfDue(db, config);
    if (b?.file) console.log(`Backup written: ${b.file} (${b.revisions} revisions, ${b.images} images, ${b.users} accounts)`);
  } catch (err) {
    console.error('Backup failed:', err);
  }
};
purge();
setInterval(purge, 3_600_000).unref();

server.listen(config.port, config.host, () => {
  console.log(`Panomatix running on http://${config.host}:${config.port} (${count} signs, ${config.dev ? 'development' : 'production'} mode)`);
  if (!config.smtpUrl) console.warn('PANOMATIX_SMTP_URL is not set: account and password emails are printed here instead of being sent.');
  if (!config.cookieSecure) console.warn('Session cookies are not marked Secure: use this only for local development over plain HTTP.');
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
