// Image processing (sharp / libvips): compression of uploads and pictures stacked from several files.
import sharp from 'sharp';

const MAX_SIDE = 2000; // px: larger uploads are scaled down (road sign pictures never need more)

/** Lossless clean-up of an SVG that already passed the safety check: editor data, metadata and comments
 *  removed, whitespace between tags collapsed (except around text, where it can matter). */
export function cleanSvg(text) {
  let out = text
    .replace(/^﻿/, '')
    .replace(/^<\?xml[^>]*\?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '')
    .replace(/<sodipodi:namedview\b[^>]*\/>/gi, '')
    .replace(/<sodipodi:namedview\b[\s\S]*?<\/sodipodi:namedview>/gi, '')
    .replace(/\s(?:inkscape|sodipodi):[\w.-]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  // Drop a namespace declaration only once nothing uses its prefix any more.
  for (const ns of ['inkscape', 'sodipodi', 'rdf', 'cc', 'dc']) {
    const decl = new RegExp(`\\sxmlns:${ns}\\s*=\\s*("[^"]*"|'[^']*')`, 'i');
    if (!new RegExp(`[<\\s/]${ns}:`, 'i').test(out.replace(decl, ''))) out = out.replace(decl, '');
  }
  if (!/<text\b/i.test(out)) out = out.replace(/>\s+</g, '><');
  out = out.trim();
  return /<svg\b/i.test(out) && /<\/svg>$/i.test(out) ? out : text; // keep the original if anything looks off
}

/** Compress an accepted upload. Bitmaps become WebP (lossless for PNG/GIF drawings, quality 85 for photos),
 *  scaled down to MAX_SIDE, EXIF orientation applied and metadata (GPS…) dropped. The original is kept
 *  when it is already smaller and needs no resizing. Returns {data, ext}. */
export async function compressUpload(data, ext) {
  if (ext === '.svg') {
    const text = cleanSvg(data.toString('utf8'));
    return { data: Buffer.from(text, 'utf8'), ext };
  }
  const img = sharp(data, { animated: true, limitInputPixels: 100_000_000 });
  const meta = await img.metadata();
  const tooBig = Math.max(meta.width ?? 0, meta.pageHeight ?? meta.height ?? 0) > MAX_SIDE;
  const photo = ext === '.jpg' || (ext === '.webp' && !meta.isLossless);
  const webp = await img
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp(photo ? { quality: 85, effort: 6 } : { lossless: true, effort: 6 })
    .toBuffer();
  if (!tooBig && webp.length >= data.length) return { data, ext };
  return { data: webp, ext: '.webp' };
}

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** One SVG showing several pictures one above the other (a sign and its panel), all scaled to the
 *  same width. Each part is embedded as a data: URL, so the result is self-contained. */
export async function stackSvg(parts) {
  const W = 100;
  const GAP = 4;
  let y = 0;
  const images = [];
  for (const { data, ext } of parts) {
    const { width, height } = await sharp(data).metadata();
    if (!width || !height) throw new Error('Unreadable image');
    const h = (W * height) / width;
    images.push(`<image x="0" y="${y.toFixed(2)}" width="${W}" height="${h.toFixed(2)}" href="data:${MIME[ext]};base64,${data.toString('base64')}"/>`);
    y += h + GAP;
  }
  const total = (y - GAP).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${total}" width="${W}" height="${total}">${images.join('')}</svg>`;
}
