# Panomatix website

Collaborative editor and REST API for `full_database.json`. Anyone can create an account (email + password)
and edit every field of a sign. Every change is versioned and can be reverted.

A sign page shows the sign and its ID (the rest behind **More information**), then its designs and its related
signs as tabs. Each tab lists the national signs as tiles with three actions: **Info**, **Move** (to another
design, related sign or sign — codes, texts and panels move along) and **Edit** (that national sign only: code,
image, texts, parameters, OSM tags, sources and its additional panels). Panels (*panonceaux*) are picked from
the country's own panels or the Convention's, and each one is checked: it must exist and belong to that country
or to the Convention (otherwise the save is refused); a panel outside category H, or not in the Convention's list
for the sign, is flagged as a warning. The full JSON editor stays available for everything else.

- **Back end:** Node.js ≥ 24.7, no npm dependency — `node:http`, `node:sqlite`, `node:crypto` (argon2id).
- **Front end:** plain HTML, CSS and JavaScript modules, no build step, served by the same process.
- **Interface languages:** English and French in full; German and Spanish partially (missing strings fall back to English).
  Add a language in [`public/js/i18n.js`](public/js/i18n.js).

## Run it

```sh
cd website
npm run import                     # load ../full_database.json into data/panomatix.sqlite3 (≈ 5 s)
npm run create-user -- admin@example.org "Admin" admin   # prompts for the password
npm run dev                        # http://127.0.0.1:8080, plain-HTTP cookies allowed
npm test                           # API test suite
```

`npm start` runs in production mode: session cookies are `Secure`, so put it behind HTTPS.

## Data flow

```
full_database.json ──import──▶ SQLite (one JSON document per sign + every revision) ──export──▶ full_database.json
                                   ▲
                          REST API /api/v1 ◀── browser UI, scripts (Bearer token)
```

- `npm run import [file] [--replace]` validates **every** entry before loading anything.
- `npm run export [file]` writes the current state back in the same format and order (deleted signs left out).
  Export, review the diff in git, commit.
- `GET /api/v1/export` serves the same file over HTTP.

The structure of an entry is defined once, in [`sign.schema.json`](sign.schema.json) (JSON Schema 2020-12):
every key found in the database, its type and its closed vocabularies (shapes, colours, band, bar, model…).
Unknown keys are rejected. On top of it the server checks that the category matches the reference, that
`code` appears in `codes`, that panel slots have distinct indexes and that parameter values match their type.
On import, every panel container gets both `top` and `bottom` slots (empty when unused) so panels can be added
above as well as below; `left` and `right` are kept only when used.

## API

Full list on the site at `#/api`. Main points:

| | |
|---|---|
| Read | `GET /api/v1/signs?q=&category=&country=&kind=&page=`, `GET /api/v1/signs/{reference}` |
| Write | `POST /api/v1/signs`, `PUT /api/v1/signs/{reference}` with the `version` you edited (409 on concurrent edit) |
| One national sign | `GET`/`PUT`/`DELETE /api/v1/signs/{reference}/units/{loc}/{country}` (`loc` = `d0`, `d1`… for a design, `r0`… for a related sign), `POST …/move` `{version, to: {reference?, loc}}` |
| Panels | `GET /api/v1/panels?country=fr&q=` (panels that country's signs can carry), `POST /api/v1/panels/check` (ok / warning / error per panel; errors refuse the save) |
| History | `GET …/revisions`, `GET …/revisions/{v}`, `POST …/revert` (moderators) |
| Check | `POST /api/v1/validate` — dry run, returns `[{path, message}]` |
| Images | `POST /api/v1/images` (multipart: `file`, `code`) — stored in `road_sign_images/<country>/<category>/<vienna|other>/` |
| Schema | `GET /api/v1/meta/schema`, `GET /api/v1/meta/vocabularies` |

Scripts sign in with `{"mode": "token"}` and send `Authorization: Bearer <token>`.

## Security

- Passwords hashed with argon2id (m = 19 MiB, t = 2); ≥ 10 characters; login rate-limited per email and per IP.
- Sessions: random 256-bit tokens stored **hashed**, HttpOnly + SameSite=Lax cookie, 30 days; changing the
  password signs out other devices; disabling a user revokes their sessions.
- CSRF: every cookie-authenticated write must echo the per-session `X-CSRF-Token`, and write endpoints only
  accept `application/json`.
- Strict Content-Security-Policy (no inline script), `X-Frame-Options: DENY`, `nosniff`, HSTS in production.
- The UI never inserts user data as HTML. Uploaded images are type-checked by content, SVGs with scripts,
  event handlers, entities or external references are refused, and every image is served with a sandboxing CSP.
- Roles: **contributor** (create/edit, upload), **moderator** (delete/restore, revert, disable contributors),
  **admin** (roles, password resets).

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `PANOMATIX_PORT` / `PANOMATIX_HOST` | `8080` / `127.0.0.1` | listen address |
| `PANOMATIX_DB` | `website/data/panomatix.sqlite3` | database file (back it up: `sqlite3 … ".backup x"`) |
| `PANOMATIX_IMAGES_DIR` | `../road_sign_images` | national sign images |
| `PANOMATIX_VIENNA_IMAGES_DIR` | `../vienna_convention_images` | official Vienna Convention illustrations, named after the design labels they show (`A-01.1_triangle_white_red_black.svg`) and shown on the matching design |
| `PANOMATIX_ENV` | `production` | `development` allows non-Secure cookies |
| `PANOMATIX_TRUST_PROXY` | `0` | `1` behind nginx/Caddy to read `X-Forwarded-For` |
| `PANOMATIX_REGISTRATION_OPEN` | `1` | `0` closes sign-ups |
| `PANOMATIX_SESSION_DAYS` / `PANOMATIX_TOKEN_DAYS` | `30` / `90` | |
| `PANOMATIX_LOGIN_LIMIT`, `_REGISTER_LIMIT`, `_UPLOAD_LIMIT`, `_EDIT_LIMIT` | `10`, `5`, `60`, `300` | rate limits |

Example reverse proxy (Caddy): `panomatix.example.org { reverse_proxy 127.0.0.1:8080 }` with
`PANOMATIX_TRUST_PROXY=1`.

## Not included yet

- **Email verification and password reset by email**: the server sends no mail. An administrator can set a
  temporary password from the Users page. Plugging in an SMTP service is the next step if open registration
  attracts spam.
- One process only (SQLite + in-process image index): enough for a community site; scale-out would need a
  shared database.
