#!/usr/bin/env sh
set -e

# Ensure runtime directories exist (in case volumes are mounted empty)
mkdir -p /app/audio /app/data /app/logs /app/models

# If no .env exists yet, seed one from the example so the setup wizard can boot.
if [ ! -f /app/.env ]; then
  echo "[entrypoint] No .env found - seeding from .env.example (open /setup to configure)."
  cp /app/.env.example /app/.env
fi

exec "$@"
