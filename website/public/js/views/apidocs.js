// API reference page (technical, English).
import { get } from '../api.js';
import { h } from '../dom.js';
import { t } from '../i18n.js';

const ENDPOINTS = [
  ['Accounts', [
    ['POST', '/api/v1/auth/register', '{email, display_name, lang?} → 202. Emails a link to choose the password (or, for a known address, a reset link). Same answer either way.'],
    ['POST', '/api/v1/auth/forgot-password', '{email, lang?} → 202. Emails a password reset link if the address has an account.'],
    ['POST', '/api/v1/auth/link', '{token} → {purpose: "verify"|"reset", email, display_name}, or 400 invalid_token.'],
    ['POST', '/api/v1/auth/set-password', '{token, password} — uses the emailed link once: sets the password, confirms the address, signs out other sessions and opens a cookie session.'],
    ['POST', '/api/v1/auth/login', '{email, password, mode?} — mode "cookie" (browser, returns csrf_token) or "token" (returns a Bearer token for scripts).'],
    ['POST', '/api/v1/auth/logout', 'Ends the current session.'],
    ['GET', '/api/v1/auth/me', 'Current user (or null) and CSRF token.'],
    ['PATCH', '/api/v1/auth/me', '{display_name}'],
    ['POST', '/api/v1/auth/password', '{current_password, new_password} — signs out every other session.'],
    ['DELETE', '/api/v1/auth/me', '{password} — deletes the account; its edits stay in the history without the name. 409 last_admin for the only administrator.'],
  ]],
  ['Signs', [
    ['GET', '/api/v1/signs', 'Search: q, category, country (code or jurisdiction key), kind (vienna|other), page, per_page (≤ 200).'],
    ['GET', '/api/v1/signs/{reference}', 'Full entry: {reference, version, data, images: {code: [urls]}, …}.'],
    ['POST', '/api/v1/signs', '{data, comment?} — create. The entry must follow the schema.'],
    ['PUT', '/api/v1/signs/{reference}', '{data, version, comment?} — replace. 409 edit_conflict if version is not the current one.'],
    ['DELETE', '/api/v1/signs/{reference}', '{version, comment?} — moderators. Soft delete, recorded in history.'],
    ['POST', '/api/v1/signs/{reference}/restore', '{version, comment?} — moderators.'],
    ['GET', '/api/v1/signs/{reference}/revisions', 'List of versions.'],
    ['GET', '/api/v1/signs/{reference}/revisions/{version}', 'Content of one version.'],
    ['POST', '/api/v1/signs/{reference}/revert', '{version, to_version, comment?} — moderators. Creates a new version.'],
    ['POST', '/api/v1/validate', '{data} → {valid, errors: [{path, message}], normalized}. No write.'],
    ['GET', '/api/v1/compare', 'Sign × country matrix: category, kind (vienna|other|all), countries (comma-separated jurisdiction keys), q, only_filled, page.'],
    ['GET', '/api/v1/changes', 'Recent changes: page, per_page, user.'],
    ['GET', '/api/v1/codes?q=', 'Autocomplete of national codes and references.'],
    ['GET', '/api/v1/export', 'Whole database in the full_database.json format.'],
  ]],
  ['National signs and panels', [
    ['GET', '/api/v1/signs/{reference}/units/{loc}/{country}', 'One national sign: loc = d<n> (design n, from 0) or r<n> (related sign n). Returns its data (a template if absent), the places it can move to, the Convention panels and the panel checks.'],
    ['PUT', '/api/v1/signs/{reference}/units/{loc}/{country}', '{version, data, comment?} — create or replace that national sign only. 422 invalid_panels if a panel cannot be added.'],
    ['DELETE', '/api/v1/signs/{reference}/units/{loc}/{country}', '{version, comment?} — remove it.'],
    ['POST', '/api/v1/signs/{reference}/units/{loc}/{country}/move', '{version, to: {reference?, loc}, comment?} — move it to another design or related sign, of this sign or another. 409 if the country is already there.'],
    ['GET', '/api/v1/panels?country=fr&q=', 'Panels a national sign of that country can carry: its national panels (H / OTHER-H) and the Convention ones (H).'],
    ['POST', '/api/v1/panels/check', '{reference, country_code, additional} → {ok, checks: [{position, slot, reference, level: ok|warning|error, message}]}. No write.'],
  ]],
  ['Images', [
    ['GET', '/api/v1/images?code=fr:B14', 'Images of a national code.'],
    ['POST', '/api/v1/images', 'multipart/form-data: file (SVG, PNG, JPEG, GIF, WebP ≤ 20 MB) + code. Compressed (bitmaps → WebP, ≤ 2000 px, metadata removed), then filed next to the sign that owns the code. Returns {path, url, bytes, original_bytes}.'],
    ['GET', '/media/{path}', 'Image files.'],
  ]],
  ['Reference data', [
    ['GET', '/api/v1/meta/schema', 'JSON Schema (2020-12) of an entry — every field, closed vocabularies included.'],
    ['GET', '/api/v1/meta/vocabularies', 'Shapes, colours, bands, panel positions, categories…'],
    ['GET', '/api/v1/meta/countries', 'Jurisdictions and country codes in use.'],
    ['GET', '/api/v1/meta/stats', 'Counters.'],
  ]],
  ['Administration', [
    ['GET', '/api/v1/users', 'Moderators.'],
    ['PATCH', '/api/v1/users/{id}', '{role?, is_active?} — role: administrators only.'],
    ['POST', '/api/v1/users/{id}/password', '{new_password} — administrators.'],
  ]],
];

export async function viewApiDocs() {
  const stats = await get('/api/v1/meta/stats');
  return h('section.page.apidocs', {},
    h('h1', {}, 'API'),
    h('div.stats', {},
      [['Vienna signs', stats.vienna], ['National signs', stats.national], ['Contributors', stats.contributors], ['Edits so far', stats.edits]]
        .map(([label, n]) => h('div.stat', {}, h('strong', {}, n.toLocaleString()), h('span', {}, t(label))))),
    h('p', {}, 'JSON over HTTPS. Errors are ', h('code', {}, '{"error": {"code", "message", "details?"}}'),
      '. Browser sessions use an HttpOnly cookie and must send the ', h('code', {}, 'X-CSRF-Token'),
      ' header on writes; scripts sign in with ', h('code', {}, '"mode": "token"'), ' and send ', h('code', {}, 'Authorization: Bearer <token>'), '.'),
    h('pre.code', {}, `curl -s -X POST https://<host>/api/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.org","password":"…","mode":"token"}'

curl -s https://<host>/api/v1/signs/VIENNA:B-01.1 -H 'Authorization: Bearer <token>'`),
    ENDPOINTS.map(([group, rows]) => h('section', {},
      h('h2', {}, group),
      h('table.list.api', {}, h('tbody', {}, rows.map(([m, p, d]) => h('tr', {},
        h('td', {}, h(`span.method.m-${m.toLowerCase()}`, {}, m)), h('td', {}, h('code', {}, p)), h('td', {}, d))))))),
    h('p', {}, h('a', { href: '/api/v1/meta/schema', target: '_blank' }, 'sign.schema.json')));
}
