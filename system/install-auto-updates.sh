#!/bin/bash
# Automatic OS updates for an IMD worker VPS (Ubuntu 24.04). Run once, as root, from the panel checkout:
#   sudo ~/imd-panel/system/install-auto-updates.sh
# - unattended-upgrades also takes noble-updates (kernel, apparmor…) and the Tailscale repo, and drops old kernels
# - the daily upgrade runs at 02:00 UTC, right before the reboot window
# - imd-idle-reboot.timer reboots for pending updates only between 03:00 and 06:00 UTC and only while no task runs
# The reboot script is COPIED to /usr/local/sbin (root-owned): a later git pull in the user's checkout never changes
# what root runs; re-run this installer to take a new version. Re-running is safe.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run it with sudo" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
U=${IMD_USER:-${SUDO_USER:-imd}}
id "$U" >/dev/null

install -o root -g root -m 755 "$HERE/imd-idle-reboot" /usr/local/sbin/imd-idle-reboot

cat > /etc/apt/apt.conf.d/52imd-unattended <<'EOF'
// imd-panel system/install-auto-updates.sh: on top of 50unattended-upgrades (security + release)
Unattended-Upgrade::Allowed-Origins {
	"${distro_id}:${distro_codename}-updates";
};
Unattended-Upgrade::Origins-Pattern {
	"origin=Tailscale,codename=${distro_codename}";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
// reboots are left to imd-idle-reboot.timer: night window, worker idle
Unattended-Upgrade::Automatic-Reboot "false";
EOF

mkdir -p /etc/systemd/system/apt-daily.timer.d /etc/systemd/system/apt-daily-upgrade.timer.d
cat > /etc/systemd/system/apt-daily.timer.d/imd.conf <<'EOF'
[Timer]
OnCalendar=
OnCalendar=*-*-* 01:30,13:30
RandomizedDelaySec=15m
EOF
cat > /etc/systemd/system/apt-daily-upgrade.timer.d/imd.conf <<'EOF'
[Timer]
OnCalendar=
OnCalendar=*-*-* 02:00
RandomizedDelaySec=20m
EOF

cat > /etc/systemd/system/imd-idle-reboot.service <<EOF
[Unit]
Description=Reboot for pending updates in the night window while the IMD worker is idle
After=network-online.target

[Service]
Type=oneshot
Environment=IMD_USER=$U
ExecStart=/usr/local/sbin/imd-idle-reboot
EOF
cat > /etc/systemd/system/imd-idle-reboot.timer <<'EOF'
[Unit]
Description=Check every 10 minutes whether the VPS may reboot for updates

[Timer]
OnCalendar=*:0/10
AccuracySec=1m

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now imd-idle-reboot.timer
systemctl restart apt-daily.timer apt-daily-upgrade.timer
IMD_USER=$U /usr/local/sbin/imd-idle-reboot --dry-run

echo
echo "origins unattended-upgrades will now take:"
unattended-upgrade --dry-run -d 2>/dev/null | grep -E "^Allowed origins are|^Packages that will be upgraded" || true
echo
systemctl list-timers apt-daily.timer apt-daily-upgrade.timer imd-idle-reboot.timer --no-pager
echo
echo "done. To install the pending updates right away instead of at 02:00 UTC: sudo unattended-upgrade -v"
