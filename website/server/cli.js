// Command-line tools:
//   node server/cli.js import [file] [--replace]   load full_database.json into the database
//   node server/cli.js export [file]               write the database back to full_database.json
//   node server/cli.js create-user <email> <display name> [contributor|moderator|admin]
//        (the password is read from the PANOMATIX_PASSWORD environment variable or prompted)
//   node server/cli.js backup                      write the changes since the last backup now
//   node server/cli.js restore <file>...           replay backups (oldest first) into the database
//   node server/cli.js fetch-images [--limit=N]    download missing sign pictures from their Wikimedia link
//   node server/cli.js complete-parameters [--dry-run]  give every national version of a sign with a value
//        (speed, width…) the parameter and unit its siblings have (values left to fill in)
//   node server/cli.js prune-designs [--dry-run]   remove the designs of OTHER signs that hold no country
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { REPO_DIR, loadConfig } from './config.js';
import { addRevision, now, openDatabase, storeSign, transaction } from './db.js';
import { ROLE_RANK, checkPasswordPolicy, hashPassword } from './security.js';
import { normalizeEntry, validateEntry } from './validation.js';
import { cleanEmail, cleanName } from './routes/auth.js';
import { restoreBackups, runBackup } from './backup.js';
import { fetchMissingImages, missingImages } from './fetch-images.js';
import { completeParameters } from './parameters.js';
import { pruneEmptyDesigns } from './prune-designs.js';
import { createApp } from './app.js';

const config = loadConfig();
const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

function importJson(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('The file must contain a JSON array of signs.');
  const db = openDatabase(config.database);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM signs').get().n;
  if (existing && !flags.has('--replace')) {
    console.error(`The database already holds ${existing} signs. Re-run with --replace to wipe them and their history.`);
    process.exit(1);
  }
  const seen = new Set();
  const problems = [];
  for (const e of entries) {
    normalizeEntry(e);
    const errs = validateEntry(e);
    if (errs.length) problems.push(`${e?.reference ?? '?'}: ${errs[0].path} ${errs[0].message}`);
    if (seen.has(e.reference)) problems.push(`${e.reference}: duplicate reference`);
    seen.add(e.reference);
  }
  if (problems.length) {
    console.error(`${problems.length} invalid entries, nothing imported:\n${problems.slice(0, 30).join('\n')}`);
    process.exit(1);
  }
  const ts = now();
  transaction(db, () => {
    db.exec('DELETE FROM sign_codes; DELETE FROM revisions; DELETE FROM signs;');
    for (const e of entries) {
      storeSign(db, e, { version: 1, userId: null, ts, insert: true });
      addRevision(db, { reference: e.reference, version: 1, action: 'import', entry: e, comment: `Imported from ${path.basename(file)}`, ts });
    }
  });
  console.log(`Imported ${entries.length} signs from ${file}.`);
}

function exportJson(file) {
  const db = openDatabase(config.database);
  const out = fs.openSync(`${file}.tmp`, 'w');
  fs.writeSync(out, '[\n');
  let n = 0;
  for (const { data } of db.prepare('SELECT data FROM signs WHERE deleted=0 ORDER BY position').iterate()) {
    const pretty = JSON.stringify(JSON.parse(data), null, 2).replace(/^/gm, '  ');
    fs.writeSync(out, `${n ? ',\n' : ''}${pretty}`);
    n += 1;
  }
  fs.writeSync(out, '\n]\n');
  fs.closeSync(out);
  fs.renameSync(`${file}.tmp`, file);
  console.log(`Exported ${n} signs to ${file}.`);
}

async function promptHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : '');
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function createUser([emailArg, nameArg, role = 'contributor']) {
  if (!emailArg || !nameArg) throw new Error('Usage: create-user <email> <display name> [contributor|moderator|admin]');
  if (!(role in ROLE_RANK)) throw new Error('Role must be contributor, moderator or admin.');
  const email = cleanEmail(emailArg);
  const name = cleanName(nameArg);
  const password = process.env.PANOMATIX_PASSWORD ?? (await promptHidden('Password: '));
  checkPasswordPolicy(password, email);
  const db = openDatabase(config.database);
  const hash = await hashPassword(password);
  const row = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (row) {
    db.prepare('UPDATE users SET display_name=?, password_hash=?, role=?, is_active=1, email_verified_at=COALESCE(email_verified_at, ?) WHERE id=?').run(name, hash, role, now(), row.id);
    console.log(`Updated ${email} (${role}).`);
  } else {
    db.prepare('INSERT INTO users (email, display_name, password_hash, role, created_at, email_verified_at) VALUES (?,?,?,?,?,?)').run(email, name, hash, role, now(), now());
    console.log(`Created ${email} (${role}).`);
  }
}

try {
  if (cmd === 'import') importJson(positional[0] ?? path.join(REPO_DIR, 'full_database.json'));
  else if (cmd === 'export') exportJson(positional[0] ?? path.join(REPO_DIR, 'full_database.json'));
  else if (cmd === 'create-user') await createUser(positional);
  else if (cmd === 'backup') {
    const b = runBackup(openDatabase(config.database), config);
    console.log(b.file ? `Backup written: ${b.file} (${b.revisions} revisions, ${b.images} images, ${b.users} accounts)` : 'Nothing changed since the last backup.');
  } else if (cmd === 'restore') {
    if (!positional.length) throw new Error('Usage: restore <backup file>...');
    const r = restoreBackups(openDatabase(config.database), config, positional);
    console.log(`Restored ${r.revisions} revisions, ${r.images} images, ${r.users} accounts. Re-run "npm run export" to update full_database.json.`);
  } else if (cmd === 'fetch-images') {
    const db = openDatabase(config.database);
    const { images } = createApp({ config, db });
    const limitArg = args.find((a) => a.startsWith('--limit='));
    const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;
    if (args.includes('--retry')) db.exec("DELETE FROM image_fetches WHERE status='failed'");
    const todo = missingImages(db, images).length;
    console.log(`${todo} national signs have a Wikimedia link but no picture. One request a second: about ${Math.ceil(Math.min(todo, limit) / 60)} min.`);
    const r = await fetchMissingImages({ db, images, config }, { limit, log: (line) => console.log(line) });
    console.log(`Done: ${r.done} added, ${r.failed} failed, ${r.left} left${r.stopped ? ` — ${r.stopped}` : ''}.`);
  } else if (cmd === 'complete-parameters') {
    const dryRun = flags.has('--dry-run');
    const r = completeParameters(openDatabase(config.database), { dryRun });
    for (const c of r.changes) console.log(`${c.reference}: ${c.added.join(', ')}`);
    console.log(`${dryRun ? 'Would complete' : 'Completed'} ${r.nationalSigns} national signs in ${r.signs} signs${dryRun ? ' (dry run, nothing saved)' : ', each saved as a new version'}.`);
  } else if (cmd === 'prune-designs') {
    const dryRun = flags.has('--dry-run');
    const changes = pruneEmptyDesigns(openDatabase(config.database), { dryRun });
    for (const c of changes) console.log(`${c.reference}: design ${c.removed.join(', ')} removed${c.left ? '' : ' (no design left)'}`);
    console.log(`${dryRun ? 'Would remove' : 'Removed'} empty designs in ${changes.length} OTHER signs${dryRun ? ' (dry run, nothing saved)' : ', each saved as a new version'}.`);
  } else {
    console.log('Commands: import [file] [--replace] | export [file] | create-user <email> <name> [role] | backup | restore <file>... | fetch-images [--limit=N] [--retry] | complete-parameters [--dry-run] | prune-designs [--dry-run]');
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
