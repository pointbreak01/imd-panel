#!/bin/sh
# Install from a source checkout without pipx: runs the package in place as a user service.
# Usage: ./install.sh [port]     (prefer: pipx install git+https://github.com/pointbreak01/imd-panel && imd-panel install)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || true)"; [ -n "$PY" ] || { echo "python3 is required"; exit 1; }
cd "$HERE" && exec "$PY" -m imd_panel install --port "${1:-8787}"
