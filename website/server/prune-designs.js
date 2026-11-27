// Signs outside the Convention (OTHER:…): their designs that no longer hold any country are removed, as the
// site does when the last national sign leaves a design. Saved as ordinary edits (new version + revision).
import { addRevision, now, storeSign, transaction } from './db.js';
import { pruneEmptyOtherDesigns } from './routes/units.js';

export function pruneEmptyDesigns(db, { dryRun = false } = {}) {
  const changes = [];
  const rows = db.prepare("SELECT reference, version, data FROM signs WHERE deleted=0 AND reference LIKE 'OTHER:%' ORDER BY sort_key").all();
  transaction(db, () => {
    for (const row of rows) {
      const entry = JSON.parse(row.data);
      const removed = pruneEmptyOtherDesigns(entry);
      if (!removed.length) continue;
      changes.push({ reference: row.reference, removed: removed.map((i) => i + 1), left: entry.officialSign.designs.length });
      if (dryRun) continue;
      const ts = now();
      const comment = `Empty design${removed.length > 1 ? 's' : ''} ${removed.map((i) => i + 1).join(', ')} removed (no country left)`;
      storeSign(db, entry, { version: row.version + 1, userId: null, ts, insert: false });
      addRevision(db, { reference: row.reference, version: row.version + 1, action: 'update', entry, comment, userId: null, ts });
    }
  });
  return changes;
}
