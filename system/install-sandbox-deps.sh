#!/bin/sh
# Root part of the Claude Code sandbox setup for an identity.md worker machine (Ubuntu 24.04). Run ONCE as an admin:
#
#     sudo sh install-sandbox-deps.sh [worker-user]        (default worker user: imd)
#
# Installs bubblewrap (filesystem isolation) and socat (the sandbox's network relay), and lets bubblewrap create user
# namespaces under Ubuntu 24.04's AppArmor policy (kernel.apparmor_restrict_unprivileged_userns = 1 blocks them for
# unconfined programs; the profile below is the one Claude Code's docs give). Nothing else on the machine changes.
# The user part — writing the sandbox settings and probing them — is system/install-sandbox.sh, run as the worker user.
set -eu
USER_NAME="${1:-imd}"
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

echo "1/3 packages"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q bubblewrap socat >/dev/null
bwrap --version; socat -V 2>/dev/null | head -1

echo "2/3 AppArmor: allow bubblewrap to create user namespaces"
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  if [ ! -f /etc/apparmor.d/bwrap ]; then
    cat > /etc/apparmor.d/bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

# bubblewrap for Claude Code's sandbox: unconfined, but allowed to create user namespaces
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
    echo "   wrote /etc/apparmor.d/bwrap"
  else
    echo "   /etc/apparmor.d/bwrap already present"
  fi
  apparmor_parser -r /etc/apparmor.d/bwrap
  systemctl reload apparmor 2>/dev/null || true
else
  echo "   not restricted on this kernel, nothing to do"
fi

echo "3/3 does bubblewrap work for $USER_NAME?"
if su -s /bin/sh -c 'bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent /bin/true' "$USER_NAME"; then
  echo "   yes. Now, as $USER_NAME:  sh ~/imd-panel/system/install-sandbox.sh"
else
  echo "   NO: bwrap failed for $USER_NAME — check 'dmesg | grep -i apparmor' and 'sysctl kernel.unprivileged_userns_clone'"
  exit 1
fi
