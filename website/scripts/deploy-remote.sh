#!/bin/sh
# Server side of the deployment (run by scripts/deploy.sh over SSH, as root):
#
#   sh deploy-remote.sh <repository on the server> <systemd service | "-" not to restart>
#
# The code has been pushed to the ref refs/deploy/main and, when the Node modules changed, they wait in
# website/node_modules.new/. This script:
# 1. backs up the changes since the last backup (npm run backup), when there is a database;
# 2. moves the code forward to that version (fast-forward only: never overwrites anything);
# 3. replaces node_modules with node_modules.new, if present;
# 4. gives the service account back the folders it writes to (database, backups, uploaded images);
# 5. restarts the service.
# Neither GitHub nor the npm registry is contacted.
set -eu

dir=$1
service=${2:--}
NODE=/opt/node-24/bin/node
USER_NAME=panomatix
cd "$dir"

cleanup() { rm -rf website/node_modules.new; }
fail() { cleanup; echo "  ✗ $1" >&2; exit 1; }

git rev-parse -q --verify refs/deploy/main >/dev/null || fail "no version received (refs/deploy/main)."
# Tracked files edited by hand on the server: stop rather than overwrite them.
# (Images uploaded by contributors are untracked files: they are not in the way.)
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "files modified on the server: git status in $dir."

if [ -f website/data/panomatix.sqlite3 ] && [ -d website/node_modules ]; then
  # (no "| sed" here: the failure status of the backup would be lost)
  (cd website && runuser -u "$USER_NAME" -- "$NODE" server/cli.js backup) \
    || fail "backup failed: nothing is put online."
fi

# Pictures downloaded or uploaded on the server are untracked files. When the new version brings a file at
# the same path, git would refuse to merge: an identical copy is simply dropped (git brings the same one);
# a different one is kept aside as <name>.server-<date>.
git diff --name-only --diff-filter=A HEAD refs/deploy/main -- road_sign_images | while IFS= read -r f; do
  [ -e "$f" ] || continue
  if [ "$(git hash-object "$f")" = "$(git rev-parse "refs/deploy/main:$f")" ]; then rm -f "$f"
  else mv "$f" "$f.server-$(date +%Y%m%d%H%M%S)"; echo "  Kept the server's own $f aside."; fi
done

git merge -q --ff-only refs/deploy/main 2>/dev/null || fail "the received version does not follow the server's (diverging history)."

if [ -d website/node_modules.new ]; then
  rm -rf website/node_modules.old
  [ -d website/node_modules ] && mv website/node_modules website/node_modules.old
  mv website/node_modules.new website/node_modules
  rm -rf website/node_modules.old
  echo "  Node modules updated."
fi

# The code stays owned by root (the site cannot modify it); only these folders belong to the service.
install -d -o "$USER_NAME" -g "$USER_NAME" -m 750 website/data website/backups
chown -R "$USER_NAME:$USER_NAME" website/data website/backups road_sign_images

if [ "$service" != "-" ]; then
  systemctl restart "$service"
fi
echo "  Live version: $(git log -1 --format='%h %s')"
