#!/bin/bash
# Debian server installation/update. Run as server from /home/server/school_wall.
# Rebuilds locked dependencies and installs nginx/systemd/UFW configuration.
# --check is read-only; the normal invocation really changes the deployment host.
set -euo pipefail
umask 077
# Non-interactive shells may omit Debian administrative command directories.
export PATH="$PATH:/usr/sbin:/sbin"
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEPLOY_DIR="$APP_ROOT/deploy"
PROXY_PORT=11451
SSH_PORT="${SSH_PORT:-22}"
CHECK_ONLY=0
case "${1:-}" in
    --check) CHECK_ONLY=1 ;;
    '') ;;
    *) echo "Usage: bash deploy/install-server.sh [--check]" >&2; exit 1 ;;
esac
[ "$#" -le 1 ] || { echo "Unexpected arguments" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

say "1/6 Preflight (no deployment changes yet)"
for tool in node npm nginx sudo systemctl ss curl ufw install readlink; do
    command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
node "$DEPLOY_DIR/check-runtime.cjs"
NGINX_BUILD="$(nginx -V 2>&1)"
[[ "$NGINX_BUILD" == *--with-http_realip_module* ]] || { echo "nginx requires http_realip_module" >&2; exit 1; }
[[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$SSH_PORT >= 1 && 10#$SSH_PORT <= 65535 )) || {
    echo "SSH_PORT must be 1..65535" >&2; exit 1;
}
SSH_PORT=$((10#$SSH_PORT))
for snippet in proxy headers csp realip; do
    [ -f "$DEPLOY_DIR/nginx/school-wall-$snippet.conf" ] || { echo "Missing nginx snippet: $snippet" >&2; exit 1; }
done
for directory in server client; do
    [ -f "$APP_ROOT/$directory/package-lock.json" ] || { echo "Missing $directory lockfile" >&2; exit 1; }
done
SERVICE_DATA_DIR="$(node "$DEPLOY_DIR/service-data-dir.cjs")"
NODE_BIN="$(node -p 'process.execPath')"
[[ "$NODE_BIN" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo "Unsupported node executable path: $NODE_BIN" >&2; exit 1; }
if [ "$CHECK_ONLY" = 1 ]; then
    node "$DEPLOY_DIR/check-runtime.cjs" --server --sharp
    [ -f "$APP_ROOT/client/dist/index.html" ] || { echo "Frontend build is missing" >&2; exit 1; }
    echo "Preflight passed. No services, firewall rules, permissions or configuration were changed."
    exit 0
fi
[ "$(id -un)" = server ] || { echo "Run as the server user" >&2; exit 1; }
[ "$APP_ROOT" = /home/server/school_wall ] || { echo "This service/nginx template requires /home/server/school_wall" >&2; exit 1; }
# Refuse foreign/bare listeners. Never pkill matching command names across projects.
if [ -n "$(ss -H -ltn 'sport = :3000')" ] && ! systemctl is-active --quiet school-wall; then
    echo "Port 3000 is already used outside the running school-wall unit. Stop its owner explicitly." >&2
    exit 1
fi
sudo -v

say "2/6 Stop this project's service and prepare locked dependencies/frontend"
if systemctl is-active --quiet school-wall; then sudo systemctl stop school-wall; fi
# Stop before replacing dependencies; a failed preparation leaves the service stopped.
bash "$APP_ROOT/deploy.sh" --prepare-only

say "3/6 File permissions (only frontend assets are public)"
chmod 711 /home/server
chmod 755 "$APP_ROOT" "$APP_ROOT/client"
chmod -R u+rwX,go+rX,go-w "$APP_ROOT/client/dist"
chmod 700 "$APP_ROOT/server"
if [ ! -d "$SERVICE_DATA_DIR" ]; then
    sudo install -d -m 700 -o server -g server "$SERVICE_DATA_DIR"
fi
chmod 700 "$SERVICE_DATA_DIR"
for private_directory in uploads backups; do
    target="$SERVICE_DATA_DIR/$private_directory"
    [ ! -L "$target" ] || { echo "Private data directory must not be a symlink: $target" >&2; exit 1; }
    if [ -d "$target" ]; then chmod -R u+rwX,go-rwx "$target"; fi
done
for private_file in "$SERVICE_DATA_DIR"/data.db* "$SERVICE_DATA_DIR/.jwt_secret" "$APP_ROOT/server/.env"; do
    if [ -f "$private_file" ]; then chmod 600 "$private_file"; fi
done

say "4/6 Install and validate nginx and systemd configuration"
for snippet in proxy headers csp realip; do
    sudo install -m 644 -D "$DEPLOY_DIR/nginx/school-wall-$snippet.conf" \
        "/etc/nginx/snippets/school-wall-$snippet.conf"
done
sudo install -m 644 -D "$DEPLOY_DIR/nginx/school-wall.conf" /etc/nginx/sites-available/school-wall
sudo ln -sfn /etc/nginx/sites-available/school-wall /etc/nginx/sites-enabled/school-wall
# Preserve other sites, including the distribution's default site.
sudo nginx -t
sudo install -m 644 -D "$DEPLOY_DIR/systemd/school-wall.service" /etc/systemd/system/school-wall.service
sudo install -d -m 755 /etc/systemd/system/school-wall.service.d
# The selected, version-checked node may be installed with nvm rather than /usr/bin.
# Explicitly list the data directory as writable under ProtectSystem=strict.
printf '[Service]\nExecStart=\nExecStart=%s index.js\nReadWritePaths=\nReadWritePaths=%s\n' \
    "$NODE_BIN" "$SERVICE_DATA_DIR" \
    | sudo tee /etc/systemd/system/school-wall.service.d/50-runtime.conf >/dev/null
sudo systemctl daemon-reload

say "5/6 Firewall rules and service startup"
# Add project rules without claiming to remove pre-existing UFW rules.
# Set SSH_PORT for a nonstandard SSH listener before running this installer.
sudo ufw allow "$SSH_PORT/tcp" >/dev/null
sudo ufw allow "$PROXY_PORT/tcp" >/dev/null
sudo ufw deny 3000/tcp >/dev/null
sudo ufw --force enable >/dev/null
sudo ufw reload >/dev/null
sudo systemctl enable school-wall nginx >/dev/null
sudo systemctl restart school-wall
sudo systemctl reload-or-restart nginx

say "6/6 Bounded health checks"
fail=0
check() {
    local description="$1"; shift
    if "$@" >/dev/null 2>&1; then printf '  OK %s\n' "$description"
    else printf '  FAIL %s\n' "$description"; fail=1; fi
}
backend_loopback_only() {
    local addresses
    addresses="$(ss -H -ltn 'sport = :3000' | awk '{print $4}')"
    [ "$addresses" = 127.0.0.1:3000 ]
}
http_status() {
    local expected="$1" url="$2" actual
    actual="$(curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "$url")" || return 1
    [ "$actual" = "$expected" ]
}
check "school-wall is active" systemctl is-active --quiet school-wall
check "nginx is active" systemctl is-active --quiet nginx
# Retry actual database health, not merely a static page that nginx serves itself.
check "backend/database health through nginx" curl -fsS --connect-timeout 2 --max-time 5 --retry 8 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PROXY_PORT/api/health"
check "backend listens only on 127.0.0.1:3000" backend_loopback_only
check "frontend returns 200" http_status 200 "http://127.0.0.1:$PROXY_PORT/"
check "unknown API returns 404" http_status 404 "http://127.0.0.1:$PROXY_PORT/api/nope"
if [ "$fail" != 0 ]; then
    echo "Check journalctl -u school-wall -n 50 and nginx error logs." >&2; exit 1
fi
echo "Deployment checks passed. Proxy port: $PROXY_PORT. No default administrator account."
echo "Complete first-time setup through a local/SSH connection before enabling public access."
