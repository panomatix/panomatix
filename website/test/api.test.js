// End-to-end tests of the REST API on a throw-away database and image folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { addRevision, now, openDatabase, storeSign } from '../server/db.js';
import { hashPassword } from '../server/security.js';
import { restoreBackups, runBackup } from '../server/backup.js';
import { fetchMissingImages, missingImages } from '../server/fetch-images.js';
import { normalizeEntry, validateEntry } from '../server/validation.js';
import sharp from 'sharp';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-test-'));
let server;
let base;
let db;
let config;
let app;
const mails = []; // messages the server "sent"

before(async () => {
  const imagesDir = path.join(tmp, 'images');
  fs.mkdirSync(path.join(imagesDir, 'be_belgium', 'b_priority_signs', 'vienna'), { recursive: true });
  fs.writeFileSync(path.join(imagesDir, 'be_belgium', 'b_priority_signs', 'vienna', 'BE-B1.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  fs.mkdirSync(path.join(imagesDir, 'be_belgium', 'h_additional_panels', 'other'), { recursive: true });
  fs.writeFileSync(path.join(imagesDir, 'be_belgium', 'h_additional_panels', 'other', 'BE-M2.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="4"/>');
  const viennaDir = path.join(tmp, 'vienna');
  fs.mkdirSync(path.join(viennaDir, 'b_priority_signs'), { recursive: true });
  for (const f of ['B-01.1_inverted-triangle_white_red_none.svg', 'B-01.1_inverted-triangle_yellow_red_none.svg', 'B-01.1_circle_green_none_white.svg', 'B-01.1-old-name.svg']) fs.writeFileSync(path.join(viennaDir, 'b_priority_signs', f), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  db = openDatabase(path.join(tmp, 'test.sqlite3'));
  const ts = now();
  for (const e of fixture) {
    normalizeEntry(e);
    storeSign(db, e, { version: 1, userId: null, ts, insert: true });
    addRevision(db, { reference: e.reference, version: 1, action: 'import', entry: e, ts });
  }
  db.prepare('INSERT INTO users (email, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run('mod@example.org', 'Moderator', await hashPassword('moderator-password-1'), 'moderator', ts);
  const wikidataFetch = async (id) => ({ entities: { [id]: id === 'Q999' ? { id, missing: '' } : { id, labels: { fr: { value: 'cédez le passage' }, en: { value: 'give way' } }, descriptions: { en: { value: 'traffic sign' } } } } });
  config = loadConfig({ database: ':unused:', apiRatePerSecond: 0, imageFetchPauseMs: 0, wikidataFetch, backupDir: path.join(tmp, 'backups'), imagesDir, viennaImagesDir: viennaDir, cookieSecure: false, loginLimit: 5, registerLimit: 50 });
  app = createApp({ config, db, mailer: { send: (m) => { mails.push(m); } } });
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Minimal browser-like client: keeps the cookie and the CSRF token. */
class Client {
  cookie = '';
  csrf = null;
  async req(method, p, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string') {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (data?.csrf_token) this.csrf = data.csrf_token;
    return { status: res.status, data, headers: res.headers };
  }
}

/** The link token of the last email sent to an address. */
function lastToken(email) {
  const m = mails.findLast((x) => x.to === email);
  return m && /[?&]token=([\w-]+)/.exec(m.text)[1];
}

/** Sign up through the email link and leave the client signed in. */
async function signUp(c, email, display_name, password) {
  assert.equal((await c.req('POST', '/api/v1/auth/register', { email, display_name })).status, 202);
  return c.req('POST', '/api/v1/auth/set-password', { token: lastToken(email.toLowerCase()), password });
}

const sign = (c, ref) => c.req('GET', `/api/v1/signs/${encodeURIComponent(ref)}`);

describe('validation', () => {
  test('every fixture entry is valid and normalised with top/bottom slots', () => {
    for (const e of fixture) {
      assert.deepEqual(validateEntry(e), []);
      assert.ok(Array.isArray(e.officialSign.additional.top));
    }
  });
  test('rejects unknown keys, bad vocabulary and bad panel index', () => {
    const e = structuredClone(fixture[0]);
    e.extra = 1;
    e.officialSign.designs[0].shape = 'blob';
    e.officialSign.additional.top.push({ index: 0, reference: [] });
    const paths = validateEntry(e).map((x) => x.path);
    assert.ok(paths.includes('$'));
    assert.ok(paths.includes('$.officialSign.designs[0].shape'));
    assert.ok(paths.includes('$.officialSign.additional.top[0].index'));
  });
  test('VIENNA2006 signs use the plain A–H category (VIENNA-F merged into F)', () => {
    const e = structuredClone(fixture.find((x) => x.reference === 'VIENNA:C-14.1'));
    e.reference = 'VIENNA2006:C9';
    assert.deepEqual(validateEntry(e), []);
    e.category = 'VIENNA-C';
    assert.ok(validateEntry(e).length > 0);
  });
  test('semantic rules: category must match reference, code must be in codes', () => {
    const e = structuredClone(fixture.find((x) => x.reference === 'VIENNA:B-01.1'));
    e.category = 'C';
    assert.match(validateEntry(e)[0].message, /category/);
    const f = structuredClone(fixture.find((x) => x.reference === 'VIENNA:B-01.1'));
    const lang = Object.values(Object.values(f.officialSign.designs[0].jurisdictions)[0].languages)[0];
    lang.code = 'zz:nope';
    assert.ok(validateEntry(f).some((x) => x.message.includes('`code`')));
  });
});

describe('accounts', () => {
  test('sign up by email link, me, logout', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/v1/auth/register', { email: 'Alice@Example.org', display_name: 'Alice', lang: 'fr' });
    assert.equal(r.status, 202);
    assert.equal(r.headers.get('set-cookie'), null); // not signed in yet
    const mail = mails.at(-1);
    assert.equal(mail.to, 'alice@example.org');
    assert.match(mail.subject, /Confirmez/);
    assert.match(mail.text, /http:\/\/127\.0\.0\.1:8080\/#\/set-password\?token=/);
    // the pending account cannot sign in
    assert.equal((await c.req('POST', '/api/v1/auth/login', { email: 'alice@example.org', password: '' })).status, 401);
    const token = lastToken('alice@example.org');
    const info = await c.req('POST', '/api/v1/auth/link', { token });
    assert.deepEqual(info.data, { purpose: 'verify', email: 'alice@example.org', display_name: 'Alice' });
    assert.equal((await c.req('POST', '/api/v1/auth/set-password', { token, password: 'short' })).data.error.code, 'weak_password');
    const s = await c.req('POST', '/api/v1/auth/set-password', { token, password: 'a long enough password' });
    assert.equal(s.status, 200);
    assert.equal(s.data.user.role, 'contributor');
    assert.match(s.headers.get('set-cookie'), /HttpOnly/);
    assert.ok(db.prepare('SELECT email_verified_at FROM users WHERE email=?').get('alice@example.org').email_verified_at);
    // the link works once
    assert.equal((await c.req('POST', '/api/v1/auth/set-password', { token, password: 'another long password' })).data.error.code, 'invalid_token');
    assert.equal((await c.req('GET', '/api/v1/auth/me')).data.user.display_name, 'Alice');
    assert.equal((await c.req('POST', '/api/v1/auth/logout')).status, 200);
    c.csrf = null;
    assert.equal((await c.req('GET', '/api/v1/auth/me')).data.user, null);
    assert.equal((await c.req('POST', '/api/v1/auth/login', { email: 'alice@example.org', password: 'a long enough password' })).status, 200);
  });
  test('signing up again with a known address does not reveal it, and mails the owner', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/v1/auth/register', { email: 'alice@example.org', display_name: 'Al' });
    assert.equal(r.status, 202);
    assert.match(mails.at(-1).subject, /Your Panomatix account/);
    assert.equal(db.prepare('SELECT display_name FROM users WHERE email=?').get('alice@example.org').display_name, 'Alice');
    assert.equal((await c.req('POST', '/api/v1/auth/register', { email: 'nope', display_name: 'Bob' })).data.error.code, 'invalid_email');
    assert.equal((await c.req('POST', '/api/v1/auth/link', { token: 'made-up' })).data.error.code, 'invalid_token');
  });
  test('forgotten password: reset link signs out other sessions', async () => {
    const other = new Client();
    await other.req('POST', '/api/v1/auth/login', { email: 'alice@example.org', password: 'a long enough password' });
    const c = new Client();
    const before = mails.length;
    assert.equal((await c.req('POST', '/api/v1/auth/forgot-password', { email: 'nobody@example.org' })).status, 202);
    assert.equal(mails.length, before); // unknown address: same answer, no mail
    assert.equal((await c.req('POST', '/api/v1/auth/forgot-password', { email: 'Alice@example.org' })).status, 202);
    assert.match(mails.at(-1).subject, /Reset/);
    const token = lastToken('alice@example.org');
    assert.equal((await c.req('POST', '/api/v1/auth/link', { token })).data.purpose, 'reset');
    assert.equal((await c.req('POST', '/api/v1/auth/set-password', { token, password: 'a brand new password' })).status, 200);
    assert.equal((await other.req('GET', '/api/v1/auth/me')).data.user, null);
    assert.equal((await c.req('POST', '/api/v1/auth/login', { email: 'alice@example.org', password: 'a long enough password' })).status, 401);
    assert.equal((await c.req('POST', '/api/v1/auth/login', { email: 'alice@example.org', password: 'a brand new password' })).status, 200);
    // an expired link is refused
    await c.req('POST', '/api/v1/auth/forgot-password', { email: 'alice@example.org' });
    db.prepare('UPDATE email_tokens SET expires_at = 0').run();
    assert.equal((await c.req('POST', '/api/v1/auth/link', { token: lastToken('alice@example.org') })).data.error.code, 'invalid_token');
    db.exec('DELETE FROM rate_events');
  });
  test('wrong password is rejected, then rate limited', async () => {
    const c = new Client();
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await c.req('POST', '/api/v1/auth/login', { email: 'mod@example.org', password: 'wrong password!!' })).status);
    assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(codes[6], 429);
    db.exec('DELETE FROM rate_events');
  });
  test('token mode returns a Bearer token usable without CSRF', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/v1/auth/login', { email: 'mod@example.org', password: 'moderator-password-1', mode: 'token' });
    assert.equal(r.status, 200);
    assert.ok(r.data.token);
    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${r.data.token}` } }).then((x) => x.json());
    assert.equal(me.user.role, 'moderator');
  });
});

describe('signs', () => {
  test('list, search, filter by country', async () => {
    const c = new Client();
    const all = await c.req('GET', '/api/v1/signs');
    assert.equal(all.data.total, 3);
    const q = await c.req('GET', '/api/v1/signs?q=give%20way');
    assert.deepEqual(q.data.items.map((i) => i.reference), ['VIENNA:B-01.1']);
    const be = await c.req('GET', '/api/v1/signs?country=be&category=B');
    assert.equal(be.data.items[0].thumbnail.url, '/media/be_belgium/b_priority_signs/vienna/BE-B1.svg');
    assert.equal((await c.req('GET', '/api/v1/signs?per_page=999')).status, 400);
  });

  test('edit flow: CSRF, panel above the sign, conflict, history, revert', async () => {
    const c = new Client();
    await signUp(c, 'carol@example.org', 'Carol', 'carol long password');
    const s = (await sign(c, 'VIENNA:B-01.1')).data;
    const data = structuredClone(s.data);
    data.officialSign.additional.top = [{ index: 1, reference: ['VIENNA:H-03.1'] }];
    const jur = Object.values(data.officialSign.designs[0].jurisdictions)[0];
    jur.additional.bottom = [{ index: 1, reference: ['VIENNA:H-01.1'] }, { index: 2, reference: ['VIENNA:H-08.1'] }];

    const csrf = c.csrf;
    c.csrf = null;
    assert.equal((await c.req('PUT', '/api/v1/signs/VIENNA:B-01.1', { data, version: s.version })).data.error.code, 'csrf_failed');
    c.csrf = csrf;

    const ok = await c.req('PUT', '/api/v1/signs/VIENNA:B-01.1', { data, version: s.version, comment: 'panels' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.version, 2);
    assert.deepEqual(ok.data.data.officialSign.additional.top, [{ index: 1, reference: ['VIENNA:H-03.1'] }]);

    const stale = await c.req('PUT', '/api/v1/signs/VIENNA:B-01.1', { data, version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.current_version, 2);

    const bad = structuredClone(data);
    bad.officialSign.additional.top.push({ index: 1, reference: [] });
    const v = await c.req('PUT', '/api/v1/signs/VIENNA:B-01.1', { data: bad, version: 2 });
    assert.equal(v.status, 422);
    assert.ok(v.data.error.details.some((d) => d.message.includes('same index')));

    const renamed = { ...structuredClone(data), reference: 'VIENNA:B-01.9' };
    assert.equal((await c.req('PUT', '/api/v1/signs/VIENNA:B-01.1', { data: renamed, version: 2 })).data.error.code, 'reference_mismatch');

    const hist = await c.req('GET', '/api/v1/signs/VIENNA:B-01.1/revisions');
    assert.deepEqual(hist.data.revisions.map((r) => r.action), ['update', 'import']);

    assert.equal((await c.req('POST', '/api/v1/signs/VIENNA:B-01.1/revert', { version: 2, to_version: 1 })).status, 403);
    const m = new Client();
    await m.req('POST', '/api/v1/auth/login', { email: 'mod@example.org', password: 'moderator-password-1' });
    const rev = await m.req('POST', '/api/v1/signs/VIENNA:B-01.1/revert', { version: 2, to_version: 1 });
    assert.equal(rev.status, 200);
    assert.equal(rev.data.version, 3);
    assert.deepEqual(rev.data.data.officialSign.additional.top, []);
  });

  test('create, delete and restore', async () => {
    const c = new Client();
    await signUp(c, 'dave@example.org', 'Dave', 'dave long password');
    const entry = structuredClone(fixture.find((x) => x.reference === 'OTHER:A27'));
    entry.reference = 'OTHER:A27-test';
    const created = await c.req('POST', '/api/v1/signs', { data: entry, comment: 'new' });
    assert.equal(created.status, 201);
    assert.equal((await c.req('POST', '/api/v1/signs', { data: entry })).status, 409);
    assert.equal((await c.req('DELETE', '/api/v1/signs/OTHER:A27-test', { version: 1 })).status, 403);
    const m = new Client();
    await m.req('POST', '/api/v1/auth/login', { email: 'mod@example.org', password: 'moderator-password-1' });
    assert.equal((await m.req('DELETE', '/api/v1/signs/OTHER:A27-test', { version: 1, comment: 'test' })).data.deleted, true);
    assert.equal((await c.req('GET', '/api/v1/signs?q=a27-test')).data.total, 0);
    assert.equal((await m.req('POST', '/api/v1/signs/OTHER:A27-test/restore', { version: 2 })).data.deleted, false);
  });

  test('compare: matrix filtered by category and countries', async () => {
    const c = new Client();
    const r = await c.req('GET', '/api/v1/compare?category=B&countries=belgium,france,nowhere');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.columns.map((x) => x.key), ['belgium', 'france']);
    const row = r.data.items.find((i) => i.reference === 'VIENNA:B-01.1');
    assert.deepEqual(row.cells.belgium.codes.slice(0, 1), ['be:B1']);
    assert.equal(row.cells.belgium.image, '/media/be_belgium/b_priority_signs/vienna/BE-B1.svg');
    assert.ok(row.cells.belgium.design_label.includes('inverted_triangle'));
    assert.equal((await c.req('GET', '/api/v1/compare?countries=a;b')).status, 400);
    const none = await c.req('GET', '/api/v1/compare?category=C&countries=belgium&kind=other');
    assert.equal(none.data.total, 0);
  });

  test('per-country editing: update, move to another design, new design, add, remove', async () => {
    const c = new Client();
    await signUp(c, 'frank@example.org', 'Frank', 'frank long password');
    const url = '/api/v1/signs/VIENNA%3AC-14.1/countries/';
    const v0 = (await c.req('GET', `${url}france`)).data;
    assert.equal(v0.variants.length, 1);
    assert.ok(v0.designs.length >= 2);
    assert.ok(v0.suggestions.languages.includes('fr'));

    // 1. change the text only
    const data = structuredClone(v0.variants[0].data);
    Object.values(data.languages)[0].text = 'Vitesse maximale';
    const from = v0.variants[0].design;
    let r = await c.req('PUT', `${url}france`, { version: v0.version, variants: [{ design: from, data }] });
    assert.equal(r.status, 200);
    assert.equal(Object.values(r.data.variants[0].data.languages)[0].text, 'Vitesse maximale');
    const others = (await sign(c, 'VIENNA:C-14.1')).data.data.officialSign.designs.map((d) => Object.keys(d.jurisdictions));
    assert.ok(others[from].includes('belgium') || others.flat().includes('belgium'), 'other countries untouched');

    // 2. move to another existing design
    const to = r.data.designs.find((d) => d.index !== from).index;
    r = await c.req('PUT', `${url}france`, { version: r.data.version, variants: [{ design: to, data }] });
    assert.deepEqual(r.data.variants.map((x) => x.design), [to]);

    // 3. two variants, one on a brand-new design
    r = await c.req('PUT', `${url}france`, { version: r.data.version, variants: [{ design: to, data }, { design: { new: { shape: 'circle', background_color: 'yellow', border_color: 'red', symbol_color: 'black' } }, data }] });
    assert.equal(r.status, 200);
    assert.equal(r.data.variants.length, 2);
    assert.equal(r.data.designs.at(-1).props.background_color, 'yellow');

    // 4. invalid data is refused with the full path
    const bad = structuredClone(data);
    Object.values(bad.languages)[0].code = 'fr:NOT-IN-CODES';
    const v = await c.req('PUT', `${url}france`, { version: r.data.version, variants: [{ design: to, data: bad }] });
    assert.equal(v.status, 422);
    assert.match(v.data.error.details[0].path, /jurisdictions\.france\.languages/);

    // 5. add a country that had no entry, then remove it
    const add = await c.req('PUT', `${url}atlantis`, { version: r.data.version, variants: [{ design: 0, data: { countryCode: 'at', languages: { en: { code: 'at:ZZ1', codes: ['at:ZZ1'], text: null, description: null } }, additional: { top: [], bottom: [] }, osm: { traffic_sign: ['AT:ZZ1'] } } }] });
    assert.equal(add.status, 200);
    assert.equal((await c.req('GET', '/api/v1/signs?q=at:zz1')).data.total, 1);
    const rm = await c.req('PUT', `${url}atlantis`, { version: add.data.version, variants: [] });
    assert.deepEqual(rm.data.variants, []);

    // 6. stale version
    assert.equal((await c.req('PUT', `${url}france`, { version: 1, variants: [] })).status, 409);
    // 7. visitors cannot write
    assert.equal((await new Client().req('PUT', `${url}france`, { version: rm.data.version, variants: [] })).status, 401);
  });

  test('export returns the full_database.json format', async () => {
    const r = await new Client().req('GET', '/api/v1/export');
    const arr = r.data;
    assert.ok(arr.length >= 3);
    assert.ok(arr.every((e) => validateEntry(e).length === 0));
  });

  test('form posts are refused (JSON only)', async () => {
    const r = await new Client().req('POST', '/api/v1/auth/login', 'email=a&password=b', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
  });
});

describe('images and static files', () => {
  test('upload: unsafe SVG refused, valid PNG filed under the sign category', async () => {
    const c = new Client();
    await signUp(c, 'erin@example.org', 'Erin', 'erin long password');
    const evil = new FormData();
    evil.append('code', 'be:B1');
    evil.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>']), 'x.svg');
    assert.equal((await c.req('POST', '/api/v1/images', evil)).data.error.code, 'unsafe_svg');
    // a big photo is scaled down and converted to WebP, without its metadata
    const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
      .jpeg({ quality: 95 }).withExif({ IFD0: { Artist: 'someone' } }).toBuffer();
    const jpg = new FormData();
    jpg.append('code', 'be:B1');
    jpg.append('file', new Blob([photo]), 'x.jpg');
    const r = await c.req('POST', '/api/v1/images', jpg);
    assert.equal(r.status, 201);
    assert.equal(r.data.path, 'be_belgium/b_priority_signs/vienna/BE-B1.webp');
    assert.ok(r.data.bytes < r.data.original_bytes);
    const img = await fetch(base + r.data.url);
    assert.equal(img.headers.get('content-type'), 'image/webp');
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
    const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
    assert.deepEqual([meta.width, meta.height, meta.exif], [2000, 1333, undefined]);
    // a truncated file is refused
    const broken = new FormData();
    broken.append('code', 'be:B1');
    broken.append('file', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')]), 'x.png');
    assert.equal((await c.req('POST', '/api/v1/images', broken)).data.error.code, 'unsupported_image');
    // SVG: editor data and comments are dropped
    const svg = new FormData();
    svg.append('code', 'be:B1');
    svg.append('file', new Blob(['<?xml version="1.0"?>\n<!-- made with Inkscape -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:version="1.3">\n  <metadata><x/></metadata>\n  <rect width="10" height="10" inkscape:label="r"/>\n</svg>\n']), 'x.svg');
    const rs = await c.req('POST', '/api/v1/images', svg);
    assert.equal(await (await fetch(base + rs.data.url)).text(), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  });
  test('a code "sign+panel" without its own picture shows the two pictures stacked', async () => {
    const r = await new Client().req('GET', `/api/v1/images?code=${encodeURIComponent('be:B1+M2')}`);
    assert.deepEqual(r.data.images, ['/media/%40stack/be%3AB1%2BM2.svg']);
    const img = await fetch(base + r.data.images[0]);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
    const body = await img.text();
    assert.equal(body.match(/<image /g).length, 2);
    assert.match(body, /data:image\/svg\+xml;base64,/);
    assert.equal((await new Client().req('GET', `/api/v1/images?code=${encodeURIComponent('be:B1+NOPE')}`)).data.images.length, 0);
  });
  test('official Vienna models: listed on the sign, used as thumbnail, served sandboxed', async () => {
    const s = (await sign(new Client(), 'VIENNA:B-01.1')).data;
    // named after the design labels of full_database.json; files that do not follow the scheme are ignored
    assert.deepEqual(s.vienna_images.map((i) => i.name).sort(),
      ['B-01.1_circle_green_none_white.svg', 'B-01.1_inverted-triangle_white_red_none.svg', 'B-01.1_inverted-triangle_yellow_red_none.svg']);
    const byName = Object.fromEntries(s.vienna_images.map((i) => [i.name, i]));
    assert.deepEqual(byName['B-01.1_inverted-triangle_white_red_none.svg'].designs, [0]);
    assert.deepEqual(byName['B-01.1_inverted-triangle_yellow_red_none.svg'].designs, [1]);
    assert.deepEqual(byName['B-01.1_circle_green_none_white.svg'].designs, []);
    assert.equal(byName['B-01.1_inverted-triangle_yellow_red_none.svg'].labels.background_color, 'yellow');
    const list = (await new Client().req('GET', '/api/v1/signs?q=give%20way')).data;
    assert.equal(list.items[0].thumbnail.official, true);
    const img = await fetch(base + s.vienna_images[0].url);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await fetch(`${base}/vienna-media/..%2F..%2Ftest.sqlite3`)).status, 404);
  });
  test('path traversal is impossible', async () => {
    for (const p of ['/media/..%2F..%2Ftest.sqlite3', '/media/%2e%2e/%2e%2e/etc/passwd.svg', '/..%2F..%2Fpackage.json']) {
      const r = await fetch(base + p);
      assert.notEqual(r.status, 200, p);
    }
  });
  test('front-end is served with a strict CSP', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });
});

describe('national signs (units) and additional panels', () => {
  const unit = (ref, loc, jur) => `/api/v1/signs/${encodeURIComponent(ref)}/units/${loc}/${jur}`;
  const be = (code) => ({ countryCode: 'be', languages: { fr: { code, codes: [code], text: null, description: null } }, additional: { top: [], bottom: [] }, osm: { traffic_sign: [] } });
  let c;

  test('read a unit: data, places it can go, Convention panels', async () => {
    c = new Client();
    await signUp(c, 'una@example.org', 'Una', 'una long password');
    const v = (await c.req('GET', unit('VIENNA:B-01.1', 'd0', 'belgium'))).data;
    assert.equal(v.exists, true);
    assert.equal(v.data.countryCode, 'be');
    assert.deepEqual(v.locations.map((l) => l.loc), ['d0', 'd1', 'r0']);
    assert.deepEqual(v.convention_panels.bottom[0].reference, ['VIENNA:H-01.1', 'VIENNA:H-08.1']);
    const empty = (await c.req('GET', unit('VIENNA:B-01.1', 'd1', 'belgium'))).data;
    assert.equal(empty.exists, false);
    assert.equal((await c.req('GET', unit('VIENNA:B-01.1', 'd9', 'belgium'))).status, 404);
    assert.equal((await c.req('GET', unit('VIENNA:B-01.1', 'x1', 'belgium'))).status, 400);
  });

  test('panels: list per country, checks, refused on save when invalid', async () => {
    const panel = structuredClone(fixture.find((x) => x.reference === 'OTHER:A27'));
    Object.assign(panel, { reference: 'OTHER:HTEST', category: 'OTHER-H', name: { en: 'Distance panel' } });
    panel.officialSign.designs[0].jurisdictions = { belgium: be('be:M2') };
    assert.equal((await c.req('POST', '/api/v1/signs', { data: panel })).status, 201);

    const list = (await c.req('GET', '/api/v1/panels?country=be')).data.items;
    assert.ok(list.some((p) => p.value === 'be:M2' && p.national));
    assert.ok(!(await c.req('GET', '/api/v1/panels?country=fr')).data.items.some((p) => p.value === 'be:M2'));

    const chk = (await c.req('POST', '/api/v1/panels/check', {
      reference: 'VIENNA:B-01.1', country_code: 'be', additional: { bottom: [{ index: 1, reference: ['be:M2', 'be:NOPE', 'fr:B14'] }] },
    })).data;
    assert.equal(chk.ok, false);
    assert.deepEqual(chk.checks.map((x) => x.level), ['warning', 'error', 'error']); // be:M2 not in the Convention's list for B-01.1
    assert.match(chk.checks[2].message, /another country/);

    const v = (await c.req('GET', unit('VIENNA:B-01.1', 'd0', 'belgium'))).data;
    const data = structuredClone(v.data);
    data.additional.bottom = [{ index: 1, reference: ['be:NOPE'] }];
    const bad = await c.req('PUT', unit('VIENNA:B-01.1', 'd0', 'belgium'), { version: v.version, data });
    assert.equal(bad.status, 422);
    assert.equal(bad.data.error.code, 'invalid_panels');
    assert.match(bad.data.error.details[0].path, /designs\[0\]\.jurisdictions\.belgium\.additional\.bottom\[0\]\.reference\[0\]/);

    data.additional.bottom = [{ index: 1, reference: ['be:M2'] }];
    const ok = await c.req('PUT', unit('VIENNA:B-01.1', 'd0', 'belgium'), { version: v.version, data });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data.data.additional.bottom[0].reference, ['be:M2']);
    assert.equal(ok.data.panel_checks[0].level, 'warning');
    assert.equal((await c.req('PUT', unit('VIENNA:B-01.1', 'd0', 'belgium'), { version: v.version, data })).status, 409, 'stale version');
    assert.equal((await new Client().req('PUT', unit('VIENNA:B-01.1', 'd0', 'belgium'), { version: ok.data.version, data })).status, 401);
  });

  test('move a unit within the sign, to a related sign and to another sign; remove it', async () => {
    let v = (await c.req('GET', unit('VIENNA:B-01.1', 'd0', 'belgium'))).data;
    let r = await c.req('POST', `${unit('VIENNA:B-01.1', 'd0', 'belgium')}/move`, { version: v.version, to: { loc: 'd1' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.target.exists, true);
    assert.equal(r.data.target.data.additional.bottom[0].reference[0], 'be:M2', 'panels move with the sign');
    assert.equal((await c.req('GET', unit('VIENNA:B-01.1', 'd0', 'belgium'))).data.exists, false);
    assert.equal((await c.req('POST', `${unit('VIENNA:B-01.1', 'd1', 'belgium')}/move`, { version: r.data.version, to: { loc: 'd1' } })).status, 400);
    // a country already present at the target is refused
    assert.equal((await c.req('POST', `${unit('VIENNA:B-01.1', 'd1', 'belgium')}/move`, { version: r.data.version, to: { reference: 'VIENNA:C-14.1', loc: 'd0' } })).status, 409);

    // the related sign already has a Belgian sign
    assert.equal((await c.req('POST', `${unit('VIENNA:B-01.1', 'd1', 'belgium')}/move`, { version: r.data.version, to: { loc: 'r0' } })).status, 409);
    const nor = await c.req('POST', `${unit('VIENNA:B-01.1', 'd0', 'norway')}/move`, { version: r.data.version, to: { loc: 'r0' } });
    assert.equal(nor.status, 200);
    v = (await sign(c, 'VIENNA:B-01.1')).data;
    assert.ok(v.data.relatedSigns[0].jurisdictions.norway);
    assert.ok(!v.data.officialSign.designs[0].jurisdictions.norway);

    r = await c.req('POST', `${unit('VIENNA:B-01.1', 'd1', 'belgium')}/move`, { version: v.version, to: { reference: 'VIENNA:C-14.1', loc: 'd2' } });
    assert.equal(r.status, 200);
    assert.ok((await sign(c, 'VIENNA:C-14.1')).data.data.officialSign.designs[2].jurisdictions.belgium);
    assert.ok(!(await sign(c, 'VIENNA:B-01.1')).data.data.officialSign.designs[1].jurisdictions.belgium);
    const hist = (await c.req('GET', '/api/v1/signs/VIENNA%3AC-14.1/revisions')).data.revisions[0];
    assert.match(hist.comment, /moved from VIENNA:B-01\.1/);

    const t = (await sign(c, 'VIENNA:C-14.1')).data;
    const del = await c.req('DELETE', unit('VIENNA:C-14.1', 'd2', 'belgium'), { version: t.version });
    assert.equal(del.status, 200);
    assert.ok(!(await sign(c, 'VIENNA:C-14.1')).data.data.officialSign.designs[2].jurisdictions.belgium);
  });
});

describe('account deletion, robots and backups', () => {
  test('a robot filling the hidden field gets the usual answer and no email', async () => {
    const before = mails.length;
    const r = await new Client().req('POST', '/api/v1/auth/register', { email: 'bot@example.org', display_name: 'Bot', website: 'http://spam' });
    assert.equal(r.status, 202);
    assert.equal(mails.length, before);
    assert.equal(db.prepare('SELECT 1 FROM users WHERE email=?').get('bot@example.org'), undefined);
  });

  test('backups hold only the changes since the previous one, and restore them', async () => {
    const first = runBackup(db, config); // everything done by the tests so far
    assert.ok(first.file && first.revisions > 0);
    assert.equal(runBackup(db, config).file, null); // nothing new
    const c = new Client();
    await signUp(c, 'zoe@example.org', 'Zoe', 'zoe long password!');
    const s = (await sign(c, 'VIENNA:B-01.1')).data;
    s.data.name = { ...s.data.name, en: 'Give way (backup test)' };
    assert.equal((await c.req('PUT', '/api/v1/signs/VIENNA%3AB-01.1', { data: s.data, version: s.version })).status, 200);
    const second = runBackup(db, config);
    assert.deepEqual([second.revisions, second.users], [1, 1]);

    // a fresh database with only the imported signs gets the edit, its author and the uploads back
    const other = openDatabase(path.join(tmp, 'restored.sqlite3'));
    const ts = now();
    for (const e of fixture) {
      storeSign(other, e, { version: 1, userId: null, ts, insert: true });
      addRevision(other, { reference: e.reference, version: 1, action: 'import', entry: e, ts });
    }
    const files = fs.readdirSync(config.backupDir).map((f) => path.join(config.backupDir, f));
    const r = restoreBackups(other, config, files);
    assert.ok(r.revisions > 1 && r.users >= 1);
    const row = other.prepare('SELECT data, version FROM signs WHERE reference=?').get('VIENNA:B-01.1');
    assert.equal(JSON.parse(row.data).name.en, 'Give way (backup test)');
    assert.equal(row.version, s.version + 1);
    assert.equal(other.prepare('SELECT password_hash FROM users WHERE email=?').get('zoe@example.org').password_hash, '');
    assert.deepEqual(restoreBackups(other, config, files), { revisions: 0, images: 0, users: 0 }); // idempotent
    other.close();
  });

  test('deleting one\'s account keeps the edits without the name; the last admin cannot', async () => {
    const c = new Client();
    await c.req('POST', '/api/v1/auth/login', { email: 'zoe@example.org', password: 'zoe long password!' });
    const id = (await c.req('GET', '/api/v1/auth/me')).data.user.id;
    assert.equal((await c.req('DELETE', '/api/v1/auth/me', { password: 'wrong password' })).data.error.code, 'invalid_credentials');
    const r = await c.req('DELETE', '/api/v1/auth/me', { password: 'zoe long password!' });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT 1 FROM users WHERE id=?').get(id), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE user_id=?').get(id).n, 0);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE user_id IS NULL AND action='update'").get().n > 0);
    assert.equal((await c.req('GET', '/api/v1/auth/me')).data.user, null);
    // the only administrator
    db.prepare('INSERT INTO users (email, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
      .run('boss@example.org', 'Boss', await hashPassword('boss long password'), 'admin', now());
    const a = new Client();
    await a.req('POST', '/api/v1/auth/login', { email: 'boss@example.org', password: 'boss long password' });
    assert.equal((await a.req('DELETE', '/api/v1/auth/me', { password: 'boss long password' })).data.error.code, 'last_admin');
  });
});

describe('wikidata', () => {
  test('editors look an ID up and save it on the sign or a design', async () => {
    assert.equal((await new Client().req('GET', '/api/v1/wikidata/Q42')).status, 401); // not a public proxy
    const c = new Client();
    await signUp(c, 'wiki@example.org', 'Wiki', 'wiki long password');
    const r = await c.req('GET', '/api/v1/wikidata/q42?lang=fr');
    assert.deepEqual(r.data, { id: 'Q42', label: 'cédez le passage', description: 'traffic sign', url: 'https://www.wikidata.org/wiki/Q42' });
    assert.equal((await c.req('GET', '/api/v1/wikidata/Q999')).data.error.code, 'wikidata_not_found');
    assert.equal((await c.req('GET', '/api/v1/wikidata/hello')).data.error.code, 'invalid_wikidata');

    const s = (await sign(c, 'VIENNA:B-01.1')).data;
    const data = structuredClone(s.data);
    data.wikidata = 'Q42';
    data.officialSign.designs[0].wikidata = 'Q43';
    const put = await c.req('PUT', '/api/v1/signs/VIENNA%3AB-01.1', { data, version: s.version, comment: 'Wikidata (sign): Q42' });
    assert.equal(put.status, 200);
    const after = (await sign(c, 'VIENNA:B-01.1')).data.data;
    assert.deepEqual([after.wikidata, after.officialSign.designs[0].wikidata], ['Q42', 'Q43']);
    data.wikidata = 'Q12x';
    assert.equal((await c.req('PUT', '/api/v1/signs/VIENNA%3AB-01.1', { data, version: s.version + 1 })).status, 422); // schema: Q + digits
  });
});

describe('daily email cap', () => {
  test('once the cap is reached: same refusal for every address, no account created, forms warned', async () => {
    const c = new Client();
    assert.equal((await c.req('GET', '/api/v1/auth/mail-status')).data.available, true);
    const sentSoFar = db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE bucket='mail-day'").get().n;
    assert.ok(sentSoFar > 0); // every email sent by the earlier tests was counted
    const saved = config.mailDailyLimit;
    config.mailDailyLimit = sentSoFar;
    try {
      assert.equal((await c.req('GET', '/api/v1/auth/mail-status')).data.available, false);
      const before = mails.length;
      const r = await c.req('POST', '/api/v1/auth/register', { email: 'late@example.org', display_name: 'Late' });
      assert.equal(r.status, 503);
      assert.equal(r.data.error.code, 'mail_quota_reached');
      assert.equal(db.prepare('SELECT 1 FROM users WHERE email=?').get('late@example.org'), undefined);
      // known and unknown addresses get exactly the same answer
      const known = await c.req('POST', '/api/v1/auth/forgot-password', { email: 'alice@example.org' });
      const unknown = await c.req('POST', '/api/v1/auth/forgot-password', { email: 'nobody@example.org' });
      assert.deepEqual([known.status, known.data], [unknown.status, unknown.data]);
      assert.equal(mails.length, before);
    } finally {
      config.mailDailyLimit = saved;
    }
    assert.equal((await c.req('GET', '/api/v1/auth/mail-status')).data.available, true);
  });
});

describe('flags', () => {
  test('a country flag, its country\'s flag for a subdivision, 404 otherwise', async () => {
    const fr = await fetch(`${base}/flags/fr.svg`);
    assert.equal(fr.status, 200);
    assert.match(fr.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(fr.headers.get('content-security-policy'), /sandbox/);
    const on = await (await fetch(`${base}/flags/ca-on.svg`)).text();
    assert.equal(on, await (await fetch(`${base}/flags/ca.svg`)).text());
    assert.equal((await fetch(`${base}/flags/zz.svg`)).status, 404);
    assert.equal((await fetch(`${base}/flags/..%2Fpackage.svg`)).status, 404);
  });
});

describe('pace of API clients', () => {
  test('scripts get one request per second; the site\'s own pages are not counted', async () => {
    const saved = config.apiRatePerSecond;
    config.apiRatePerSecond = 1;
    try {
      // a script (no Sec-Fetch-Site header), by IP
      assert.equal((await fetch(`${base}/api/v1/meta/vocabularies`)).status, 200);
      const second = await fetch(`${base}/api/v1/meta/vocabularies`);
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error.code, 'too_many_requests');
      assert.equal(second.headers.get('retry-after'), '1');
      assert.equal(second.headers.get('ratelimit-policy'), '1;w=1');
      // the site's pages: the browser marks them same-origin
      const page = { headers: { 'Sec-Fetch-Site': 'same-origin' } };
      for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/api/v1/meta/vocabularies`, page)).status, 200);
      // images and the front-end are not paced
      assert.equal((await fetch(`${base}/flags/fr.svg`)).status, 200);
      // a second later, the script may call again
      await new Promise((r) => setTimeout(r, 1050));
      assert.equal((await fetch(`${base}/api/v1/meta/vocabularies`)).status, 200);
    } finally {
      config.apiRatePerSecond = saved;
    }
  });
});

describe('missing pictures from Wikimedia', () => {
  test('downloads, checks, files and records them; failures wait before a retry', async () => {
    // a sign whose Belgian version has a Commons link but no picture yet
    const e = structuredClone(fixture.find((x) => x.reference === 'VIENNA:B-01.1'));
    e.reference = 'OTHER:B9001';
    e.category = 'OTHER-B';
    e.officialSign.designs = [e.officialSign.designs[0]];
    const jur = Object.values(e.officialSign.designs[0].jurisdictions)[0];
    for (const l of Object.values(jur.languages)) { l.code = 'be:B901'; l.codes = ['be:B901']; }
    jur.sources = [{ file: 'x', url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Belgian_road_sign_B901.svg' }];
    e.relatedSigns = [{ ...structuredClone(e.officialSign.designs[0]), reference: 'be:B902', name: { en: 'x' } }];
    const rel = Object.values(e.relatedSigns[0].jurisdictions)[0];
    for (const l of Object.values(rel.languages)) { l.code = 'be:B902'; l.codes = ['be:B902']; }
    rel.sources = [{ file: 'y', url: 'https://example.org/not-commons.svg' }];
    storeSign(db, e, { version: 1, userId: null, ts: now(), insert: true });
    assert.deepEqual(missingImages(db, app.images).map((m) => m.code).filter((c) => c.startsWith('be:B90')), ['be:B901']); // only Commons links

    const realFetch = globalThis.fetch;
    const asked = [];
    globalThis.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://upload.wikimedia.org/')) return realFetch(url, opts);
      asked.push({ url: String(url), ua: opts.headers['User-Agent'] });
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!-- c --><rect width="10" height="10"/></svg>',
        { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    };
    try {
      const r = await fetchMissingImages({ db, images: app.images, config });
      assert.ok(r.done >= 1);
      assert.match(asked[0].ua, /^Panomatix\//);
      const hit = app.images.lookup('be:B901');
      assert.equal(hit.length, 1);
      assert.match(hit[0], /^be_belgium\/.+\/other\/BE-B901\.svg$/);
      assert.equal(db.prepare("SELECT status FROM image_fetches WHERE code='be:B901'").get().status, 'ok');
      assert.ok(db.prepare("SELECT 1 FROM images WHERE code='be:B901'").get()); // carried by the backups
      // nothing left to do for it
      assert.ok(!missingImages(db, app.images).some((m) => m.code === 'be:B901'));
      // a failure is recorded and not retried before the delay
      globalThis.fetch = async () => new Response('nope', { status: 404 });
      e.reference = 'OTHER:B9003';
      for (const l of Object.values(jur.languages)) { l.code = 'be:B903'; l.codes = ['be:B903']; }
      e.relatedSigns = [];
      storeSign(db, e, { version: 1, userId: null, ts: now(), insert: true });
      const r2 = await fetchMissingImages({ db, images: app.images, config });
      assert.equal(db.prepare("SELECT status FROM image_fetches WHERE code='be:B903'").get().status, 'failed');
      assert.ok(r2.failed >= 1);
      const r3 = await fetchMissingImages({ db, images: app.images, config });
      assert.equal(r3.done + r3.failed, 0);
    } finally {
      globalThis.fetch = realFetch;
      db.prepare("DELETE FROM signs WHERE reference IN ('OTHER:B9001','OTHER:B9003')").run();
    }
  });
});

describe('empty designs of signs outside the Convention', () => {
  test('the design an OTHER sign\'s last country leaves is removed; Convention designs stay', async () => {
    const c = new Client();
    await signUp(c, 'pruner@example.org', 'Pruner', 'pruner long password');
    const base0 = structuredClone(fixture.find((x) => x.reference === 'VIENNA:B-01.1'));
    const d0 = base0.officialSign.designs[0];
    const [jk, jur] = Object.entries(d0.jurisdictions)[0];
    const e = structuredClone(base0);
    e.reference = 'OTHER:B9100';
    e.category = 'OTHER-B';
    e.relatedSigns = [];
    // three designs, one country each
    e.officialSign.designs = [0, 1, 2].map((n) => ({ ...structuredClone(d0), jurisdictions: { [`${jk}${n}`]: structuredClone(jur) } }));
    storeSign(db, e, { version: 1, userId: null, ts: now(), insert: true });
    const read = async () => (await sign(c, 'OTHER:B9100')).data;
    // removing the only country of design 1 removes design 1
    let s = await read();
    let r = await c.req('DELETE', `/api/v1/signs/OTHER%3AB9100/units/d1/${jk}1`, { version: s.version });
    assert.equal(r.status, 200);
    s = await read();
    assert.deepEqual(s.data.officialSign.designs.map((d) => Object.keys(d.jurisdictions)), [[`${jk}0`], [`${jk}2`]]);
    // moving design 0's only country into the last design: design 0 goes, the answer points at the new index
    r = await c.req('POST', `/api/v1/signs/OTHER%3AB9100/units/d0/${jk}0/move`, { version: s.version, to: { loc: 'd1' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.loc, 'd0');
    s = await read();
    assert.deepEqual(s.data.officialSign.designs.map((d) => Object.keys(d.jurisdictions).sort()), [[`${jk}0`, `${jk}2`]]);
    const hist = (await c.req('GET', '/api/v1/signs/OTHER%3AB9100/revisions')).data;
    assert.ok(JSON.stringify(hist).includes('empty design 1 removed'));
    // a Convention design keeps living without any country
    const v = (await sign(c, 'VIENNA:B-01.1')).data;
    const vd = Object.keys(v.data.officialSign.designs[1]?.jurisdictions ?? {});
    if (vd.length === 1) {
      const rv = await c.req('DELETE', `/api/v1/signs/VIENNA%3AB-01.1/units/d1/${vd[0]}`, { version: v.version });
      assert.equal(rv.status, 200);
      assert.equal((await sign(c, 'VIENNA:B-01.1')).data.data.officialSign.designs.length, v.data.officialSign.designs.length);
    }
    db.prepare("DELETE FROM signs WHERE reference='OTHER:B9100'").run();
  });
});
