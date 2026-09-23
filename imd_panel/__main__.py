"""imd-panel command line: serve, install, uninstall."""
import argparse, os, shutil, subprocess, sys

UNIT = "imd-panel.service"


def unit_path():
    return os.path.join(os.path.expanduser("~"), ".config", "systemd", "user", UNIT)


def exec_start():
    """How systemd should start the panel: this interpreter (a pipx venv or a plain python) with the package on its path."""
    pkg_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    checkout = os.path.exists(os.path.join(pkg_root, "pyproject.toml"))  # running from a source checkout, not an installed package
    return f'"{sys.executable}" -m imd_panel serve', (pkg_root if checkout else None)


def service_path():
    """A PATH for the service: where imd, node/npm, claude and forge live, plus the system dirs — not the whole
    login PATH of whoever ran the installer."""
    home = os.path.expanduser("~")
    dirs = []
    for tool in ("imd", "node", "npm", "claude", "forge", "git"):
        w = shutil.which(tool)
        if w:
            dirs.append(os.path.dirname(w))
    dirs += [os.path.join(home, ".local", "bin"), os.path.join(home, ".foundry", "bin"), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]
    out = []
    for d in dirs:
        if d and d not in out and ".claude/plugins" not in d:
            out.append(d)
    return ":".join(out)


def install(port):
    if not shutil.which("systemctl"):
        sys.exit("systemd (user session) is required")
    cmd, pythonpath = exec_start()
    os.makedirs(os.path.dirname(unit_path()), exist_ok=True)
    env_lines = [f"Environment=PORT={port}", f"Environment=PATH={service_path()}"]
    if os.environ.get("IMD_PANEL_HOME"):
        env_lines.append(f"Environment=IMD_PANEL_HOME={os.environ['IMD_PANEL_HOME']}")
    if pythonpath:
        env_lines.append(f"Environment=PYTHONPATH={pythonpath}")
    unit = f"""[Unit]
Description=imd-panel (localhost:{port}, reach it through an SSH tunnel)
After=network.target

[Service]
Type=simple
{chr(10).join(env_lines)}
ExecStart={cmd}
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
"""
    with open(unit_path(), "w") as fh:
        fh.write(unit)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", UNIT], check=True)
    state = subprocess.run(["systemctl", "--user", "is-active", UNIT], capture_output=True, text=True).stdout.strip()
    linger = subprocess.run(["loginctl", "show-user", os.environ.get("USER", ""), "-p", "Linger", "--value"], capture_output=True, text=True).stdout.strip()
    print(f"imd-panel.service is {state} on http://127.0.0.1:{port} (this machine only).")
    if linger != "yes":
        print(f"note: enable lingering so the panel survives logout:  sudo loginctl enable-linger {os.environ.get('USER', '$USER')}")
    print(f"From your computer:  ssh -N -L {port}:127.0.0.1:{port} {os.environ.get('USER', 'user')}@<this host>   then open http://localhost:{port}")
    print("Logs:  journalctl --user -u imd-panel -f")


def uninstall():
    subprocess.run(["systemctl", "--user", "disable", "--now", UNIT], check=False)
    try:
        os.remove(unit_path())
    except FileNotFoundError:
        pass
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    print("imd-panel.service removed. State (settings, history) is still in", os.environ.get("IMD_PANEL_HOME") or "~/.config/imd-panel")


def main(argv=None):
    p = argparse.ArgumentParser(prog="imd-panel", description="Local control panel for an IdentityMD worker.")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="run the panel in the foreground (what the service does)"); s.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8787")))
    i = sub.add_parser("install", help="install and start the user systemd service on 127.0.0.1"); i.add_argument("--port", type=int, default=8787)
    sub.add_parser("uninstall", help="stop and remove the service (keeps your settings and history)")
    sub.add_parser("version", help="print the version")
    a = p.parse_args(argv)
    if a.cmd == "install":
        install(a.port)
    elif a.cmd == "uninstall":
        uninstall()
    elif a.cmd == "version":
        from . import __version__; print("imd-panel", __version__)
    else:
        from . import server
        server.serve(getattr(a, "port", None))


if __name__ == "__main__":
    main()
