#!/bin/sh
# Hand bubblewrap's AppArmor permission over to the worker's own profile (worker >= 0.1.2, "read jail"). Run once as an admin:
#
#     sudo sh imd-jail-setup.sh [worker-user]
#
# The worker checks for /etc/apparmor.d/identitymd-bwrap (written by `imd jail-setup`) before it takes oracle work; the
# profile install-sandbox-deps.sh wrote (/etc/apparmor.d/bwrap) attaches to the same binary and would conflict with it,
# so it is unloaded first and put back only if `imd jail-setup` fails.
set -u
USER_NAME="${1:-imd}"
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
NODE=$(ls -d "$HOME_DIR"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)
IMD=$(ls -d "$HOME_DIR"/.nvm/versions/node/*/bin/imd 2>/dev/null | tail -1)
[ -x "$NODE" ] && [ -e "$IMD" ] || { echo "worker CLI not found under $HOME_DIR/.nvm"; exit 1; }

if [ -f /etc/apparmor.d/bwrap ]; then
  echo "1/3 unloading the generic bwrap profile"
  cp -p /etc/apparmor.d/bwrap /tmp/bwrap.profile.bak
  apparmor_parser -R /etc/apparmor.d/bwrap 2>/dev/null || true
  rm -f /etc/apparmor.d/bwrap
fi
echo "2/3 imd jail-setup (the worker's own profile)"
if "$NODE" "$IMD" jail-setup; then
  echo "   profile:"; sed -n '1,12p' /etc/apparmor.d/identitymd-bwrap 2>/dev/null
else
  echo "   imd jail-setup FAILED — restoring the generic profile"
  [ -f /tmp/bwrap.profile.bak ] && cp /tmp/bwrap.profile.bak /etc/apparmor.d/bwrap && apparmor_parser -r /etc/apparmor.d/bwrap
  exit 1
fi
echo "3/3 bubblewrap still works for $USER_NAME?"
su -s /bin/sh -c 'bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent /bin/true && echo "   yes"' "$USER_NAME"
echo "now, as $USER_NAME:  systemctl --user restart identitymd-worker   (the worker checks the jail at start)"
