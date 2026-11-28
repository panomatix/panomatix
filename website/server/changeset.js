// Applies the proposals of tools/reclassify (changeset.json) to the database, as ordinary edits:
//   merge     OTHER → OTHER (the one with the lowest number): the national signs move over;
//   attach    OTHER → Convention sign: the national signs move into the design with the same labels;
//   describe  empty description fields filled with official national texts.
// A sign edited on the site since the proposals were made is left alone (its version no longer matches).
// A national sign landing where its country already has one is merged into it (codes, OSM tags, sources).
// An OTHER sign left without any country is deleted (soft, restorable), with "merged into …" in its history.
import { addRevision, now, storeSign, transaction } from './db.js';
import { pruneEmptyOtherDesigns } from './routes/units.js';
import { normalizeEntry, validateEntry } from './validation.js';

const DESIGN_LABELS = ['shape', 'background_color', 'border_color', 'symbol_color', 'band', 'band_color', 'prohibition_bar', 'bar_continuity'];

function containers(entry) {
  return [...(entry.officialSign?.designs ?? []), ...(entry.relatedSigns ?? [])];
}

/** The container and key of the national sign that carries `code` in `entry`. */
function findUnit(entry, code) {
  for (const c of containers(entry)) {
    for (const [jur, data] of Object.entries(c.jurisdictions ?? {})) {
      if (Object.values(data.languages ?? {}).some((l) => l.code === code || l.codes?.includes(code))) return { c, jur, data };
    }
  }
  return null;
}

const countries = (entry) => new Set(containers(entry).flatMap((c) => Object.values(c.jurisdictions ?? {}).map((j) => j.countryCode)));

/** Put `data` under `key` in design `d`; when the country already has a national sign there, merge into it. */
function place(d, key, data) {
  d.jurisdictions ??= {};
  const existingKey = d.jurisdictions[key] ? key : Object.keys(d.jurisdictions).find((k) => d.jurisdictions[k].countryCode === data.countryCode);
  if (!existingKey) {
    d.jurisdictions[key] = data;
    return 'added';
  }
  const into = d.jurisdictions[existingKey];
  for (const [lang, l] of Object.entries(data.languages ?? {})) {
    const target = into.languages[lang];
    if (!target) into.languages[lang] = l;
    else {
      target.codes = [...new Set([...target.codes, ...l.codes])];
      target.text ??= l.text;
      target.description ??= l.description;
    }
  }
  into.osm.traffic_sign = [...new Set([...(into.osm?.traffic_sign ?? []), ...(data.osm?.traffic_sign ?? [])])];
  const files = new Set((into.sources ?? []).map((s) => s.file));
  into.sources = [...(into.sources ?? []), ...(data.sources ?? []).filter((s) => !files.has(s.file))];
  if (!into.parameters && data.parameters) into.parameters = data.parameters;
  into.description = { ...(data.description ?? {}), ...(into.description ?? {}) };
  if (!Object.keys(into.description).length) delete into.description;
  return 'merged with the existing national sign';
}

/** A new design of an OTHER sign for a national sign that matches none of its designs: the labels of the
 *  design it came from (its other fields too when it came from a design, not from a related sign). */
function newDesignFrom(labels, template) {
  const isDesign = template && Array.isArray(template.versions);
  const d = {
    shape: null, background_color: null, border_color: null, symbol_color: null,
    versions: [], legacyReferences: [], mirrored: false, wikidata: 'QXXXXXXX', toBeAdded: false,
    ...(isDesign ? structuredClone(template) : {}),
    jurisdictions: {},
  };
  for (const k of DESIGN_LABELS) if (labels?.[k] !== undefined) d[k] = labels[k];
  return d;
}

export function applyChangeset(db, changeset, { approved = null, dryRun = false, log = () => {} } = {}) {
  const ok = approved ? new Set(approved) : new Set(changeset.ops.filter((op) => op.auto).map((op) => op.id));
  const ops = changeset.ops.filter((op) => ok.has(op.id));
  // merges and attaches first, descriptions last (they find each national sign by its code, wherever it went)
  ops.sort((a, b) => (a.type === 'describe') - (b.type === 'describe'));
  const bumps = new Map(); // reference -> revisions written by this run
  const report = { applied: 0, skipped: [], deleted: [] };
  const getRow = (ref) => db.prepare('SELECT reference, version, deleted, data FROM signs WHERE reference=?').get(ref);
  const unchanged = (row) => {
    const base = changeset.versions?.[row.reference];
    return base == null || row.version === base + (bumps.get(row.reference) ?? 0);
  };
  const write = (row, entry, comment, ts, { deleted = false } = {}) => {
    normalizeEntry(entry);
    const errors = validateEntry(entry);
    if (errors.length) throw new Error(`${row.reference}: ${errors[0].path} ${errors[0].message}`);
    if (dryRun) return;
    storeSign(db, entry, { version: row.version + 1, userId: null, ts, deleted, insert: false });
    addRevision(db, { reference: row.reference, version: row.version + 1, action: deleted ? 'delete' : 'update', entry: deleted ? null : entry, comment, userId: null, ts });
    bumps.set(row.reference, (bumps.get(row.reference) ?? 0) + 1);
  };

  for (const op of ops) {
    try {
      transaction(db, () => {
        const ts = now();
        if (op.type === 'describe') {
          const done = new Map(); // reference -> {row, entry, n}
          for (const item of op.items) {
            const where = db.prepare('SELECT reference FROM sign_codes WHERE code=? LIMIT 1').get(item.code);
            if (!where) continue;
            const row = done.get(where.reference)?.row ?? getRow(where.reference);
            if (!row || row.deleted || !unchanged(row)) continue;
            const slot = done.get(where.reference) ?? { row, entry: JSON.parse(row.data), n: 0 };
            const unit = findUnit(slot.entry, item.code);
            if (!unit) continue;
            for (const [lang, text] of Object.entries(item.native ?? {})) {
              const l = unit.data.languages[lang];
              if (l && !l.description) { l.description = text.slice(0, 4000); slot.n += 1; }
            }
            if (item.en && !unit.data.description?.en) {
              unit.data.description = { ...(unit.data.description ?? {}), en: item.en.slice(0, 4000) };
              slot.n += 1;
            }
            done.set(where.reference, slot);
          }
          for (const { row, entry, n } of done.values()) {
            if (n) write(row, entry, `Official national descriptions filled in (${n} field${n > 1 ? 's' : ''}; Wikipedia catalogues / Wikimedia Commons)`, ts);
          }
          report.applied += 1;
          return;
        }

        // merge / attach
        const from = getRow(op.from);
        const into = getRow(op.into);
        if (!from || !into || from.deleted || into.deleted) throw new Error('a sign is missing or deleted');
        if (!unchanged(from) || !unchanged(into)) throw new Error('edited on the site since the proposals were made');
        const src = JSON.parse(from.data);
        const dst = JSON.parse(into.data);
        const moved = [];
        for (const u of op.units) {
          const found = findUnit(src, u.code);
          if (!found) continue; // already moved by an earlier proposal
          let d = Number.isInteger(u.design) ? dst.officialSign.designs[u.design] : null;
          if (!d) {
            if (!op.into.startsWith('OTHER:')) { log(`  ${u.code}: no design of the same shape and colours in ${op.into}: left where it is`); continue; }
            d = newDesignFrom(u.labels, Object.fromEntries(Object.entries(found.c).filter(([k]) => k !== 'jurisdictions')));
            dst.officialSign.designs.push(d);
            u.design = dst.officialSign.designs.length - 1;
          }
          delete found.c.jurisdictions[found.jur];
          const how = place(d, found.jur, found.data);
          moved.push(`${u.code} (${how})`);
        }
        if (!moved.length) throw new Error('nothing left to move');
        const why = `${op.type === 'merge' ? 'same sign' : 'Convention sign'}, similarity ${op.confidence}`;
        if (op.type === 'merge' && !(dst.legacyReferences ?? []).includes(op.from)) dst.legacyReferences = [...(dst.legacyReferences ?? []), op.from];
        write(into, dst, `Reclassification: ${moved.join(', ')} from ${op.from} (${why})`, ts);
        pruneEmptyOtherDesigns(src);
        const empty = op.from.startsWith('OTHER:') && countries(src).size === 0;
        write(from, src, `Reclassification: ${moved.length} national sign(s) moved to ${op.into} (${why})${empty ? '; no country left: merged into ' + op.into : ''}`, ts, { deleted: empty });
        if (empty) report.deleted.push(op.from);
        report.applied += 1;
        log(`${op.id} ${op.from} → ${op.into}: ${moved.join(', ')}${empty ? ` — ${op.from} deleted (merged)` : ''}`);
      });
    } catch (err) {
      report.skipped.push({ id: op.id, reason: err.message });
      log(`${op.id} skipped: ${err.message}`);
    }
  }
  return report;
}
