#!/bin/sh
# Updates the site in one command, from this computer to the server (run from website/):
#
#   npm run deploy -- "Commit message, in English"
#
# 1. runs the tests (stops at the first failure);
# 2. commits the changes (if any);
# 3. pushes the code to the server over SSH (git push), without going through GitHub;
# 4. when package-lock.json changed, builds the Node modules here (for the server's CPU: sharp ships
#    compiled code) and sends them: the server never contacts npm;
# 5. on the server (scripts/deploy-remote.sh): backs up the changes, fast-forwards the code, swaps the
#    modules, restarts the service;
# 6. also pushes to GitHub (public copy of the code) when BACKUP_REMOTE is set;
# 7. checks that the site answers.
#
# Settings in website/.env.deploy (not versioned):
#   DEPLOY_HOST=root@1.2.3.4
#   DEPLOY_KEY=~/.ssh/my_key
#   DEPLOY_DIR=/opt/panomatix          # git repository on the server (the site is in website/)
#   DEPLOY_SERVICE=panomatix
#   DEPLOY_ARCH=x64                    # server CPU: x64 or arm64 (uname -m)
#   SITE_URL=https://panomatix.example.org
#   BACKUP_REMOTE=origin               # optional: git remote where main is pushed as well
set -eu

cd "$(dirname "$0")/.."
[ -f .env.deploy ] || { echo "Missing website/.env.deploy (see the header of scripts/deploy.sh)." >&2; exit 1; }
. ./.env.deploy
: "${DEPLOY_HOST:?DEPLOY_HOST missing in .env.deploy}"
: "${DEPLOY_KEY:?DEPLOY_KEY missing in .env.deploy}"
: "${DEPLOY_DIR:?DEPLOY_DIR missing in .env.deploy}"
: "${DEPLOY_SERVICE:=panomatix}"
: "${DEPLOY_ARCH:=x64}"
: "${SITE_URL:?SITE_URL missing in .env.deploy}"
BACKUP_REMOTE=${BACKUP_REMOTE:-}
DEPLOY_KEY=$(eval echo "$DEPLOY_KEY")
message=${1:-"Update the site"}
branch=$(git branch --show-current)
[ "$branch" = "main" ] || { echo "Switch to the main branch (current branch: $branch)." >&2; exit 1; }
SSH="ssh -i $DEPLOY_KEY -o BatchMode=yes -o IdentitiesOnly=yes"
remote() { $SSH "$DEPLOY_HOST" "$@"; }
log=$(mktemp)
build=""
trap 'rm -f "$log"; [ -n "$build" ] && rm -rf "$build"' EXIT

echo "▶ Tests…"
npm test --silent >"$log" 2>&1 || { tail -40 "$log"; echo "✗ Tests failed: nothing was sent." >&2; exit 1; }
grep -E "^ℹ (pass|fail)" "$log" || true

echo "▶ Commit…"
# The whole repository, except what must never leave (already excluded by .gitignore: database, backups…).
git -C .. add -A -- . ':!signs_by_country'
if git diff --cached --quiet; then
  echo "  Nothing to commit."
else
  git commit -q -m "$message"
  echo "  Commit: $(git log -1 --format='%h %s')"
fi

echo "▶ Code → server…"
export GIT_SSH_COMMAND="$SSH" GIT_TERMINAL_PROMPT=0
# A separate ref (not the branch checked out on the server): the server applies it itself afterwards.
git push -q -f "ssh://$DEPLOY_HOST$DEPLOY_DIR" main:refs/deploy/main
echo "  Sent: $(git log -1 --format='%h')"

echo "▶ Node modules…"
# Fingerprint of package-lock.json and of the CPU: the modules are only sent when they changed.
lock=$( (cat package-lock.json; echo "$DEPLOY_ARCH") | sha256sum | cut -d" " -f1)
if [ "$(remote "cat '$DEPLOY_DIR/website/node_modules/.lock-sha256' 2>/dev/null" || true)" = "$lock" ]; then
  echo "  Unchanged."
else
  build=$(mktemp -d)
  cp package.json package-lock.json "$build/"
  # Clean install, without dev tools or install scripts, for Linux/glibc and the server's CPU
  # (sharp picks its prebuilt libraries for it).
  (cd "$build" && npm ci --omit=dev --ignore-scripts --os=linux --cpu="$DEPLOY_ARCH" --libc=glibc \
    --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null)
  echo "$lock" > "$build/node_modules/.lock-sha256"
  tar -C "$build" -czf - node_modules | remote "cd '$DEPLOY_DIR/website' && rm -rf node_modules.new && mkdir node_modules.new && tar -xzf - -C node_modules.new --strip-components=1"
  echo "  Sent ($(du -sh "$build/node_modules" | cut -f1))."
fi

echo "▶ Server…"
remote "sh -s -- '$DEPLOY_DIR' '$DEPLOY_SERVICE'" < scripts/deploy-remote.sh

if [ -n "$BACKUP_REMOTE" ]; then
  echo "▶ Copy to $BACKUP_REMOTE…"
  # Optional: an unavailable forge never blocks the update of the site.
  unset GIT_SSH_COMMAND
  if git push -q "$BACKUP_REMOTE" main 2>/dev/null; then echo "  Sent."; else echo "  ⚠ Copy not sent ($BACKUP_REMOTE unreachable?)." >&2; fi
fi

echo "▶ Check…"
for attempt in 1 2 3 4 5 6; do
  if curl -fsS -m 10 "$SITE_URL/api/v1/health" >/dev/null 2>&1; then
    echo "✓ Site up to date: $SITE_URL"
    exit 0
  fi
  sleep 3
done
echo "✗ The site does not answer: journalctl -u $DEPLOY_SERVICE on the server." >&2
exit 1
