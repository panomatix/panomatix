# Panomatix website

Collaborative editor and REST API for `full_database.json`. Anyone can create an account (email, then a
password chosen from the confirmation link sent by email) and edit every field of a sign. Every change is versioned and can be reverted.

A sign page shows the sign and its ID (the rest behind **More information**), then its designs and its related
signs as tabs. Each tab lists the national signs as tiles with three actions: **Info**, **Move** (to another
design, related sign or sign — codes, texts and panels move along) and **Edit** (that national sign only: code,
image, texts, parameters, OSM tags, sources and its additional panels). Panels (*panonceaux*) are picked from
the country's own panels or the Convention's, and each one is checked: it must exist and belong to that country
or to the Convention (otherwise the save is refused); a panel outside category H, or not in the Convention's list
for the sign, is flagged as a warning. The full JSON editor stays available for everything else.

- **Back end:** Node.js ≥ 24.7 — `node:http`, `node:sqlite`, `node:crypto` (argon2id); three npm dependencies,
  all European: [Nodemailer](https://nodemailer.com) (Andris Reinman, Estonia; MIT-0) to send email,
  [sharp](https://sharp.pixelplumbing.com) (Lovell Fuller, UK; libvips; Apache-2.0) to compress images and
  [flag-icons](https://flagicons.lipis.dev) (Panayiotis Lipiridis, Greece; MIT) for the country flags, served by
  the site itself at `/flags/<code>.svg` (a region without a flag of its own, such as `ca-on`, gets its country's).
- **Front end:** plain HTML, CSS and JavaScript modules, no build step, served by the same process.
- **Interface languages:** English and French in full; German and Spanish partially (missing strings fall back to English).
  Add a language in [`public/js/i18n.js`](public/js/i18n.js).

## Run it

```sh
cd website
npm install                        # Nodemailer, sharp, flag-icons
npm run import                     # load ../full_database.json into data/panomatix.sqlite3 (≈ 5 s)
npm run create-user -- admin@example.org "Admin" admin   # prompts for the password
npm run dev                        # http://127.0.0.1:8080, plain-HTTP cookies allowed, emails printed on the console
npm test                           # API test suite
```

`npm start` runs in production mode: session cookies are `Secure`, so put it behind HTTPS, and set
`PANOMATIX_PUBLIC_URL` and `PANOMATIX_SMTP_URL` so the account emails are sent with the right links.

## Accounts by email

1. **Sign up** (`#/register`): display name + email. The account is created without a password and a link is
   emailed (valid 24 h). Signing up with an address that already has an account sends its owner a reset link
   instead; the page says the same thing in both cases, so it cannot be used to find out who is registered.
2. **The link** opens `#/set-password?token=…`: the user types the password twice; it confirms the address,
   sets the password and signs them in. A link works once; asking for a new one cancels the previous one.
3. **Forgot password** (`#/forgot-password`, linked from the sign-in page): same link, valid 1 h. Resetting
   signs out every other session.

The password page has a **Generate** button (32 random characters from the browser's cryptographic
generator, shown so it can be copied into a password manager) and warns not to reuse a password from
another site. **Delete my account** (account page, password required) erases the email, name and password;
the person's edits stay in the history without their name. The only administrator cannot delete themselves.

**Daily email cap.** Every email of the site counts toward `PANOMATIX_MAIL_DAILY_LIMIT` (300 per 24 h by
default, the quota of Brevo's free plan). Once reached, sign-up and *forgot password* answer `503
mail_quota_reached` until emails drop out of the 24-hour window, without creating an account; both forms say so
before anyone fills them in (`GET /api/v1/auth/mail-status`). The cap is checked before the address is looked up,
so a full quota never tells whether an address has an account. The server logs it once an hour while it lasts.

Against robots, the sign-up and reset forms carry a hidden *honeypot* field: a robot that fills it gets the
usual answer and nothing happens. Together with the email confirmation and the rate limits this is enough
for now; if spam accounts still appear, a self-hosted proof-of-work captcha (such as ALTCHA) is the next step
— no third-party captcha, which would track visitors.

Links are random 256-bit tokens stored hashed, like sessions, and always point to `PANOMATIX_PUBLIC_URL`
(never to the `Host` of the request). Emails are written in the interface language of the person asking
(English, French, German, Spanish). Sign-ups whose link is never opened are deleted after a week.

## Deploying

The production server runs Ubuntu with Nginx and Certbot; Panomatix gets its own Node.js 24 in
`/opt/node-24` (the system Node.js is left to other sites), a system user `panomatix`, the code in
`/opt/panomatix` (owned by root: the site cannot modify it) and its settings in `/etc/panomatix/app.env`.

1. DNS: an `A` record for the site's name pointing to the server.
2. Once, from this computer: `ssh -i ~/.ssh/key root@IP 'sh -s' < deploy/install-server.sh`
   (Node.js 24, user, clone, settings file, systemd unit, Nginx site, Let's Encrypt certificate;
   safe to re-run). Then put the SMTP account in `/etc/panomatix/app.env`.
3. Every update, from `website/`: `npm run deploy -- "Commit message"` (settings in the untracked
   `.env.deploy`). It runs the tests, commits, pushes the code to the server over SSH, ships the Node
   modules built here for the server's CPU when `package-lock.json` changed, backs up the changes,
   fast-forwards the code, restarts the service, pushes to GitHub and checks `/api/v1/health`.
   The server never contacts GitHub or npm after the first install.

Behind Nginx, `PANOMATIX_TRUST_PROXY=1` and `proxy_set_header X-Forwarded-For $remote_addr` go
together: the server only trusts the address added by the proxy.

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

## Images

- **Uploads are compressed** before being stored: bitmaps (PNG, JPEG, GIF, WebP) become WebP — lossless for
  drawings, quality 85 for photos — scaled down to 2000 px at most, with the EXIF orientation applied and
  the metadata (GPS position, camera…) removed; the original is kept when it is already smaller. SVGs lose
  their editor data, metadata and comments. Up to 20 MB are accepted before compression.
- **Sign + panel codes** (`fi:B5+H5`, `ca-on:Wa-30+Wa-30t`): when no picture shows the whole, the pictures
  of the parts are stacked one above the other (served as one SVG under `/media/@stack/<code>.svg`).

## Backups

Every week (`PANOMATIX_BACKUP_DAYS`) the server writes `backups/panomatix-changes-<date>.json.gz` holding
**only what changed since the previous backup**: the new revisions of the signs (full snapshots), the images
uploaded (with their content) and the accounts involved (email and name, never the password). Imports are
left out: `full_database.json` in git is the base. A week with no change writes no file.

```sh
npm run backup                                     # one now, outside the weekly schedule
npm run import -- --replace                        # rebuild: the base from git…
npm run restore -- backups/*.json.gz               # …then every change, oldest first (safe to re-run)
```

Restored accounts have no password: their owners use **Forgot your password?**. Copy `backups/` to
another machine (e.g. `rsync` in a cron job): a backup on the same disk does not survive the disk.
Old backups still hold the email of accounts deleted since; delete the files you no longer need.

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
  **admin** (roles, temporary passwords).

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
| `PANOMATIX_PUBLIC_URL` | `http://<host>:<port>` | address of the site, used in the emailed links (e.g. `https://panomatix.example.org`) |
| `PANOMATIX_SMTP_URL` | — | mail server, e.g. `smtps://user:password@smtp.example.org:465`; unset: emails are printed on the console |
| `PANOMATIX_MAIL_FROM` | `Panomatix <no-reply@localhost>` | sender of the emails |
| `PANOMATIX_VERIFY_HOURS` / `PANOMATIX_RESET_HOURS` | `24` / `1` | validity of the sign-up and reset links |
| `PANOMATIX_MAIL_LIMIT` | `3` | emails per address per hour |
| `PANOMATIX_MAIL_DAILY_LIMIT` | `300` | emails of the whole site per 24 h, to stay under the mail provider's quota (Brevo free plan: 300/day); `0` = no cap |
| `PANOMATIX_BACKUP_DIR` / `PANOMATIX_BACKUP_DAYS` | `website/backups` / `7` | incremental backups; `0` days turns them off |
| `PANOMATIX_MAX_IMAGE_BYTES` | `20971520` | largest upload, before compression |
| `PANOMATIX_SESSION_DAYS` / `PANOMATIX_TOKEN_DAYS` | `30` / `90` | |
| `PANOMATIX_LOGIN_LIMIT`, `_REGISTER_LIMIT`, `_UPLOAD_LIMIT`, `_EDIT_LIMIT` | `10`, `5`, `60`, `300` | rate limits |

Example reverse proxy (Caddy): `panomatix.example.org { reverse_proxy 127.0.0.1:8080 }` with
`PANOMATIX_TRUST_PROXY=1`.

## Not included yet

- One process only (SQLite + in-process image index): enough for a community site; scale-out would need a
  shared database.
