#!/usr/bin/env bash
# Install open-zone as a systemd service so it starts at boot and restarts
# after crashes or power loss.
#   ./scripts/install-service.sh              # real amplifier
#   ./scripts/install-service.sh --simulate   # built-in emulator
#   ./scripts/install-service.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
UNIT=/etc/systemd/system/open-zone.service

if [[ "${1:-}" == "--uninstall" ]]; then
  sudo systemctl disable --now open-zone 2>/dev/null || true
  sudo rm -f "$UNIT"
  sudo systemctl daemon-reload
  echo "open-zone service removed."
  exit 0
fi

ARGS=""
[[ "${1:-}" == "--simulate" ]] && ARGS="--simulate"
NODE="$(command -v node)"
PORT="${OZ_PORT:-8080}"

sudo tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=open-zone multi-zone amplifier controller
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
Group=dialout
WorkingDirectory=$REPO
ExecStart=$NODE $REPO/packages/server/src/main.ts $ARGS
Environment=OZ_PORT=$PORT
Environment=NODE_ENV=production
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNITEOF

sudo systemctl daemon-reload
sudo systemctl enable --now open-zone
sudo systemctl restart open-zone
echo "open-zone service installed${ARGS:+ (simulator)}."
echo "  Status: systemctl status open-zone"
echo "  Logs:   journalctl -u open-zone -f"
echo "  Open:   http://$(hostname).local:$PORT"
