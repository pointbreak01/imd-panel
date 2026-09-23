#!/bin/sh
# Installs imd-panel as a user systemd service bound to 127.0.0.1 only.
# Usage: ./install.sh [port]    (default 8787)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8787}"
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "python3 is required"; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "python3 >= 3.9 is required"; exit 1; }
command -v systemctl >/dev/null || { echo "systemd (user session) is required"; exit 1; }
mkdir -p "$HOME/.config/systemd/user"
UNIT="$HOME/.config/systemd/user/imd-panel.service"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=imd-panel (localhost:$PORT, reach it through an SSH tunnel)
After=network.target

[Service]
Type=simple
WorkingDirectory=$HERE
Environment=PORT=$PORT
Environment=PATH=$PATH
ExecStart=$PY $HERE/server.py
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
UNITEOF
systemctl --user daemon-reload
systemctl --user enable --now imd-panel.service
if command -v loginctl >/dev/null && ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  echo "note: enable lingering so the panel survives logout:  sudo loginctl enable-linger $USER"
fi
echo
echo "imd-panel is running on http://127.0.0.1:$PORT (this machine only)."
echo "From your computer:  ssh -N -L $PORT:127.0.0.1:$PORT $USER@<this host>   then open http://localhost:$PORT"
echo "Logs:  journalctl --user -u imd-panel -f"
