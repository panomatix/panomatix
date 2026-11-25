// /api/v1/signs/{ref}/units/{loc}/{jur} — one national sign: what ONE country shows under ONE design
// (loc "d0", "d1"…) or ONE related sign (loc "r0", "r1"…) of a sign.
//   GET     the unit (or an empty template when the country is not there yet), the places it can move to,
//           and the Convention's panels for the sign;
//   PUT     {version, data, comment}  create or replace the unit (panels are checked, errors refuse the save);
//   DELETE  {version, comment}        remove the unit;
//   POST …/move {version, to: {reference?, loc}, comment}  move it to another design / related sign,
//           of the same sign or of another one.
// /api/v1/panels?country=fr&q=   panels a national sign of that country can carry;
// POST /api/v1/panels/check {reference, country_code, additional}   ok / warning / error for each panel.
import { addRevision, now, storeSign, transaction } from '../db.js';
import { imagesForEntry, mediaUrl } from '../images.js';
import { readJson, send } from '../http.js';
import { availablePanels, checkPanels } from '../panels.js';
import { ApiError, rateLimit, requireUser } from '../security.js';
import { normalizeEntry, validateEntry } from '../validation.js';
import { suggestions } from './countries.js';

const DESIGN_PROPS = ['shape', 'background_color', 'border_color', 'symbol_color', 'band', 'band_color', 'prohibition_bar', 'bar_continuity', 'model'];
const RELATED_PROPS = ['shape', 'background_color', 'border_color', 'symbol_color'];

function parseLoc(loc) {
  const m = /^([dr])(\d{1,4})$/.exec(loc ?? '');
  if (!m) throw new ApiError(400, 'invalid_location', 'The location must be d<n> (a design) or r<n> (a related sign).');
  return { kind: m[1] === 'd' ? 'design' : 'related', index: Number(m[2]) };
}

function checkJurKey(jur) {
  if (!/^[a-z0-9_]{2,60}$/.test(jur)) throw new ApiError(400, 'invalid_country', 'Invalid country key.');
}

/** The object holding `jurisdictions` at a location, with the JSON path of its jurisdictions. */
function container(entry, loc) {
  const { kind, index } = parseLoc(loc);
  const list = kind === 'design' ? entry.officialSign?.designs ?? [] : entry.relatedSigns ?? [];
  const c = list[index];
  if (!c) throw new ApiError(404, 'unknown_location', `${entry.reference} has no ${kind === 'design' ? 'design' : 'related sign'} ${index + 1}.`);
  c.jurisdictions ??= {};
  const path = kind === 'design' ? `$.officialSign.designs[${index}].jurisdictions` : `$.relatedSigns[${index}].jurisdictions`;
  return { c, kind, index, path };
}

function firstImage(ctx, jurs) {
  for (const jur of Object.values(jurs ?? {})) {
    for (const lang of Object.values(jur.languages ?? {})) {
      for (const code of lang.codes ?? []) {
        const hit = ctx.images.lookup(code);
        if (hit.length) return mediaUrl(hit[0]);
      }
    }
  }
  return null;
}

/** Every place of a sign a national sign can sit in. */
export function locations(ctx, reference, entry) {
  const official = ctx.vienna.get(reference, entry);
  const designs = (entry.officialSign?.designs ?? []).map((d, i) => ({
    loc: `d${i}`, kind: 'design', label: `Design ${i + 1}`,
    props: Object.fromEntries(DESIGN_PROPS.filter((p) => d[p] !== undefined && d[p] !== null && d[p] !== 'none').map((p) => [p, d[p]])),
    countries: Object.keys(d.jurisdictions ?? {}),
    image: official.find((im) => im.designs.includes(i))?.url ?? firstImage(ctx, d.jurisdictions),
  }));
  const related = (entry.relatedSigns ?? []).map((r, i) => ({
    loc: `r${i}`, kind: 'related', label: r.name?.en ?? r.reference, reference: r.reference,
    props: Object.fromEntries(RELATED_PROPS.filter((p) => r[p] !== undefined && r[p] !== null).map((p) => [p, r[p]])),
    countries: Object.keys(r.jurisdictions ?? {}),
    image: firstImage(ctx, r.jurisdictions),
  }));
  return [...designs, ...related];
}

const newUnit = (sugg) => ({
  countryCode: sugg.country_code ?? '',
  languages: { [sugg.languages[0] ?? 'en']: { code: '', codes: [], text: null, description: null } },
  additional: { top: [], bottom: [] },
  osm: { traffic_sign: [] },
});

function unitView(ctx, row, loc, jur) {
  const entry = JSON.parse(row.data);
  const { c } = container(entry, loc);
  const data = c.jurisdictions[jur] ?? null;
  const sugg = suggestions(ctx, jur);
  const codes = new Set(Object.values(data?.languages ?? {}).flatMap((l) => l.codes ?? []));
  const images = Object.fromEntries(Object.entries(imagesForEntry(ctx.images, entry)).filter(([code]) => codes.has(code)));
  return {
    reference: row.reference, version: row.version, deleted: Boolean(row.deleted), category: entry.category, name: entry.name ?? {},
    loc, jurisdiction: jur, exists: Boolean(data), data: data ?? newUnit(sugg), images, suggestions: sugg,
    locations: locations(ctx, row.reference, entry),
    convention_panels: entry.officialSign?.additional ?? {},
    panel_checks: data ? checkPanels(ctx, entry, data.countryCode, data.additional) : [],
  };
}

function loadRow(ctx, reference) {
  const row = ctx.db.prepare('SELECT * FROM signs WHERE reference=?').get(reference);
  if (!row) throw new ApiError(404, 'not_found', `No sign ${reference}.`);
  return row;
}

function writable(row, version) {
  if (row.deleted) throw new ApiError(409, 'deleted', 'This sign was deleted; a moderator must restore it first.');
  if (version !== undefined && row.version !== version) {
    throw new ApiError(409, 'edit_conflict', 'Someone else changed this sign since you opened it. Reload it and apply your changes again.', { current_version: row.version });
  }
}

function save(ctx, row, entry, { userId, ts, comment }) {
  normalizeEntry(entry);
  const errors = validateEntry(entry);
  if (errors.length) throw new ApiError(422, 'validation_failed', 'The national sign does not match the database schema.', { details: errors });
  if (JSON.stringify(entry) === row.data) return false;
  storeSign(ctx.db, entry, { version: row.version + 1, userId, ts, insert: false });
  ctx.images.learnEntry(entry);
  addRevision(ctx.db, { reference: row.reference, version: row.version + 1, action: 'update', entry, userId, ts, comment });
  return true;
}

function panelErrors(ctx, entry, data, path) {
  const errs = checkPanels(ctx, entry, data.countryCode, data.additional, `${path}.additional`).filter((x) => x.level === 'error');
  if (errs.length) {
    throw new ApiError(422, 'invalid_panels', 'Some additional panels cannot be added.', { details: errs.map((e) => ({ path: e.path, message: e.message })) });
  }
}

const cleanComment = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 500) : '');

export function registerUnitRoutes(router) {
  router.add('GET', '/api/v1/signs/:ref/units/:loc/:jur', (ctx) => {
    checkJurKey(ctx.params.jur);
    send(ctx, 200, unitView(ctx, loadRow(ctx, ctx.params.ref), ctx.params.loc, ctx.params.jur));
  });

  router.add('PUT', '/api/v1/signs/:ref/units/:loc/:jur', async (ctx) => {
    const user = requireUser(ctx);
    const { jur, loc } = ctx.params;
    checkJurKey(jur);
    const body = await readJson(ctx);
    rateLimit(ctx.db, `edit:${user.id}`, ctx.config.editLimit, 3600);
    if (!Number.isInteger(body.version)) throw new ApiError(400, 'missing_version', 'Send the `version` you edited, to detect concurrent edits.');
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new ApiError(400, 'invalid_data', '`data` must be the national sign object.');
    const ts = now();
    transaction(ctx.db, () => {
      const row = loadRow(ctx, ctx.params.ref);
      writable(row, body.version);
      const entry = JSON.parse(row.data);
      const { c, path } = container(entry, loc);
      const isNew = !c.jurisdictions[jur];
      c.jurisdictions[jur] = body.data;
      panelErrors(ctx, entry, body.data, `${path}.${jur}`);
      const code = Object.values(body.data.languages ?? {})[0]?.code ?? jur;
      save(ctx, row, entry, { userId: user.id, ts, comment: cleanComment(body.comment) || `${code}: ${isNew ? 'added' : 'updated'}` });
    });
    send(ctx, 200, unitView(ctx, loadRow(ctx, ctx.params.ref), loc, jur));
  });

  router.add('DELETE', '/api/v1/signs/:ref/units/:loc/:jur', async (ctx) => {
    const user = requireUser(ctx);
    const { jur, loc } = ctx.params;
    checkJurKey(jur);
    const body = await readJson(ctx);
    rateLimit(ctx.db, `edit:${user.id}`, ctx.config.editLimit, 3600);
    const ts = now();
    transaction(ctx.db, () => {
      const row = loadRow(ctx, ctx.params.ref);
      writable(row, body.version);
      const entry = JSON.parse(row.data);
      const { c } = container(entry, loc);
      const data = c.jurisdictions[jur];
      if (!data) throw new ApiError(404, 'not_found', `${jur} has no national sign there.`);
      delete c.jurisdictions[jur];
      const code = Object.values(data.languages ?? {})[0]?.code ?? jur;
      save(ctx, row, entry, { userId: user.id, ts, comment: cleanComment(body.comment) || `${code}: removed` });
    });
    const row = loadRow(ctx, ctx.params.ref);
    send(ctx, 200, { reference: row.reference, version: row.version });
  });

  router.add('POST', '/api/v1/signs/:ref/units/:loc/:jur/move', async (ctx) => {
    const user = requireUser(ctx);
    const { jur, loc } = ctx.params;
    checkJurKey(jur);
    const body = await readJson(ctx);
    rateLimit(ctx.db, `edit:${user.id}`, ctx.config.editLimit, 3600);
    const to = body.to ?? {};
    const targetRef = typeof to.reference === 'string' && to.reference ? to.reference : ctx.params.ref;
    parseLoc(to.loc);
    if (targetRef === ctx.params.ref && to.loc === loc) throw new ApiError(400, 'same_location', 'The national sign is already there.');
    const ts = now();
    let result;
    transaction(ctx.db, () => {
      const row = loadRow(ctx, ctx.params.ref);
      writable(row, body.version);
      const entry = JSON.parse(row.data);
      const from = container(entry, loc);
      const data = from.c.jurisdictions[jur];
      if (!data) throw new ApiError(404, 'not_found', `${jur} has no national sign there.`);
      const code = Object.values(data.languages ?? {})[0]?.code ?? jur;
      const same = targetRef === row.reference;
      const tRow = same ? row : loadRow(ctx, targetRef);
      if (!same) writable(tRow);
      const tEntry = same ? entry : JSON.parse(tRow.data);
      const dest = container(tEntry, to.loc);
      if (dest.c.jurisdictions[jur]) {
        throw new ApiError(409, 'already_there', `${jur} already has a national sign there: edit or remove it first.`);
      }
      delete from.c.jurisdictions[jur];
      dest.c.jurisdictions[jur] = data;
      panelErrors(ctx, tEntry, data, `${dest.path}.${jur}`);
      const where = `${same ? '' : `${targetRef} `}${dest.kind === 'design' ? `design ${dest.index + 1}` : `related sign ${dest.index + 1}`}`;
      const comment = cleanComment(body.comment) || `${code}: moved to ${where}`;
      save(ctx, row, entry, { userId: user.id, ts, comment });
      if (!same) save(ctx, tRow, tEntry, { userId: user.id, ts, comment: cleanComment(body.comment) || `${code}: moved from ${row.reference}` });
      result = { reference: targetRef, loc: to.loc };
    });
    const row = loadRow(ctx, ctx.params.ref);
    send(ctx, 200, { ...result, version: row.version, target: unitView(ctx, loadRow(ctx, result.reference), result.loc, jur) });
  });

  router.add('GET', '/api/v1/panels', (ctx) => {
    const country = (ctx.query.get('country') ?? '').toLowerCase();
    if (country && !/^[a-z]{2}(-[a-z0-9]{1,3})?$/.test(country)) throw new ApiError(400, 'invalid_country', 'Give a country code such as fr.');
    const q = (ctx.query.get('q') ?? '').trim().slice(0, 100);
    send(ctx, 200, { items: availablePanels(ctx, country, q) });
  });

  router.add('POST', '/api/v1/panels/check', async (ctx) => {
    const body = await readJson(ctx);
    const row = loadRow(ctx, String(body.reference ?? ''));
    const additional = body.additional && typeof body.additional === 'object' ? body.additional : {};
    const checks = checkPanels(ctx, JSON.parse(row.data), body.country_code ?? null, additional);
    send(ctx, 200, { ok: !checks.some((c) => c.level === 'error'), checks });
  });
}
