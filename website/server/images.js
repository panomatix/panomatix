// Sign images: lookup by national code, secure serving and contributor uploads.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { iterCodes, now } from './db.js';
import { readMultipart, send, serveFile } from './http.js';
import { ApiError, rateLimit, requireUser } from './security.js';

export const IMAGE_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
export const CATEGORY_DIRS = {
  A: 'a_danger_warning_signs', B: 'b_priority_signs', C: 'c_prohibitory_and_restrictive_signs',
  D: 'd_mandatory_signs', E: 'e_special_regulation_signs', F: 'f_information_facilities_or_service_signs',
  G: 'g_other_information_signs', H: 'h_additional_panels', S: 's_road_numbers', SD: 'sd_unclassified',
};
const CODE_RE = /^[a-z]{2}(-[a-z0-9]{1,3})?:\S{1,300}$/;
// SVG is a document format: refuse anything that could run code or load external resources.
const UNSAFE_SVG = /<\s*script|<\s*foreignObject|\son[a-z]+\s*=|javascript:|<!ENTITY|<!DOCTYPE|\b(?:xlink:)?href\s*=\s*["']?\s*(?!#)|@import|url\(\s*["']?\s*(?!#)/i;
const MEDIA_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

export const norm = (code) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
export const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** In-memory map (country code, normalised national code) -> image paths (relative to imagesDir).
 *  Files are named "<CC>-<code>.<ext>", or "<CC>-<RR>-<code>.<ext>" for a regional code (CA-NB-3106.svg). */
export class ImageIndex {
  constructor(root, knownCountries) {
    this.root = path.resolve(root);
    this.known = knownCountries; // Set of country codes used in the database, e.g. "fr", "ca-nb"
    this.build();
  }

  split(stem) {
    const m = /^([A-Z]{2})-(.+)$/.exec(stem);
    if (!m) return null;
    const cc = m[1].toLowerCase();
    const sub = /^([A-Z]{2,3})-(.+)$/.exec(m[2]);
    if (sub && this.known.has(`${cc}-${sub[1].toLowerCase()}`)) return [`${cc}-${sub[1].toLowerCase()}`, sub[2]];
    return [cc, m[2]];
  }

  add(rel) {
    const parts = this.split(path.basename(rel, path.extname(rel)));
    if (!parts) return;
    const [cc, code] = parts;
    const push = (map, key) => (map.get(key) ?? map.set(key, []).get(key)).push(rel);
    push(this.exact, `${cc}|${norm(code)}`);
    for (const loose of new Set([code.replace(/_v\d+$/, ''), code.split('_')[0]])) {
      if (norm(loose) !== norm(code)) push(this.loose, `${cc}|${norm(loose)}`);
    }
    if (!this.countryDirs.has(cc)) this.countryDirs.set(cc, rel.split('/')[0]);
    (this.byFile.get(path.basename(rel)) ?? this.byFile.set(path.basename(rel), []).get(path.basename(rel))).push(rel);
  }

  /** When a code's file name differs from the code (e.g. ar:P-7_left -> AR-P-7_left_MSV_2017_a.svg),
   *  the entry's `sources[].file` still names the picture: remember it as an alias of the code. */
  learnEntry(entry) {
    const visit = (jur) => {
      const files = (jur.sources ?? []).flatMap((s) => this.byFile.get(path.basename(s.file ?? '')) ?? []);
      if (!files.length) return;
      for (const lang of Object.values(jur.languages ?? {})) {
        for (const code of lang.codes ?? []) {
          if (!this.lookupByName(code).length) this.aliases.set(code, files);
        }
      }
    };
    for (const d of entry?.officialSign?.designs ?? []) for (const j of Object.values(d.jurisdictions ?? {})) visit(j);
    for (const r of entry?.relatedSigns ?? []) for (const j of Object.values(r.jurisdictions ?? {})) visit(j);
  }

  build() {
    this.exact = new Map();
    this.loose = new Map();
    this.countryDirs = new Map();
    this.byFile = new Map();
    this.aliases = new Map();
    if (!fs.existsSync(this.root)) return;
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (IMAGE_EXT.has(path.extname(d.name).toLowerCase())) this.add(path.relative(this.root, full).split(path.sep).join('/'));
      }
    };
    walk(this.root);
  }

  /** national code such as "fr:B14" or "ca-nb:3106" */
  lookup(nationalCode) {
    const byName = this.lookupByName(nationalCode);
    return byName.length ? byName : [...(this.aliases.get(nationalCode) ?? [])];
  }

  lookupByName(nationalCode) {
    const i = nationalCode.indexOf(':');
    const cc = nationalCode.slice(0, i);
    const key = norm(nationalCode.slice(i + 1));
    const ccs = [...new Set([cc, cc.split('-')[0]])];
    for (const map of [this.exact, this.loose]) {
      for (const c of ccs) {
        const hit = map.get(`${c}|${key}`);
        if (hit) return [...hit];
      }
    }
    return [];
  }
}

export const mediaUrl = (rel) => `/media/${rel.split('/').map(encodeURIComponent).join('/')}`;

/** {national code: [urls]} for every code of an entry (official designs and related signs). */
export function imagesForEntry(index, entry) {
  const out = {};
  const codes = [...iterCodes(entry)].map(([, , c]) => c);
  for (const rel of entry.relatedSigns ?? []) {
    for (const jur of Object.values(rel.jurisdictions ?? {})) {
      for (const lang of Object.values(jur.languages ?? {})) codes.push(...(lang.codes ?? []));
    }
  }
  for (const code of codes) {
    if (out[code]) continue;
    const hits = index.lookup(code);
    if (hits.length) out[code] = hits.map(mediaUrl);
  }
  return out;
}

function sniff(data) {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
  const h6 = data.subarray(0, 6).toString('latin1');
  if (h6 === 'GIF87a' || h6 === 'GIF89a') return '.gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  const head = data.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if ((head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--')) && head.includes('<svg')) return '.svg';
  return null;
}

export function registerImageRoutes(router) {
  router.add('GET', '/media/(?<rel>.+)', (ctx) => {
    const rel = ctx.params.rel; // already URL-decoded by the router
    if (!IMAGE_EXT.has(path.extname(rel).toLowerCase()) || rel.includes('\0')) throw new ApiError(404, 'not_found', 'Not found.');
    const ok = serveFile(ctx, ctx.config.imagesDir, rel, { maxAge: 86400, headers: { 'Content-Security-Policy': MEDIA_CSP } });
    if (!ok) throw new ApiError(404, 'not_found', 'Not found.');
  });

  router.add('GET', '/api/v1/images', (ctx) => {
    const code = ctx.query.get('code') ?? '';
    if (!CODE_RE.test(code)) throw new ApiError(400, 'invalid_code', 'Give a national code such as fr:B14.');
    send(ctx, 200, { code, images: ctx.images.lookup(code).map(mediaUrl) });
  });

  // multipart/form-data: file + code (e.g. fr:B14). The image is filed next to the sign that owns the code.
  router.add('POST', '/api/v1/images', async (ctx) => {
    const user = requireUser(ctx);
    rateLimit(ctx.db, `upload:${user.id}`, ctx.config.uploadLimit, 3600);
    const { fields, files } = await readMultipart(ctx, ctx.config.maxImageBytes + 64 * 1024);
    const code = fields.code ?? '';
    if (!CODE_RE.test(code)) throw new ApiError(400, 'invalid_code', 'Give the national code the image shows, such as fr:B14.');
    const file = files.file;
    if (!file || !file.data.length) throw new ApiError(400, 'missing_file', 'Attach an image file.');
    if (file.data.length > ctx.config.maxImageBytes) throw new ApiError(413, 'file_too_large', 'The image is too large.');
    const ext = sniff(file.data);
    if (!ext) throw new ApiError(400, 'unsupported_image', 'Only SVG, PNG, JPEG, GIF and WebP images are accepted.');
    if (ext === '.svg') {
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(file.data);
      } catch {
        throw new ApiError(400, 'unsupported_image', 'SVG files must be UTF-8 encoded.');
      }
      if (UNSAFE_SVG.test(text)) throw new ApiError(400, 'unsafe_svg', 'SVG files may not contain scripts, event handlers, entities, styles imports or external links.');
    }

    const row = ctx.db.prepare(
      `SELECT s.reference, s.category, c.jurisdiction FROM sign_codes c JOIN signs s ON s.reference = c.reference
       WHERE c.code=? AND s.deleted=0 ORDER BY s.sort_key LIMIT 1`,
    ).get(code);
    if (!row) throw new ApiError(404, 'unknown_code', 'No sign in the database uses this national code. Add the code to a sign first.');

    const i = code.indexOf(':');
    const cc = code.slice(0, i);
    const idx = ctx.images;
    const countryDir = idx.countryDirs.get(cc) ?? idx.countryDirs.get(cc.split('-')[0]) ?? slug(`${cc}_${row.jurisdiction}`);
    const catDir = CATEGORY_DIRS[row.category.split('-').at(-1)] ?? 'sd_unclassified';
    const kind = row.reference.startsWith('VIENNA') ? 'vienna' : 'other';
    const safeCode = code.slice(i + 1).replace(/[^A-Za-z0-9.()+-]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 150) || 'sign';
    const prefix = cc.split('-').map((p) => p.toUpperCase()).join('-');
    const folder = path.join(idx.root, countryDir, catDir, kind);
    if (!path.resolve(folder).startsWith(idx.root + path.sep)) throw new ApiError(400, 'invalid_code', 'Invalid code.');
    fs.mkdirSync(folder, { recursive: true });
    let name = `${prefix}-${safeCode}${ext}`;
    for (let n = 2; fs.existsSync(path.join(folder, name)); n += 1) name = `${prefix}-${safeCode}_upload${n}${ext}`;
    const target = path.join(folder, name);
    const tmp = `${target}.part-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(tmp, file.data, { flag: 'wx' });
    fs.renameSync(tmp, target);
    const rel = path.relative(idx.root, target).split(path.sep).join('/');
    ctx.db.prepare('INSERT INTO images (path, country_code, code, sha256, uploaded_by, created_at) VALUES (?,?,?,?,?,?)').run(
      rel, cc, code, crypto.createHash('sha256').update(file.data).digest('hex'), user.id, now(),
    );
    idx.add(rel);
    send(ctx, 201, { path: rel, url: mediaUrl(rel), reference: row.reference });
  });
}

// --- official Vienna Convention illustrations (vienna_convention_images/) -------------------------

/** reference ("VIENNA:A-01.1") -> [{rel, name, variant, url, license, artist, commons}] ; base image first. */
export class ViennaIndex {
  constructor(root) {
    this.root = path.resolve(root);
    this.build();
  }

  build() {
    this.byRef = new Map();
    if (!fs.existsSync(this.root)) return;
    let manifest = [];
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(this.root, 'images_links.json'), 'utf8')).images ?? [];
    } catch { /* manifest written at the end of the download; fall back to the files */ }
    const meta = new Map(manifest.map((m) => [m.file, m]));
    for (const dir of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(this.root, dir.name))) {
        if (path.extname(f).toLowerCase() !== '.svg') continue;
        const rel = `${dir.name}/${f}`;
        const m = /^([A-H]-\d{2}\.\d+)(.*)\.svg$/i.exec(f);
        if (!m) continue;
        const ref = `VIENNA:${m[1]}`;
        const info = meta.get(rel) ?? {};
        const list = this.byRef.get(info.reference ?? ref) ?? [];
        list.push({
          rel, name: f, variant: m[2].replace(/^[-_]/, '') || null,
          url: `/vienna-media/${rel.split('/').map(encodeURIComponent).join('/')}`,
          license: info.license ?? null, artist: info.artist ?? null, commons: info.commons_title ?? null,
        });
        this.byRef.set(info.reference ?? ref, list);
      }
    }
    // base image first, then colour variants (-V1…), then alternative models (-1, -2, -a…)
    const rank = (v) => (v === null ? '0' : /^V\d+$/.test(v) ? `1${v}` : `2${v}`);
    for (const list of this.byRef.values()) list.sort((a, b) => rank(a.variant).localeCompare(rank(b.variant), 'en', { numeric: true }));
  }

  get(reference) {
    return (this.byRef.get(reference) ?? []).map(({ rel, ...rest }) => rest);
  }

  main(reference) {
    return this.byRef.get(reference)?.[0]?.url ?? null;
  }
}

export function registerViennaMediaRoute(router) {
  router.add('GET', '/vienna-media/(?<rel>.+)', (ctx) => {
    const rel = ctx.params.rel;
    if (path.extname(rel).toLowerCase() !== '.svg' || rel.includes('\0')) throw new ApiError(404, 'not_found', 'Not found.');
    const ok = serveFile(ctx, ctx.config.viennaImagesDir, rel, { maxAge: 86400, headers: { 'Content-Security-Policy': MEDIA_CSP } });
    if (!ok) throw new ApiError(404, 'not_found', 'Not found.');
  });
}
