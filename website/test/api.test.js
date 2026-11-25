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
import { normalizeEntry, validateEntry } from '../server/validation.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-test-'));
let server;
let base;
let db;

before(async () => {
  const imagesDir = path.join(tmp, 'images');
  fs.mkdirSync(path.join(imagesDir, 'be_belgium', 'b_priority_signs', 'vienna'), { recursive: true });
  fs.writeFileSync(path.join(imagesDir, 'be_belgium', 'b_priority_signs', 'vienna', 'BE-B1.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
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
  const config = loadConfig({ database: ':unused:', imagesDir, viennaImagesDir: viennaDir, cookieSecure: false, loginLimit: 5, registerLimit: 50 });
  const app = createApp({ config, db });
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
  test('register, me, logout', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/v1/auth/register', { email: 'Alice@Example.org', display_name: 'Alice', password: 'a long enough password' });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.email, 'alice@example.org');
    assert.equal(r.data.user.role, 'contributor');
    assert.match(r.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await c.req('GET', '/api/v1/auth/me')).data.user.display_name, 'Alice');
    assert.equal((await c.req('POST', '/api/v1/auth/logout')).status, 200);
    c.csrf = null;
    assert.equal((await c.req('GET', '/api/v1/auth/me')).data.user, null);
  });
  test('duplicate email, weak password and bad email are refused', async () => {
    const c = new Client();
    assert.equal((await c.req('POST', '/api/v1/auth/register', { email: 'alice@example.org', display_name: 'Al', password: 'another long password' })).status, 409);
    assert.equal((await c.req('POST', '/api/v1/auth/register', { email: 'bob@example.org', display_name: 'Bob', password: 'short' })).data.error.code, 'weak_password');
    assert.equal((await c.req('POST', '/api/v1/auth/register', { email: 'nope', display_name: 'Bob', password: 'a long enough password' })).data.error.code, 'invalid_email');
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
    await c.req('POST', '/api/v1/auth/register', { email: 'carol@example.org', display_name: 'Carol', password: 'carol long password' });
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
    await c.req('POST', '/api/v1/auth/register', { email: 'dave@example.org', display_name: 'Dave', password: 'dave long password' });
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
    await c.req('POST', '/api/v1/auth/register', { email: 'frank@example.org', display_name: 'Frank', password: 'frank long password' });
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
    await c.req('POST', '/api/v1/auth/register', { email: 'erin@example.org', display_name: 'Erin', password: 'erin long password' });
    const evil = new FormData();
    evil.append('code', 'be:B1');
    evil.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>']), 'x.svg');
    assert.equal((await c.req('POST', '/api/v1/images', evil)).data.error.code, 'unsafe_svg');
    const png = new FormData();
    png.append('code', 'be:B1');
    png.append('file', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')]), 'x.png');
    const r = await c.req('POST', '/api/v1/images', png);
    assert.equal(r.status, 201);
    assert.equal(r.data.path, 'be_belgium/b_priority_signs/vienna/BE-B1.png');
    const img = await fetch(base + r.data.url);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
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
    await c.req('POST', '/api/v1/auth/register', { email: 'una@example.org', display_name: 'Una', password: 'una long password' });
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
