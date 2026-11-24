// Runtime configuration, read from environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEBSITE_DIR = path.resolve(here, '..');
export const REPO_DIR = path.resolve(WEBSITE_DIR, '..');

const env = process.env;
const bool = (v, d) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(overrides = {}) {
  const dev = (env.PANOMATIX_ENV || 'production') === 'development';
  return {
    dev,
    host: env.PANOMATIX_HOST || '127.0.0.1',
    port: int(env.PANOMATIX_PORT, 8080),
    database: env.PANOMATIX_DB || path.join(WEBSITE_DIR, 'data', 'panomatix.sqlite3'),
    imagesDir: env.PANOMATIX_IMAGES_DIR || path.join(REPO_DIR, 'road_sign_images'),
    viennaImagesDir: env.PANOMATIX_VIENNA_IMAGES_DIR || path.join(REPO_DIR, 'vienna_convention_images'),
    publicDir: path.join(WEBSITE_DIR, 'public'),
    // Secure cookies need HTTPS; only development may turn them off.
    cookieSecure: bool(env.PANOMATIX_COOKIE_SECURE, !dev),
    // Behind a reverse proxy (nginx, Caddy…) trust X-Forwarded-For for the client IP.
    trustProxy: bool(env.PANOMATIX_TRUST_PROXY, false),
    registrationOpen: bool(env.PANOMATIX_REGISTRATION_OPEN, true),
    sessionDays: int(env.PANOMATIX_SESSION_DAYS, 30),
    tokenDays: int(env.PANOMATIX_TOKEN_DAYS, 90),
    maxJsonBytes: 2 * 1024 * 1024,
    maxImageBytes: int(env.PANOMATIX_MAX_IMAGE_BYTES, 5 * 1024 * 1024),
    loginLimit: int(env.PANOMATIX_LOGIN_LIMIT, 10), // per email per 15 min (x3 per IP)
    registerLimit: int(env.PANOMATIX_REGISTER_LIMIT, 5), // per IP per hour
    uploadLimit: int(env.PANOMATIX_UPLOAD_LIMIT, 60), // per user per hour
    editLimit: int(env.PANOMATIX_EDIT_LIMIT, 300), // per user per hour
    ...overrides,
  };
}
