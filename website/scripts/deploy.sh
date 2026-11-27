#!/bin/sh
# Met à jour le site en une commande, de ce poste vers le serveur (depuis website/) :
#
#   npm run deploy -- "Message du commit"
#
# 1. lance les tests (arrêt au moindre échec) ;
# 2. enregistre les modifications dans un commit (s'il y en a) ;
# 3. envoie le code au serveur par SSH (git push), sans passer par GitHub ;
# 4. si package-lock.json a changé, prépare les modules Node sur ce poste (pour le processeur du
#    serveur : sharp contient du code compilé) et les envoie : le serveur ne contacte jamais npm ;
# 5. sur le serveur (scripts/deploy-remote.sh) : sauvegarde des changements, avance du code,
#    modules, redémarrage ;
# 6. pousse aussi sur GitHub (copie publique du code), si BACKUP_REMOTE est réglé ;
# 7. vérifie que le site répond.
#
# Réglages dans website/.env.deploy (non versionné) :
#   DEPLOY_HOST=root@1.2.3.4
#   DEPLOY_KEY=~/.ssh/ma_cle
#   DEPLOY_DIR=/opt/panomatix          # dépôt git sur le serveur (le site est dans website/)
#   DEPLOY_SERVICE=panomatix
#   DEPLOY_ARCH=x64                    # processeur du serveur : x64 ou arm64 (uname -m)
#   SITE_URL=https://panomatix.exemple.fr
#   BACKUP_REMOTE=origin               # facultatif : remote git où pousser aussi main
set -eu

cd "$(dirname "$0")/.."
[ -f .env.deploy ] || { echo "Fichier website/.env.deploy manquant (voir l'en-tête de scripts/deploy.sh)." >&2; exit 1; }
. ./.env.deploy
: "${DEPLOY_HOST:?DEPLOY_HOST manquant dans .env.deploy}"
: "${DEPLOY_KEY:?DEPLOY_KEY manquant dans .env.deploy}"
: "${DEPLOY_DIR:?DEPLOY_DIR manquant dans .env.deploy}"
: "${DEPLOY_SERVICE:=panomatix}"
: "${DEPLOY_ARCH:=x64}"
: "${SITE_URL:?SITE_URL manquant dans .env.deploy}"
BACKUP_REMOTE=${BACKUP_REMOTE:-}
DEPLOY_KEY=$(eval echo "$DEPLOY_KEY")
message=${1:-"Mise à jour du site"}
branch=$(git branch --show-current)
[ "$branch" = "main" ] || { echo "Placez-vous sur la branche main (branche actuelle : $branch)." >&2; exit 1; }
SSH="ssh -i $DEPLOY_KEY -o BatchMode=yes -o IdentitiesOnly=yes"
remote() { $SSH "$DEPLOY_HOST" "$@"; }
log=$(mktemp)
build=""
trap 'rm -f "$log"; [ -n "$build" ] && rm -rf "$build"' EXIT

echo "▶ Tests…"
npm test --silent >"$log" 2>&1 || { tail -40 "$log"; echo "✗ Tests en échec : rien n'est envoyé." >&2; exit 1; }
grep -E "^ℹ (pass|fail)" "$log" || true

echo "▶ Commit…"
# Tout le dépôt, sauf ce qui ne doit jamais partir (déjà exclu par .gitignore : base, sauvegardes…).
git -C .. add -A -- . ':!signs_by_country'
if git diff --cached --quiet; then
  echo "  Aucune modification à enregistrer."
else
  git commit -q -m "$message"
  echo "  Commit : $(git log -1 --format='%h %s')"
fi

echo "▶ Code → serveur…"
export GIT_SSH_COMMAND="$SSH" GIT_TERMINAL_PROMPT=0
# Référence à part (pas la branche affichée sur le serveur) : le serveur l'applique lui-même ensuite.
git push -q -f "ssh://$DEPLOY_HOST$DEPLOY_DIR" main:refs/deploy/main
echo "  Envoyé : $(git log -1 --format='%h')"

echo "▶ Modules Node…"
# Empreinte de package-lock.json et du processeur : les modules ne sont envoyés que s'ils ont changé.
lock=$( (cat package-lock.json; echo "$DEPLOY_ARCH") | sha256sum | cut -d" " -f1)
if [ "$(remote "cat '$DEPLOY_DIR/website/node_modules/.lock-sha256' 2>/dev/null" || true)" = "$lock" ]; then
  echo "  Inchangés."
else
  build=$(mktemp -d)
  cp package.json package-lock.json "$build/"
  # Installation propre, sans outils de développement ni scripts d'installation, pour Linux/glibc et le
  # processeur du serveur (sharp y prend ses bibliothèques précompilées).
  (cd "$build" && npm ci --omit=dev --ignore-scripts --os=linux --cpu="$DEPLOY_ARCH" --libc=glibc \
    --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null)
  echo "$lock" > "$build/node_modules/.lock-sha256"
  tar -C "$build" -czf - node_modules | remote "cd '$DEPLOY_DIR/website' && rm -rf node_modules.new && mkdir node_modules.new && tar -xzf - -C node_modules.new --strip-components=1"
  echo "  Envoyés ($(du -sh "$build/node_modules" | cut -f1))."
fi

echo "▶ Serveur…"
remote "sh -s -- '$DEPLOY_DIR' '$DEPLOY_SERVICE'" < scripts/deploy-remote.sh

if [ -n "$BACKUP_REMOTE" ]; then
  echo "▶ Copie sur $BACKUP_REMOTE…"
  # Facultative : une forge indisponible n'empêche jamais la mise à jour du site.
  unset GIT_SSH_COMMAND
  if git push -q "$BACKUP_REMOTE" main 2>/dev/null; then echo "  Envoyée."; else echo "  ⚠ Copie non envoyée ($BACKUP_REMOTE injoignable ?)." >&2; fi
fi

echo "▶ Vérification…"
for attempt in 1 2 3 4 5 6; do
  if curl -fsS -m 10 "$SITE_URL/api/v1/health" >/dev/null 2>&1; then
    echo "✓ Site à jour : $SITE_URL"
    exit 0
  fi
  sleep 3
done
echo "✗ Le site ne répond pas : journalctl -u $DEPLOY_SERVICE sur le serveur." >&2
exit 1
