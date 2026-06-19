#!/usr/bin/env bash
#
# Scanner Map - Linux/macOS installer (thin bootstrap)
#
# Installs prerequisites + dependencies, then launches the web Setup Wizard.
#   chmod +x installers/install.sh
#   ./installers/install.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() { printf "\n\033[36m=== %s ===\033[0m\n" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

step "Scanner Map setup"

# --- OS / package manager detection ---
PKG=""
if have apt-get; then PKG="apt"; fi
if have dnf; then PKG="dnf"; fi
if have brew; then PKG="brew"; fi

install_pkg() {
  case "$PKG" in
    apt) sudo apt-get install -y "$@" ;;
    dnf) sudo dnf install -y "$@" ;;
    brew) brew install "$@" ;;
    *) echo "[!!] No supported package manager found. Install manually: $*" ;;
  esac
}

# Node.js (>=18)
if ! have node; then
  step "Installing Node.js"
  if [ "$PKG" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    install_pkg nodejs npm || true
  fi
else
  echo "[ok] node $(node --version)"
fi

# Python 3 + venv + ffmpeg
step "Installing Python & FFmpeg"
if [ "$PKG" = "apt" ]; then
  sudo apt-get update
  install_pkg python3 python3-venv python3-pip ffmpeg
else
  install_pkg python3 ffmpeg || true
fi

step "Installing Node dependencies"
npm install --no-audit --no-fund

step "Setting up Python environment"
[ -d .venv ] || python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip
echo "Installing PyTorch (CPU build). For NVIDIA GPU, use the CUDA index URL in requirements.txt."
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
deactivate

[ -f .env ] || cp .env.example .env

step "Done!"
echo "Starting Scanner Map. Open the Setup Wizard at http://localhost:8080/setup"
export PYTHON_COMMAND="$REPO_ROOT/.venv/bin/python"
npm start
