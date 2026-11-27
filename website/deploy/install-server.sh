#!/bin/sh
# Première installation de Panomatix sur le serveur (Ubuntu/Debian, en root). Depuis le poste :
#
#   ssh -i ~/.ssh/ma_cle root@IP 'sh -s' < website/deploy/install-server.sh
#
# Sans danger à relancer : chaque étape déjà faite est sautée. Ne touche pas aux autres sites
# (Node.js 24 s'installe à part dans /opt/node-24 ; Nginx reçoit un site de plus).
# Ensuite, depuis le poste : npm run deploy (envoie les modules Node et démarre le site).
set -eu

DOMAIN=panomatix.tes-maker.eu
DIR=/opt/panomatix
REPO=https://github.com/tes-maker/panomatix.git
NODE_DIR=/opt/node-24
PORT=8080
USER_NAME=panomatix

[ "$(id -u)" = 0 ] || { echo "À lancer en root." >&2; exit 1; }
say() { echo "▶ $*"; }

say "Paquets (git, nginx, certbot, curl)…"
missing=""
for p in git nginx certbot python3-certbot-nginx curl xz-utils; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then apt-get install -y -q $missing >/dev/null; echo "  Installés :$missing"; else echo "  Déjà là."; fi

say "Node.js 24 dans $NODE_DIR (le Node.js du système n'est pas modifié)…"
if "$NODE_DIR/bin/node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=7)?0:1)' 2>/dev/null; then
  echo "  Déjà là : $("$NODE_DIR/bin/node" --version)"
else
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "Processeur non prévu : $(uname -m)" >&2; exit 1 ;; esac
  tmp=$(mktemp -d)
  base=https://nodejs.org/dist/latest-v24.x
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -o "node-v24[0-9.]*-linux-$arch.tar.xz" "$tmp/SHASUMS256.txt" | head -1)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || { echo "Somme de contrôle de Node.js incorrecte." >&2; exit 1; }
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  echo "  Installé : $("$NODE_DIR/bin/node" --version) ($arch)"
fi

say "Compte système $USER_NAME…"
if id "$USER_NAME" >/dev/null 2>&1; then echo "  Déjà là."; else
  useradd --system --home "$DIR" --shell /usr/sbin/nologin "$USER_NAME"; echo "  Créé."; fi

say "Code dans $DIR…"
if [ -d "$DIR/.git" ]; then echo "  Déjà là : $(git -C "$DIR" log -1 --format='%h %s')"; else
  git clone -q "$REPO" "$DIR"; echo "  Cloné : $(git -C "$DIR" log -1 --format='%h %s')"; fi
install -d -o "$USER_NAME" -g "$USER_NAME" -m 750 "$DIR/website/data" "$DIR/website/backups"
chown -R "$USER_NAME:$USER_NAME" "$DIR/road_sign_images"

say "Réglages /etc/panomatix/app.env…"
install -d -o root -g "$USER_NAME" -m 750 /etc/panomatix
if [ -f /etc/panomatix/app.env ]; then echo "  Déjà là (non modifié)."; else
  cat > /etc/panomatix/app.env <<EOF
# Réglages de Panomatix (voir website/README.md). Après modification : systemctl restart panomatix
PANOMATIX_HOST=127.0.0.1
PANOMATIX_PORT=$PORT
PANOMATIX_PUBLIC_URL=https://$DOMAIN
PANOMATIX_TRUST_PROXY=1
# Mails (comptes, mot de passe oublié) : boîte IONOS dédiée. Sans ces lignes, les mails sont
# écrits dans le journal (journalctl -u panomatix) au lieu d'être envoyés.
#PANOMATIX_SMTP_URL=smtps://no-reply%40tes-maker.eu:MOT_DE_PASSE_ENCODE@smtp.ionos.fr:465
#PANOMATIX_MAIL_FROM=Panomatix <no-reply@tes-maker.eu>
EOF
  chown root:"$USER_NAME" /etc/panomatix/app.env && chmod 640 /etc/panomatix/app.env
  echo "  Créé : ajoutez-y le compte SMTP."
fi

say "Port $PORT…"
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet panomatix; then
  echo "  ✗ Le port $PORT est déjà pris par un autre programme : changez PANOMATIX_PORT et proxy_pass." >&2; exit 1
fi
echo "  Libre."

say "Service systemd…"
# (Fichiers écrits ici même : le script ne dépend pas de la version du code clonée.)
cat > /etc/systemd/system/panomatix.service <<'EOF'
[Unit]
Description=Panomatix — base collaborative des panneaux routiers
After=network.target

[Service]
Type=simple
User=panomatix
Group=panomatix
WorkingDirectory=/opt/panomatix/website
EnvironmentFile=/etc/panomatix/app.env
# Node.js 24 installé à part (/opt/node-24) : le Node.js 22 du système sert à l'autre site.
ExecStart=/opt/node-24/bin/node server/main.js
Restart=on-failure
RestartSec=5
# Durcissement : le site ne peut écrire que dans sa base, ses sauvegardes et les images envoyées.
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
echo "  Activé (démarré par le premier « npm run deploy »)."

say "Nginx…"
# Une fois que Certbot y a ajouté le bloc HTTPS, le fichier n'est plus remplacé.
if ! grep -qs "listen 443" /etc/nginx/sites-available/panomatix; then
  cat > /etc/nginx/sites-available/panomatix <<EOF
# Panomatix — site Nginx (HTTP). Certbot ajoute ensuite le bloc HTTPS et la redirection.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    server_tokens off;
    # Images envoyées par les contributeurs : 20 Mo avant compression (PANOMATIX_MAX_IMAGE_BYTES).
    client_max_body_size 21m;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # L'adresse vue par Nginx, et elle seule : un en-tête envoyé par le visiteur est remplacé.
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_read_timeout 60s;
    }
}
EOF
fi
[ -e /etc/nginx/sites-enabled/panomatix ] || ln -s /etc/nginx/sites-available/panomatix /etc/nginx/sites-enabled/panomatix
nginx -t -q && systemctl reload nginx
echo "  Site $DOMAIN ajouté."

say "Certificat HTTPS…"
ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')
if [ -z "$ip" ]; then
  echo "  ⚠ $DOMAIN n'a pas encore d'adresse (DNS) : relancez ce script une fois l'enregistrement A créé."
elif grep -q "listen 443" /etc/nginx/sites-available/panomatix; then
  echo "  Déjà là."
else
  if certbot --nginx -q -d "$DOMAIN" --non-interactive --agree-tos --redirect; then
    echo "  Obtenu (renouvelé automatiquement)."
  else
    echo "  ⚠ Certbot a échoué : lancez « certbot --nginx -d $DOMAIN » sur le serveur pour voir pourquoi." >&2
  fi
fi

echo "✓ Serveur prêt. Depuis le poste : cd website && npm run deploy -- \"Mise en ligne\""
