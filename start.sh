#!/usr/bin/env bash
# ============================================================
#  Scanner Map launcher (Linux / macOS)
#  Run with:  ./start.sh   (or double-click if your file manager allows)
#  Auto-restarts into the full app after first-time setup.
# ============================================================
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed or not on your PATH."
  echo "  Install the LTS version from https://nodejs.org then run this again."
  echo ""
  exit 1
fi

# Tell the app it was started by the launcher so it can self-restart (exit 75).
export SCANNER_LAUNCHER=1

while true; do
  node start.js
  code=$?
  if [ "$code" = "75" ]; then
    echo ""
    echo "=== Restarting Scanner Map to apply setup... ==="
    echo ""
    continue
  fi
  exit "$code"
done
