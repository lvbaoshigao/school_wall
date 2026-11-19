#!/bin/bash
# Disable password and keyboard-interactive SSH authentication after a recent key login.
# This verifies a recent successful key login, not the authentication of this shell.
set -euo pipefail
CONF=/etc/ssh/sshd_config.d/00-school-wall-publickey.conf
BACKUP="$CONF.bak.$(date +%s)"
HAD_CONF=0
[ "$(id -un)" = server ] || { echo "Run as the server user" >&2; exit 1; }
[ -s "$HOME/.ssh/authorized_keys" ] || { echo "Install and verify an SSH public key first" >&2; exit 1; }
sudo -v
RECENT_LOG="$(sudo journalctl -u ssh --since '-10 min' --no-pager)"
if ! grep -F 'Accepted publickey for server ' <<<"$RECENT_LOG" >/dev/null; then
    echo "No successful server public-key login in the last 10 minutes." >&2
    echo "Open a second terminal and verify ssh -o PasswordAuthentication=no server@HOST, then retry." >&2
    exit 1
fi
if sudo test -f "$CONF"; then
    sudo cp -a "$CONF" "$BACKUP"
    HAD_CONF=1
fi
rollback() {
    if [ "$HAD_CONF" = 1 ]; then sudo cp -a "$BACKUP" "$CONF"
    else sudo rm -f -- /etc/ssh/sshd_config.d/00-school-wall-publickey.conf; fi
}
# A dedicated early include avoids appending values after an earlier first-match value.
sudo tee "$CONF" >/dev/null <<'EOF'
# School Wall: public-key authentication only.
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF
if ! sudo /usr/sbin/sshd -t; then rollback; echo "Invalid sshd syntax; restored previous configuration" >&2; exit 1; fi
EFFECTIVE="$(sudo /usr/sbin/sshd -T)"
for expected in 'passwordauthentication no' 'kbdinteractiveauthentication no' 'pubkeyauthentication yes'; do
    if ! grep -Fx "$expected" <<<"$EFFECTIVE" >/dev/null; then
        rollback
        echo "Another earlier sshd setting overrides the desired authentication policy; restored previous configuration" >&2
        exit 1
    fi
done
if ! sudo systemctl reload ssh; then
    rollback
    echo "sshd reload failed; restored previous configuration" >&2
    exit 1
fi
echo "Password login is disabled. Keep this connection open and verify a new key-only connection."
if [ "$HAD_CONF" = 1 ]; then
    printf 'Rollback: sudo cp -a %q %q && sudo systemctl reload ssh\n' "$BACKUP" "$CONF"
else
    echo 'Rollback: sudo rm -f -- /etc/ssh/sshd_config.d/00-school-wall-publickey.conf && sudo systemctl reload ssh'
fi
