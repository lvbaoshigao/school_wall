#!/bin/bash
# Install locked dependencies, rebuild the client, then run in the foreground.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
CLIENT_DIR="$SCRIPT_DIR/client"
PORT="${PORT:-3000}"
MODE=run

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prepare-only) MODE=prepare ;;
        --check) MODE=check ;;
        --port|-p)
            [ "$#" -ge 2 ] || { echo "Missing port" >&2; exit 1; }
            PORT="$2"; shift ;;
        --help|-h)
            echo "Usage: bash deploy.sh [PORT | --port PORT] [--prepare-only | --check]"
            echo "--check only checks installed prerequisites; it does not install, build or start."
            exit 0 ;;
        *)
            if [[ "$1" =~ ^[0-9]+$ ]]; then PORT="$1"
            else echo "Unknown argument: $1" >&2; exit 1; fi ;;
    esac
    shift
done
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$PORT >= 1 && 10#$PORT <= 65535 )) || {
    echo "Port must be an integer between 1 and 65535" >&2; exit 1;
}
PORT=$((10#$PORT))
command -v node >/dev/null || { echo "Install Node.js >=22.12.0 first" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
node "$SCRIPT_DIR/deploy/check-runtime.cjs"
for directory in "$SERVER_DIR" "$CLIENT_DIR"; do
    [ -f "$directory/package-lock.json" ] || { echo "Missing lockfile: $directory/package-lock.json" >&2; exit 1; }
done

if [ "$MODE" = check ]; then
    node "$SCRIPT_DIR/deploy/check-runtime.cjs" --sharp
    [ -f "$CLIENT_DIR/dist/index.html" ] || { echo "Missing client build; run bash deploy.sh --prepare-only" >&2; exit 1; }
    echo "Installed prerequisites and client build exist. No application was started."
    exit 0
fi

echo "[1/3] Installing locked server dependencies (including sharp native packages)..."
(cd "$SERVER_DIR" && npm ci --omit=dev --include=optional)
node "$SCRIPT_DIR/deploy/check-runtime.cjs" --sharp

echo "[2/3] Installing locked client dependencies and rebuilding..."
(cd "$CLIENT_DIR" && npm ci --include=dev --include=optional && npm run build)
[ -f "$CLIENT_DIR/dist/index.html" ] || { echo "Client build output is missing" >&2; exit 1; }
# The server installer additionally makes static assets readable by the nginx user.
if [ "$MODE" = prepare ]; then
    echo "Dependencies and frontend are ready. No application was started."
    exit 0
fi

cd "$SERVER_DIR"
export PORT
export HOST="${HOST:-127.0.0.1}"
export NODE_ENV="${NODE_ENV:-production}"
# Routine deployment must never trigger KEEP_DB=0's destructive rebuild.
export KEEP_DB=1

echo "[3/3] Starting the server in the foreground..."
echo "Frontend: http://localhost:$PORT"
echo "Dashboard: http://localhost:$PORT/dashboard"
echo "No default account. Complete first-time setup locally before exposing the site."
echo "Listen address: $HOST:$PORT; press Ctrl+C to stop."
exec node index.js
