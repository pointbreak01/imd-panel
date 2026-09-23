"""Where imd-panel keeps things: code assets next to this file, mutable state in its own directory."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))                      # index.html, assets/
STATE_DIR = os.environ.get("IMD_PANEL_HOME") or os.path.join(os.path.expanduser("~"), ".config", "imd-panel")
os.makedirs(STATE_DIR, exist_ok=True)


def state(name):
    return os.path.join(STATE_DIR, name)
