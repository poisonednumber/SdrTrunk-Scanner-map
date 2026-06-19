#!/usr/bin/env bash
# Scanner Map self-update: pull latest code, install deps, run DB migrations.
# Invoked by Settings -> Updates, or run manually:  bash scripts/update.sh
set -e
cd "$(dirname "$0")/.."

echo "==> Scanner Map update starting"
echo "==> Current version: $(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo unknown)"

if [ ! -d .git ]; then
  echo "!! Not a git checkout. Re-download the latest release to update."
  exit 1
fi

echo "==> Stashing any local changes (kept in git stash)"
git stash push -u -m "scanner-map-autoupdate-$(date +%s)" || true

echo "==> Pulling latest from git"
git pull --ff-only

echo "==> Installing Node dependencies"
npm install --omit=dev || npm install

echo "==> Running database migrations"
node scripts/migrate.js || echo "!! migrate step reported an issue (continuing)"

echo "==> New version: $(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo unknown)"
echo "==> Update complete. Restart Scanner Map to apply."
