// Application assembly: request context, routing, static front-end, error handling.
import path from 'node:path';
import { APP_CSP, Router, baseHeaders, parseCookies, send, sendError, serveFile } from './http.js';
import { ImageIndex, ViennaIndex, registerImageRoutes, registerViennaMediaRoute } from './images.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCompareRoutes } from './routes/compare.js';
import { registerCountryRoutes } from './routes/countries.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerSignRoutes } from './routes/signs.js';
import { registerUnitRoutes } from './routes/units.js';
import { ApiError, authenticate, enforceCsrf } from './security.js';

export function knownCountryCodes(db) {
  return new Set(db.prepare('SELECT DISTINCT country_code AS c FROM sign_codes').all().map((r) => r.c));
}

export function createApp({ config, db }) {
  const images = new ImageIndex(config.imagesDir, knownCountryCodes(db));
  for (const { data } of db.prepare('SELECT data FROM signs WHERE deleted=0').iterate()) images.learnEntry(JSON.parse(data));
  const vienna = new ViennaIndex(config.viennaImagesDir);
  const router = new Router();
  registerAuthRoutes(router);
  registerSignRoutes(router);
  registerMetaRoutes(router);
  registerCompareRoutes(router);
  registerCountryRoutes(router);
  registerUnitRoutes(router);
  registerImageRoutes(router);
  registerViennaMediaRoute(router);

  async function handle(req, res) {
    baseHeaders(res);
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const url = new URL(req.url, 'http://localhost');
    const fwd = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const ctx = {
      req, res, config, db, images, vienna, url,
      query: url.searchParams,
      params: {},
      cookies: parseCookies(req.headers.cookie),
      ip: fwd || req.socket.remoteAddress || '?',
      user: null,
    };
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/vienna-media/')) {
        const m = router.match(req.method, url.pathname);
        if (!m) throw new ApiError(404, 'not_found', 'Unknown endpoint.');
        ctx.params = m.params;
        authenticate(ctx);
        enforceCsrf(ctx);
        await m.handler(ctx);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
      // Front-end: static files, and index.html for every client-side route.
      res.setHeader('Content-Security-Policy', APP_CSP);
      let rel;
      try {
        rel = decodeURIComponent(url.pathname);
      } catch {
        throw new ApiError(400, 'bad_path', 'Malformed URL.');
      }
      if (rel.includes('\0')) throw new ApiError(400, 'bad_path', 'Malformed URL.');
      if (rel !== '/' && path.extname(rel) && serveFile(ctx, config.publicDir, rel)) return;
      if (path.extname(rel) && rel !== '/') throw new ApiError(404, 'not_found', 'Not found.');
      if (!serveFile(ctx, config.publicDir, 'index.html')) throw new ApiError(404, 'not_found', 'Front-end missing.');
    } catch (err) {
      sendError(ctx, err);
    }
  }

  return { handle, images, vienna, router };
}

export { send };
