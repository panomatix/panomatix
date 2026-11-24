// /api/v1/compare — sign × country matrix: which national code (and design) each country uses for each sign.
import { mediaUrl } from '../images.js';
import { send } from '../http.js';
import { ApiError } from '../security.js';

const MAX_COUNTRIES = 150;

function designLabel(d) {
  return [d.shape, d.background_color, d.border_color && `${d.border_color} border`, d.symbol_color && `${d.symbol_color} symbol`]
    .filter(Boolean).join(' · ');
}

export function registerCompareRoutes(router) {
  router.add('GET', '/api/v1/compare', (ctx) => {
    const category = ctx.query.get('category') ?? '';
    const kind = ctx.query.get('kind') || 'vienna';
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase().slice(0, 200);
    const countries = (ctx.query.get('countries') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const onlyFilled = ctx.query.get('only_filled') === '1';
    const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
    const perPage = Math.min(500, Math.max(1, Number.parseInt(ctx.query.get('per_page') ?? '300', 10) || 300));
    if (countries.length > MAX_COUNTRIES) throw new ApiError(400, 'invalid_parameter', `At most ${MAX_COUNTRIES} countries.`);
    if (countries.some((c) => !/^[a-z0-9_-]{2,60}$/.test(c))) throw new ApiError(400, 'invalid_parameter', 'Invalid country list.');

    const where = ['s.deleted=0'];
    const args = [];
    if (kind === 'vienna') where.push("s.reference LIKE 'VIENNA%'");
    else if (kind === 'other') where.push("s.reference LIKE 'OTHER:%'");
    else if (kind !== 'all') throw new ApiError(400, 'invalid_parameter', 'kind must be vienna, other or all.');
    if (category) {
      where.push('s.category=?');
      args.push(category);
    }
    for (const word of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("s.search_text LIKE ? ESCAPE '\\'");
      args.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (countries.length && (onlyFilled || kind !== 'vienna')) {
      // National catalogues are huge: keep only rows used by at least one selected country.
      where.push(`EXISTS (SELECT 1 FROM sign_codes c WHERE c.reference=s.reference AND c.jurisdiction IN (${countries.map(() => '?').join(',')}))`);
      args.push(...countries);
    } else if (onlyFilled) {
      where.push('EXISTS (SELECT 1 FROM sign_codes c WHERE c.reference=s.reference)');
    }
    const sqlWhere = where.join(' AND ');
    const { n: total } = ctx.db.prepare(`SELECT COUNT(*) AS n FROM signs s WHERE ${sqlWhere}`).get(...args);
    const rows = ctx.db.prepare(`SELECT s.reference, s.category, s.data FROM signs s WHERE ${sqlWhere} ORDER BY s.sort_key LIMIT ? OFFSET ?`)
      .all(...args, perPage, (page - 1) * perPage);

    const wanted = countries.length ? new Set(countries) : null;
    const columns = new Map(); // jurisdiction -> {key, country_code, count}
    const items = rows.map((r) => {
      const d = JSON.parse(r.data);
      const cells = {};
      (d.officialSign?.designs ?? []).forEach((design, di) => {
        for (const [jk, jur] of Object.entries(design.jurisdictions ?? {})) {
          if (wanted && !wanted.has(jk)) continue;
          const codes = [...new Set(Object.values(jur.languages ?? {}).flatMap((l) => l.codes ?? []))];
          const cell = (cells[jk] ??= { codes: [], design: di + 1, design_label: designLabel(design), image: null });
          for (const c of codes) if (!cell.codes.includes(c)) cell.codes.push(c);
          if (!cell.image) {
            for (const c of codes) {
              const hit = ctx.images.lookup(c);
              if (hit.length) {
                cell.image = mediaUrl(hit[0]);
                break;
              }
            }
          }
          if (Object.values(jur.additional ?? {}).some((slots) => slots.length)) cell.panels = true;
          const col = columns.get(jk) ?? { key: jk, country_code: jur.countryCode, count: 0 };
          columns.set(jk, col);
        }
      });
      for (const jk of Object.keys(cells)) columns.get(jk).count += 1;
      return { reference: r.reference, category: r.category, name: d.name ?? {}, designs: d.officialSign?.designs?.length ?? 0, vienna_image: ctx.vienna.main(r.reference), cells };
    });

    // Columns: the requested countries in the requested order, otherwise every country found, alphabetically.
    let cols;
    if (wanted) {
      const known = new Map(ctx.db.prepare(
        `SELECT jurisdiction, MIN(country_code) AS cc FROM sign_codes WHERE jurisdiction IN (${countries.map(() => '?').join(',')}) GROUP BY jurisdiction`,
      ).all(...countries).map((x) => [x.jurisdiction, x.cc]));
      cols = countries.filter((c) => known.has(c)).map((c) => columns.get(c) ?? { key: c, country_code: known.get(c), count: 0 });
    } else {
      cols = [...columns.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
    send(ctx, 200, { total, page, per_page: perPage, columns: cols, items });
  });
}
