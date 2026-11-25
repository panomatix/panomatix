// Minimal HTTP toolkit on node:http — router, body parsing, cookies, static files, security headers.
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './security.js';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export const APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    // "/api/v1/signs/:ref/revisions/:version" -> regex with named groups
    const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    this.routes.push({ method, rx, handler });
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.rx.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) {
        const params = {};
        for (const [k, v] of Object.entries(m.groups ?? {})) {
          try {
            params[k] = decodeURIComponent(v);
          } catch {
            throw new ApiError(400, 'bad_path', 'Malformed URL.');
          }
        }
        return { handler: r.handler, params };
      }
    }
    if (pathMatched) throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = true, sameSite = 'Lax', path: p = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export function readBody(ctx, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(ctx.req.headers['content-length'] ?? 0);
    if (declared > limit) {
      reject(new ApiError(413, 'payload_too_large', 'The request body is too large.'));
      ctx.req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    ctx.req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'payload_too_large', 'The request body is too large.'));
        ctx.req.destroy();
        return;
      }
      chunks.push(c);
    });
    ctx.req.on('end', () => resolve(Buffer.concat(chunks)));
    ctx.req.on('error', reject);
  });
}

/** Reads a JSON object body. Requiring application/json also blocks cross-site HTML form posts. */
export async function readJson(ctx) {
  const type = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError(415, 'unsupported_media_type', 'Send the request body as application/json.');
  const raw = await readBody(ctx, ctx.config.maxJsonBytes);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || 'null');
  } catch {
    throw new ApiError(400, 'bad_json', 'The request body is not valid JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'bad_json', 'The request body must be a JSON object.');
  return body;
}

/** Minimal multipart/form-data parser: returns {fields, files: {name: {filename, data}}}. */
export async function readMultipart(ctx, limit) {
  const ct = String(ctx.req.headers['content-type'] ?? '');
  const m = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) throw new ApiError(415, 'unsupported_media_type', 'Send the file as multipart/form-data.');
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const raw = await readBody(ctx, limit);
  const fields = {};
  const files = {};
  let pos = raw.indexOf(boundary);
  while (pos !== -1) {
    pos += boundary.length;
    if (raw.slice(pos, pos + 2).toString() === '--') break;
    pos += 2; // CRLF
    const headerEnd = raw.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = raw.slice(pos, headerEnd).toString('utf8');
    const next = raw.indexOf(boundary, headerEnd);
    if (next === -1) break;
    const data = raw.slice(headerEnd + 4, next - 2); // strip trailing CRLF
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (name) {
      if (filename !== undefined) files[name] = { filename, data };
      else fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

export function send(ctx, status, body, headers = {}) {
  const { res } = ctx;
  if (res.headersSent) return;
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.statusCode = status;
  if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(ctx.req.method === 'HEAD' ? undefined : payload);
}

export function sendError(ctx, err) {
  if (err instanceof ApiError) {
    return send(ctx, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
  }
  console.error(new Date().toISOString(), ctx.req.method, ctx.req.url, err);
  return send(ctx, 500, { error: { code: 'internal_error', message: 'Unexpected server error.' } });
}

/** Serve a file from `root` without ever leaving it. Returns false when not found. */
export function serveFile(ctx, root, rel, { headers = {}, maxAge = 0 } = {}) {
  const base = path.resolve(root);
  const target = path.resolve(base, `.${path.sep}${rel}`);
  if (target !== base && !target.startsWith(base + path.sep)) return false;
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const { res } = ctx;
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  res.setHeader('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-cache');
  res.setHeader('Last-Modified', st.mtime.toUTCString());
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (ctx.req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
  return true;
}
