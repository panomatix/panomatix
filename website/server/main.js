// Entry point: `npm start`.
import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

const config = loadConfig();
const db = openDatabase(config.database);
const { count } = db.prepare('SELECT COUNT(*) AS count FROM signs').get();
if (count === 0) console.warn('The database is empty. Load the signs first: npm run import');

const app = createApp({ config, db });
const server = http.createServer({ headersTimeout: 20_000, requestTimeout: 60_000 }, app.handle);
server.keepAliveTimeout = 5_000;

// Housekeeping: purge expired sessions and old rate-limit events every hour.
const purge = () => {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(ts);
  db.prepare('DELETE FROM rate_events WHERE ts < ?').run(ts - 86400);
};
purge();
setInterval(purge, 3_600_000).unref();

server.listen(config.port, config.host, () => {
  console.log(`Panomatix running on http://${config.host}:${config.port} (${count} signs, ${config.dev ? 'development' : 'production'} mode)`);
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
