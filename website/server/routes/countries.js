// /api/v1/signs/{ref}/countries/{jurisdiction} — read or replace everything one country says about one sign.
// A country appears under one or more designs ("variants", e.g. a white and a yellow version).
// PUT {version, variants: [{design: <index> | {new: {shape, background_color, …}}, data: <jurisdiction>}], comment}
//   - replaces all the country's variants at once (an empty list removes the country from the sign);
//   - moves the country between designs, or onto a design created on the fly;
//   - the whole entry is re-validated and saved as a new revision, like any edit.
import { addRevision, now, storeSign, transaction } from '../db.js';
import { imagesForEntry, mediaUrl } from '../images.js';
import { readJson, send } from '../http.js';
import { ApiError, rateLimit, requireUser } from '../security.js';
import { normalizeEntry, validateEntry } from '../validation.js';

const DESIGN_PROPS = ['shape', 'background_color', 'border_color', 'symbol_color', 'band', 'band_color', 'prohibition_bar', 'bar_continuity', 'model', 'legacyModel'];

function designSummary(ctx, design, index) {
  let sample = null;
  for (const jur of Object.values(design.jurisdictions ?? {})) {
    for (const lang of Object.values(jur.languages ?? {})) {
      for (const code of lang.codes ?? []) {
        const hit = ctx.images.lookup(code);
        if (hit.length) {
          sample = mediaUrl(hit[0]);
          break;
        }
      }
      if (sample) break;
    }
    if (sample) break;
  }
  const props = Object.fromEntries(DESIGN_PROPS.filter((p) => p in design).map((p) => [p, design[p]]));
  return { index, props, versions: design.versions, countries: Object.keys(design.jurisdictions ?? {}).length, sample };
}

/** Languages and country code this jurisdiction usually has elsewhere in the database. */
function suggestions(ctx, jur) {
  const refs = ctx.db.prepare('SELECT DISTINCT reference FROM sign_codes WHERE jurisdiction=? LIMIT 40').all(jur).map((r) => r.reference);
  const langs = new Map();
  const ccs = new Map();
  for (const ref of refs) {
    const row = ctx.db.prepare('SELECT data FROM signs WHERE reference=?').get(ref);
    for (const d of JSON.parse(row.data).officialSign?.designs ?? []) {
      const j = d.jurisdictions?.[jur];
      if (!j) continue;
      ccs.set(j.countryCode, (ccs.get(j.countryCode) ?? 0) + 1);
      for (const l of Object.keys(j.languages ?? {})) langs.set(l, (langs.get(l) ?? 0) + 1);
    }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { languages: top(langs), country_code: top(ccs)[0] ?? null };
}

function countryView(ctx, row, jur) {
  const entry = JSON.parse(row.data);
  const designs = entry.officialSign.designs;
  const variants = designs.flatMap((d, i) => (d.jurisdictions?.[jur] ? [{ design: i, data: d.jurisdictions[jur] }] : []));
  const allImages = imagesForEntry(ctx.images, entry);
  const codes = new Set(variants.flatMap((v) => Object.values(v.data.languages ?? {}).flatMap((l) => l.codes ?? [])));
  return {
    reference: row.reference,
    version: row.version,
    deleted: Boolean(row.deleted),
    category: entry.category,
    name: entry.name ?? {},
    jurisdiction: jur,
    designs: designs.map((d, i) => designSummary(ctx, d, i)),
    variants,
    images: Object.fromEntries(Object.entries(allImages).filter(([c]) => codes.has(c))),
    suggestions: suggestions(ctx, jur),
  };
}

function checkJurKey(jur) {
  if (!/^[a-z0-9_]{2,60}$/.test(jur)) throw new ApiError(400, 'invalid_country', 'Invalid country key.');
}

export function registerCountryRoutes(router) {
  router.add('GET', '/api/v1/signs/:ref/countries/:jur', (ctx) => {
    checkJurKey(ctx.params.jur);
    const row = ctx.db.prepare('SELECT * FROM signs WHERE reference=?').get(ctx.params.ref);
    if (!row) throw new ApiError(404, 'not_found', `No sign ${ctx.params.ref}.`);
    send(ctx, 200, countryView(ctx, row, ctx.params.jur));
  });

  router.add('PUT', '/api/v1/signs/:ref/countries/:jur', async (ctx) => {
    const user = requireUser(ctx);
    const jur = ctx.params.jur;
    checkJurKey(jur);
    const body = await readJson(ctx);
    rateLimit(ctx.db, `edit:${user.id}`, ctx.config.editLimit, 3600);
    if (!Number.isInteger(body.version)) throw new ApiError(400, 'missing_version', 'Send the `version` you edited, to detect concurrent edits.');
    if (!Array.isArray(body.variants) || body.variants.length > 20) throw new ApiError(400, 'invalid_variants', '`variants` must be a list.');
    const comment = typeof body.comment === 'string' ? body.comment.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    const ts = now();

    transaction(ctx.db, () => {
      const row = ctx.db.prepare('SELECT * FROM signs WHERE reference=?').get(ctx.params.ref);
      if (!row) throw new ApiError(404, 'not_found', `No sign ${ctx.params.ref}.`);
      if (row.deleted) throw new ApiError(409, 'deleted', 'This sign was deleted; a moderator must restore it first.');
      if (row.version !== body.version) {
        throw new ApiError(409, 'edit_conflict', 'Someone else changed this sign since you opened it. Reload it and apply your changes again.', { current_version: row.version });
      }
      const entry = JSON.parse(row.data);
      const designs = entry.officialSign.designs;

      // Resolve target designs (creating new ones when asked).
      const targets = new Map(); // design index -> jurisdiction data
      for (const [i, v] of body.variants.entries()) {
        if (!v || typeof v !== 'object' || !v.data || typeof v.data !== 'object' || Array.isArray(v.data)) {
          throw new ApiError(400, 'invalid_variants', `Variant ${i + 1} has no data.`);
        }
        let idx = v.design;
        if (idx && typeof idx === 'object' && idx.new && typeof idx.new === 'object') {
          const props = Object.fromEntries(DESIGN_PROPS.filter((p) => p in idx.new).map((p) => [p, idx.new[p]]));
          designs.push({
            shape: null, background_color: null, border_color: null, symbol_color: null, ...props,
            versions: [], legacyReferences: [], mirrored: false, wikidata: 'QXXXXXXX', toBeAdded: true, jurisdictions: {},
          });
          idx = designs.length - 1;
        }
        if (!Number.isInteger(idx) || idx < 0 || idx >= designs.length) throw new ApiError(400, 'invalid_variants', `Variant ${i + 1}: unknown design.`);
        if (targets.has(idx)) throw new ApiError(400, 'invalid_variants', 'Two variants use the same design.');
        targets.set(idx, v.data);
      }

      // Apply: replace in place where the country stays, remove elsewhere, append where new.
      designs.forEach((d, i) => {
        d.jurisdictions ??= {};
        if (targets.has(i)) d.jurisdictions[jur] = targets.get(i);
        else delete d.jurisdictions[jur];
      });

      normalizeEntry(entry);
      const errors = validateEntry(entry);
      if (errors.length) throw new ApiError(422, 'validation_failed', 'The country data does not match the database schema.', { details: errors });
      if (JSON.stringify(entry) === row.data) return;
      storeSign(ctx.db, entry, { version: row.version + 1, userId: user.id, ts, insert: false });
      ctx.images.learnEntry(entry);
      addRevision(ctx.db, {
        reference: row.reference, version: row.version + 1, action: 'update', entry, userId: user.id, ts,
        comment: comment || `${jur}: ${body.variants.length ? 'updated' : 'removed'}`,
      });
    });
    const row = ctx.db.prepare('SELECT * FROM signs WHERE reference=?').get(ctx.params.ref);
    send(ctx, 200, countryView(ctx, row, jur));
  });
}
