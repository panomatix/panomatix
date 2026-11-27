#!/bin/sh
# Partie serveur du déploiement (lancée par scripts/deploy.sh, par SSH, en root) :
#
#   sh deploy-remote.sh <dépôt sur le serveur> <service systemd | "-" pour ne pas redémarrer>
#
# Le code a été poussé dans la référence refs/deploy/main et, si les modules Node ont changé, ils
# attendent dans website/node_modules.new/. Ce script :
# 1. sauvegarde les changements depuis la dernière sauvegarde (npm run backup), s'il y a une base ;
# 2. avance le code jusqu'à cette version (avance rapide seulement : jamais d'écrasement) ;
# 3. remplace node_modules par node_modules.new, s'il existe ;
# 4. rend au compte du service les dossiers où il écrit (base, sauvegardes, images envoyées) ;
# 5. redémarre le service.
# Ni GitHub ni le registre npm ne sont contactés.
set -eu

dir=$1
service=${2:--}
NODE=/opt/node-24/bin/node
USER_NAME=panomatix
cd "$dir"

cleanup() { rm -rf website/node_modules.new; }
fail() { cleanup; echo "  ✗ $1" >&2; exit 1; }

git rev-parse -q --verify refs/deploy/main >/dev/null || fail "aucune version reçue (refs/deploy/main)."
# Fichiers suivis modifiés à la main sur le serveur : on s'arrête plutôt que de les écraser.
# (Les images envoyées par les contributeurs sont des fichiers non suivis : elles ne gênent pas.)
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "fichiers modifiés sur le serveur : git status dans $dir."

if [ -f website/data/panomatix.sqlite3 ] && [ -d website/node_modules ]; then
  # (pas de « | sed » ici : le statut d'échec de la sauvegarde serait perdu)
  (cd website && runuser -u "$USER_NAME" -- "$NODE" server/cli.js backup) \
    || fail "sauvegarde impossible : rien n'est mis en ligne."
fi

git merge -q --ff-only refs/deploy/main 2>/dev/null || fail "la version reçue ne prolonge pas celle du serveur (historique divergent)."

if [ -d website/node_modules.new ]; then
  rm -rf website/node_modules.old
  [ -d website/node_modules ] && mv website/node_modules website/node_modules.old
  mv website/node_modules.new website/node_modules
  rm -rf website/node_modules.old
  echo "  Modules Node mis à jour."
fi

# Le code reste à root (le site ne peut pas le modifier) ; seuls ces dossiers sont au service.
install -d -o "$USER_NAME" -g "$USER_NAME" -m 750 website/data website/backups
chown -R "$USER_NAME:$USER_NAME" website/data website/backups road_sign_images

if [ "$service" != "-" ]; then
  systemctl restart "$service"
fi
echo "  Version en ligne : $(git log -1 --format='%h %s')"
