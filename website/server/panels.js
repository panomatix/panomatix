// Additional panels (panonceaux): which panels a national sign may carry, and checks on the ones it does.
import { mediaUrl } from './images.js';

export const PANEL_CATEGORIES = new Set(['H', 'OTHER-H']);
const REF_RE = /^(VIENNA|VIENNA2006|OTHER):/;
const baseCc = (cc) => String(cc ?? '').toLowerCase().split('-')[0];
const nameOf = (data) => data.name?.en ?? Object.values(data.name ?? {})[0] ?? '';

/** A panel reference ("VIENNA:H-08.1" or a national code "de:1004-30") -> what it points to, or null. */
export function resolvePanel(ctx, ref) {
  if (REF_RE.test(ref)) {
    const row = ctx.db.prepare('SELECT reference, category, data FROM signs WHERE reference=? AND deleted=0').get(ref);
    if (!row) return null;
    return { value: ref, reference: row.reference, category: row.category, name: nameOf(JSON.parse(row.data)), country_code: null, image: ctx.vienna.main(ref) };
  }
  const row = ctx.db.prepare(
    `SELECT c.code, c.country_code, s.reference, s.category, s.data FROM sign_codes c JOIN signs s ON s.reference=c.reference
     WHERE c.code=? AND s.deleted=0 ORDER BY s.sort_key LIMIT 1`,
  ).get(ref);
  if (!row) return null;
  const img = ctx.images.lookup(ref)[0];
  return { value: ref, reference: row.reference, category: row.category, name: nameOf(JSON.parse(row.data)), country_code: row.country_code, image: img ? mediaUrl(img) : null };
}

/**
 * Check every panel of one national sign.
 * `entry` is the sign carrying the panels, `countryCode` the country of the national sign,
 * `additional` its {top, bottom, left, right} slots. Returns [{position, slot, index, reference, level, message, panel}],
 * level being "ok", "warning" (allowed, but worth a second look) or "error" (refused on save).
 */
export function checkPanels(ctx, entry, countryCode, additional, path = '$.additional') {
  const out = [];
  const convention = entry.officialSign?.additional ?? {};
  const signIsPanel = PANEL_CATEGORIES.has(entry.category);
  for (const [position, slots] of Object.entries(additional ?? {})) {
    if (!Array.isArray(slots)) continue;
    const admissible = new Set((convention[position] ?? []).flatMap((s) => s.reference ?? []));
    const seen = new Set();
    slots.forEach((slot, si) => {
      for (const [ri, ref] of (slot?.reference ?? []).entries()) {
        const at = { position, slot: si, index: slot.index, reference: ref, path: `${path}.${position}[${si}].reference[${ri}]` };
        const panel = resolvePanel(ctx, ref);
        const push = (level, message) => out.push({ ...at, level, message, panel });
        if (!panel) { push('error', `${ref} is neither a sign nor a national code of the database.`); continue; }
        if (panel.reference === entry.reference) { push('error', 'A sign cannot be its own panel.'); continue; }
        if (panel.country_code && countryCode && baseCc(panel.country_code) !== baseCc(countryCode)) {
          push('error', `${ref} is a sign of another country (${panel.country_code}).`); continue;
        }
        const warnings = [];
        if (!PANEL_CATEGORIES.has(panel.category)) warnings.push(`${ref} is not an additional panel (category ${panel.category}).`);
        if (signIsPanel) warnings.push('This sign is itself an additional panel.');
        if (seen.has(ref)) warnings.push(`${ref} appears twice ${position === 'top' ? 'above' : position === 'bottom' ? 'below' : `on the ${position}`} the sign.`);
        seen.add(ref);
        if (admissible.size && !admissible.has(ref) && !admissible.has(panel.reference)) {
          warnings.push(`The Convention lists other panels for this sign (${[...admissible].join(', ')}).`);
        }
        if (warnings.length) push('warning', warnings.join(' '));
        else push('ok', admissible.has(ref) || admissible.has(panel.reference) ? 'Admissible under the Convention.' : 'Additional panel of this country.');
      }
    });
  }
  return out;
}

/** Panels a national sign of `countryCode` can carry: that country's panels, then the Convention's (category H). */
export function availablePanels(ctx, countryCode, q = '', limit = 60) {
  const cc = baseCc(countryCode);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const national = cc ? ctx.db.prepare(
    `SELECT c.code AS value, s.reference, s.category, s.data FROM sign_codes c JOIN signs s ON s.reference=c.reference
     WHERE s.deleted=0 AND s.category IN ('H','OTHER-H') AND (c.country_code=? OR c.country_code LIKE ?)
       AND (c.code LIKE ? ESCAPE '\\' OR s.search_text LIKE ? ESCAPE '\\')
     GROUP BY c.code ORDER BY s.sort_key, length(c.code), c.code LIMIT ?`,
  ).all(cc, `${cc}-%`, like, like.toLowerCase(), limit) : [];
  const vienna = ctx.db.prepare(
    `SELECT reference AS value, reference, category, data FROM signs
     WHERE deleted=0 AND category='H' AND (reference LIKE ? ESCAPE '\\' OR search_text LIKE ? ESCAPE '\\') ORDER BY sort_key LIMIT ?`,
  ).all(like, like.toLowerCase(), limit);
  return [...national, ...vienna].map((r) => {
    const img = REF_RE.test(r.value) ? ctx.vienna.main(r.value) : (ctx.images.lookup(r.value)[0] ? mediaUrl(ctx.images.lookup(r.value)[0]) : null);
    return { value: r.value, reference: r.reference, category: r.category, name: nameOf(JSON.parse(r.data)), national: !REF_RE.test(r.value), image: img };
  });
}
