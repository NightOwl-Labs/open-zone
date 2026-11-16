#!/usr/bin/env bash
# Install open-zone dependencies and build the UI.
#   ./scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

need_node() {
  echo "open-zone needs Node.js 22.18 or newer (24 LTS recommended). Install it with:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
}

command -v node >/dev/null || need_node
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' || need_node

echo "→ Installing dependencies (this takes a few minutes on a Pi 3)…"
npm ci --no-audit --no-fund
echo "→ Building the UI…"
npm run build

if ! id -nG "$USER" | grep -qw dialout; then
  echo
  echo "Note: $USER is not in the 'dialout' group, needed for the serial port."
  echo "  sudo usermod -aG dialout $USER   (then log out and back in)"
fi

echo
echo "Done. Try it with the emulator:"
echo "  npm run simulate"
echo "Then open http://$(hostname | sed "s/\.local$//").local:8080 on your phone."
