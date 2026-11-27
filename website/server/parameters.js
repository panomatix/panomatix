// Signs that carry a value (a speed, a width, a weight…): every national version gets the parameter its
// siblings already have — same name, type, unit and description — with an empty list of values where the
// value is not known yet, for contributors to fill in. Saved as ordinary edits (new version + revision).
import { addRevision, now, storeSign, transaction } from './db.js';

function* jurisdictions(entry) {
  for (const d of entry.officialSign?.designs ?? []) yield* Object.values(d.jurisdictions ?? {});
}

/** {key: {type, unit, description}} used by the national versions of a sign (most frequent form of each). */
function templatesOf(entry) {
  const seen = new Map();
  for (const jur of jurisdictions(entry)) {
    for (const [key, p] of Object.entries(jur.parameters ?? {})) {
      const form = JSON.stringify({ type: p.type, unit: p.unit ?? null, description: p.description ?? null });
      const forms = seen.get(key) ?? new Map();
      forms.set(form, (forms.get(form) ?? 0) + 1);
      seen.set(key, forms);
    }
  }
  const out = {};
  for (const [key, forms] of seen) {
    // prefer the most frequent form that has a unit
    const best = [...forms].sort((a, b) => (JSON.parse(b[0]).unit ? 1 : 0) - (JSON.parse(a[0]).unit ? 1 : 0) || b[1] - a[1])[0][0];
    out[key] = JSON.parse(best);
  }
  return out;
}

/** Add the missing parameters (and missing units). Returns {signs, nationalSigns, changes: [{reference, added}]}. */
export function completeParameters(db, { dryRun = false } = {}) {
  const changes = [];
  let nationalSigns = 0;
  const rows = db.prepare('SELECT reference, version, data FROM signs WHERE deleted=0 ORDER BY sort_key').all();
  transaction(db, () => {
    for (const row of rows) {
      const entry = JSON.parse(row.data);
      const templates = templatesOf(entry);
      if (!Object.keys(templates).length) continue;
      const added = new Set();
      for (const jur of jurisdictions(entry)) {
        let touched = false;
        for (const [key, tpl] of Object.entries(templates)) {
          const p = jur.parameters?.[key];
          if (!p) {
            jur.parameters = { ...(jur.parameters ?? {}), [key]: { type: tpl.type, unit: tpl.unit, description: tpl.description, values: [] } };
            touched = true;
          } else if (!p.unit && tpl.unit) {
            p.unit = tpl.unit;
            touched = true;
          } else continue;
          added.add(`${key}${tpl.unit ? ` (${tpl.unit})` : ''}`);
        }
        if (touched) nationalSigns += 1;
      }
      if (!added.size) continue;
      changes.push({ reference: row.reference, added: [...added] });
      if (dryRun) continue;
      const ts = now();
      const comment = `Add the missing parameter${added.size > 1 ? 's' : ''} ${[...added].join(', ')} to the national signs (values to fill in)`;
      storeSign(db, entry, { version: row.version + 1, userId: null, ts, insert: false });
      addRevision(db, { reference: row.reference, version: row.version + 1, action: 'update', entry, comment, userId: null, ts });
    }
  });
  return { signs: changes.length, nationalSigns, changes };
}
