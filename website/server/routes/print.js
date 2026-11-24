// /api/v1/print — full entries (with one image per national code) for the printable / PDF view.
import { mediaUrl } from '../images.js';
import { send } from '../http.js';
import { ApiError } from '../security.js';
import { iterCodes } from '../db.js';

export const PRINT_MAX = 2000;

export function registerPrintRoutes(router) {
  router.add('GET', '/api/v1/print', (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase().slice(0, 200);
    const category = ctx.query.get('category') ?? '';
    const country = (ctx.query.get('country') ?? '').toLowerCase();
    const kind = ctx.query.get('kind') ?? '';
    const ref = ctx.query.get('ref') ?? '';

    const where = ['s.deleted=0'];
    const args = [];
    if (ref) {
      where.push('s.reference=?');
      args.push(ref);
    }
    if (category) {
      where.push('s.category=?');
      args.push(category);
    }
    if (kind === 'vienna') where.push("s.reference LIKE 'VIENNA%'");
    else if (kind === 'other') where.push("s.reference LIKE 'OTHER:%'");
    else if (kind && kind !== 'all') throw new ApiError(400, 'invalid_parameter', 'kind must be vienna, other or all.');
    if (country) {
      where.push('EXISTS (SELECT 1 FROM sign_codes c WHERE c.reference=s.reference AND (c.country_code=? OR c.jurisdiction=?))');
      args.push(country, country);
    }
    for (const word of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("s.search_text LIKE ? ESCAPE '\\'");
      args.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const sqlWhere = where.join(' AND ');
    const { n: total } = ctx.db.prepare(`SELECT COUNT(*) AS n FROM signs s WHERE ${sqlWhere}`).get(...args);
    if (total > PRINT_MAX) {
      throw new ApiError(413, 'too_many_signs', `This selection has ${total} signs; a PDF can hold at most ${PRINT_MAX}. Narrow it with a category or a country.`, { total, max: PRINT_MAX });
    }
    const rows = ctx.db.prepare(`SELECT s.reference, s.version, s.updated_at, s.data FROM signs s WHERE ${sqlWhere} ORDER BY s.sort_key`).all(...args);
    const items = rows.map((r) => {
      const data = JSON.parse(r.data);
      const images = {};
      for (const [, , code] of iterCodes(data)) {
        if (images[code] !== undefined) continue;
        const hit = ctx.images.lookup(code);
        images[code] = hit.length ? mediaUrl(hit[0]) : null;
      }
      return { reference: r.reference, version: r.version, updated_at: r.updated_at, vienna_image: ctx.vienna.main(r.reference), images, data };
    });
    send(ctx, 200, { total, generated_at: Math.floor(Date.now() / 1000), items });
  });
}
