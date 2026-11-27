#!/bin/sh
# First installation of Panomatix on the server (Ubuntu/Debian, as root). From this computer:
#
#   ssh -i ~/.ssh/my_key root@IP 'sh -s' < website/deploy/install-server.sh
#
# Safe to run again: every step already done is skipped. Leaves the other sites alone (Node.js 24 is
# installed on its own in /opt/node-24; Nginx gets one more site).
# Then, from this computer: npm run deploy (ships the Node modules and starts the site).
set -eu

DOMAIN=panomatix.tes-maker.eu
DIR=/opt/panomatix
REPO=https://github.com/tes-maker/panomatix.git
NODE_DIR=/opt/node-24
PORT=8080
USER_NAME=panomatix

[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }
say() { echo "▶ $*"; }

say "Packages (git, nginx, certbot, curl)…"
missing=""
for p in git nginx certbot python3-certbot-nginx curl xz-utils; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then apt-get install -y -q $missing >/dev/null; echo "  Installed:$missing"; else echo "  Already there."; fi

say "Node.js 24 in $NODE_DIR (the system Node.js is left unchanged)…"
if "$NODE_DIR/bin/node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=7)?0:1)' 2>/dev/null; then
  echo "  Already there: $("$NODE_DIR/bin/node" --version)"
else
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;; esac
  tmp=$(mktemp -d)
  base=https://nodejs.org/dist/latest-v24.x
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -o "node-v24[0-9.]*-linux-$arch.tar.xz" "$tmp/SHASUMS256.txt" | head -1)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || { echo "Node.js checksum mismatch." >&2; exit 1; }
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  echo "  Installed: $("$NODE_DIR/bin/node" --version) ($arch)"
fi

say "System user $USER_NAME…"
if id "$USER_NAME" >/dev/null 2>&1; then echo "  Already there."; else
  useradd --system --home "$DIR" --shell /usr/sbin/nologin "$USER_NAME"; echo "  Created."; fi

say "Code in $DIR…"
if [ -d "$DIR/.git" ]; then echo "  Already there: $(git -C "$DIR" log -1 --format='%h %s')"; else
  git clone -q "$REPO" "$DIR"; echo "  Cloned: $(git -C "$DIR" log -1 --format='%h %s')"; fi
install -d -o "$USER_NAME" -g "$USER_NAME" -m 750 "$DIR/website/data" "$DIR/website/backups"
chown -R "$USER_NAME:$USER_NAME" "$DIR/road_sign_images"

say "Settings /etc/panomatix/app.env…"
install -d -o root -g "$USER_NAME" -m 750 /etc/panomatix
if [ -f /etc/panomatix/app.env ]; then echo "  Already there (left unchanged)."; else
  cat > /etc/panomatix/app.env <<EOF
# Panomatix settings (see website/README.md). After a change: systemctl restart panomatix
PANOMATIX_HOST=127.0.0.1
PANOMATIX_PORT=$PORT
PANOMATIX_PUBLIC_URL=https://$DOMAIN
PANOMATIX_TRUST_PROXY=1
# Email (accounts, forgotten password), e.g. Brevo. Without these lines, emails are written to the
# log (journalctl -u panomatix) instead of being sent. Encode the login and key (@ becomes %40).
#PANOMATIX_SMTP_URL=smtp://LOGIN%40smtp-brevo.com:SMTP_KEY@smtp-relay.brevo.com:587
#PANOMATIX_MAIL_FROM=Panomatix <no-reply@tes-maker.eu>
#PANOMATIX_MAIL_DAILY_LIMIT=300
EOF
  chown root:"$USER_NAME" /etc/panomatix/app.env && chmod 640 /etc/panomatix/app.env
  echo "  Created: add the SMTP account to it."
fi

say "Port $PORT…"
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet panomatix; then
  echo "  ✗ Port $PORT is already used by another program: change PANOMATIX_PORT and proxy_pass." >&2; exit 1
fi
echo "  Free."

say "systemd service…"
# (Files written right here: the script does not depend on the version of the cloned code.)
cat > /etc/systemd/system/panomatix.service <<'EOF'
[Unit]
Description=Panomatix — collaborative road sign database
After=network.target

[Service]
Type=simple
User=panomatix
Group=panomatix
WorkingDirectory=/opt/panomatix/website
EnvironmentFile=/etc/panomatix/app.env
# Node.js 24 installed on its own (/opt/node-24): the system Node.js serves the other site.
ExecStart=/opt/node-24/bin/node server/main.js
Restart=on-failure
RestartSec=5
# Hardening: the site can only write to its database, its backups and the uploaded images.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/panomatix/website/data /opt/panomatix/website/backups /opt/panomatix/road_sign_images
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q panomatix
echo "  Enabled (started by the first \"npm run deploy\")."

say "Nginx…"
# Once Certbot has added the HTTPS block to it, the file is no longer replaced.
if ! grep -qs "listen 443" /etc/nginx/sites-available/panomatix; then
  cat > /etc/nginx/sites-available/panomatix <<EOF
# Panomatix — Nginx site (HTTP). Certbot then adds the HTTPS block and the redirect.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    server_tokens off;
    # Images uploaded by contributors: 20 MB before compression (PANOMATIX_MAX_IMAGE_BYTES).
    client_max_body_size 21m;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # The address Nginx sees, and only that one: a header sent by the visitor is replaced.
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_read_timeout 60s;
    }
}
EOF
fi
[ -e /etc/nginx/sites-enabled/panomatix ] || ln -s /etc/nginx/sites-available/panomatix /etc/nginx/sites-enabled/panomatix
nginx -t -q && systemctl reload nginx
echo "  Site $DOMAIN added."

say "HTTPS certificate…"
ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')
if [ -z "$ip" ]; then
  echo "  ⚠ $DOMAIN has no address yet (DNS): run this script again once the A record exists."
elif grep -q "listen 443" /etc/nginx/sites-available/panomatix; then
  echo "  Already there."
else
  if certbot --nginx -q -d "$DOMAIN" --non-interactive --agree-tos --redirect; then
    echo "  Obtained (renewed automatically)."
  else
    echo "  ⚠ Certbot failed: run \"certbot --nginx -d $DOMAIN\" on the server to see why." >&2
  fi
fi

echo "✓ Server ready. From this computer: cd website && npm run deploy -- \"First deployment\""
