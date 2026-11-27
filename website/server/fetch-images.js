// Fills in the pictures of national signs that have none, from the Wikimedia Commons link the database
// keeps for them (jurisdiction.sources[].url, upload.wikimedia.org only). Each file goes through the same
// checks and compression as a contributor's upload and is filed the same way (see storeImage).
//
// Polite to Wikimedia: one request at a time, a pause between them, an identifying User-Agent, and a
// stop when asked to slow down (HTTP 429). Every attempt is recorded (image_fetches), so a missing or
// refused file is retried only after config.imageFetchRetryDays.
import { now } from './db.js';
import { ApiError } from './security.js';
import { storeImage } from './images.js';

const COMMONS_HOST = 'upload.wikimedia.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isCommons = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.host === COMMONS_HOST;
  } catch {
    return false;
  }
};

/** Commons' PNG rendering of an SVG file (used when the SVG itself is refused, e.g. it declares entities). */
function pngRendering(url) {
  const m = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+\.svg)$/i.exec(url);
  return m ? `https://upload.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${m[2]}/${m[3]}/1024px-${m[3]}.png` : null;
}

class SlowDown extends Error {}

async function download(url, config) {
  const res = await fetch(url, {
    headers: { 'User-Agent': `Panomatix/1.0 (+${config.publicUrl}; fills in missing road sign pictures)`, Accept: 'image/*' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429 || res.status === 503) throw new SlowDown(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.redirected && new URL(res.url).host !== COMMONS_HOST) throw new Error('redirected away from Wikimedia');
  if (Number(res.headers.get('content-length') ?? 0) > config.maxImageBytes) throw new Error('file too large');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > config.maxImageBytes) throw new Error('file too large');
  return data;
}

/** National signs without a picture but with a Commons link: [{code, url, sign}], one per code. */
export function missingImages(db, images) {
  const out = new Map();
  for (const { reference, category, data } of db.prepare('SELECT reference, category, data FROM signs WHERE deleted=0 ORDER BY sort_key').all()) {
    const entry = JSON.parse(data);
    for (const part of [...(entry.officialSign?.designs ?? []), ...(entry.relatedSigns ?? [])]) {
      for (const [jurisdiction, jur] of Object.entries(part.jurisdictions ?? {})) {
        const langs = Object.values(jur.languages ?? {});
        const codes = [...new Set(langs.flatMap((l) => l.codes ?? []))];
        if (!codes.length || codes.some((c) => images.lookup(c).length)) continue;
        const url = (jur.sources ?? []).map((s) => s.url).find(isCommons);
        const code = langs.find((l) => l.code)?.code ?? codes[0];
        if (url && !out.has(code)) out.set(code, { code, url, sign: { reference, category, jurisdiction } });
      }
    }
  }
  return [...out.values()];
}

let running = false;

/** Download up to `limit` missing pictures. Returns {done, failed, left, stopped}. */
export async function fetchMissingImages({ db, images, config }, { limit = Infinity, log = () => {} } = {}) {
  if (running) return { done: 0, failed: 0, left: null, stopped: 'already running' };
  running = true;
  const result = { done: 0, failed: 0, left: 0, stopped: null };
  try {
    const retryAfter = now() - config.imageFetchRetryDays * 86400;
    const tried = db.prepare('SELECT tried_at FROM image_fetches WHERE code=?');
    const todo = missingImages(db, images).filter(({ code }) => !(tried.get(code)?.tried_at > retryAfter));
    const record = db.prepare(`INSERT INTO image_fetches (code, url, status, message, tried_at) VALUES (?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET url=excluded.url, status=excluded.status, message=excluded.message, tried_at=excluded.tried_at`);
    for (const [n, item] of todo.entries()) {
      if (result.done + result.failed >= limit) break;
      if (n) await sleep(config.imageFetchPauseMs);
      try {
        let raw = await download(item.url, config);
        let stored;
        try {
          stored = await storeImage({ db, images }, { code: item.code, raw, sign: item.sign });
        } catch (err) {
          const png = err instanceof ApiError && err.code === 'unsafe_svg' && pngRendering(item.url);
          if (!png) throw err;
          await sleep(config.imageFetchPauseMs);
          raw = await download(png, config); // Commons' own PNG rendering of the refused SVG
          stored = await storeImage({ db, images }, { code: item.code, raw, sign: item.sign });
        }
        record.run(item.code, item.url, 'ok', stored.rel, now());
        result.done += 1;
        log(`✓ ${item.code} → ${stored.rel}`);
      } catch (err) {
        if (err instanceof SlowDown) {
          result.stopped = `Wikimedia asked to slow down (${err.message}); the rest waits for the next run`;
          break;
        }
        record.run(item.code, item.url, 'failed', String(err.message).slice(0, 200), now());
        result.failed += 1;
        log(`✗ ${item.code}: ${err.message}`);
      }
    }
    result.left = todo.length - result.done - result.failed;
    return result;
  } finally {
    running = false;
  }
}

/** Run when the last run is older than config.imageFetchHours (called hourly by the server). */
export async function fetchImagesIfDue(ctx) {
  const { db, config } = ctx;
  if (!config.imageFetchHours) return null;
  const last = db.prepare("SELECT last_run_at FROM jobs WHERE name='fetch-images'").get();
  if (last && last.last_run_at > now() - config.imageFetchHours * 3600) return null;
  db.prepare("INSERT INTO jobs (name, last_run_at) VALUES ('fetch-images', ?) ON CONFLICT(name) DO UPDATE SET last_run_at=excluded.last_run_at").run(now());
  return fetchMissingImages(ctx, { limit: config.imageFetchLimit });
}
