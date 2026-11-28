#!/bin/bash
# Install locked dependencies, rebuild the client, then run in the foreground.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
CLIENT_DIR="$SCRIPT_DIR/client"
PORT="${PORT:-3000}"
MODE=run
API_ONLY=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prepare-only) MODE=prepare ;;
        --check) MODE=check ;;
        --api-only|--backend-only) API_ONLY=1 ;;
        --port|-p)
            [ "$#" -ge 2 ] || { echo "Missing port" >&2; exit 1; }
            PORT="$2"; shift ;;
        --help|-h)
            echo "Usage: bash deploy.sh [PORT | --port PORT] [--prepare-only | --check] [--api-only]"
            echo "--api-only installs/checks only the backend and starts with SERVE_CLIENT=0."
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
command -v node >/dev/null || { echo "Install Node.js >=22.13.0 first" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
node "$SCRIPT_DIR/deploy/check-runtime.cjs"
directories=("$SERVER_DIR")
if [ "$API_ONLY" = 0 ]; then directories+=("$CLIENT_DIR"); fi
for directory in "${directories[@]}"; do
    [ -f "$directory/package-lock.json" ] || { echo "Missing lockfile: $directory/package-lock.json" >&2; exit 1; }
done

if [ "$MODE" = check ]; then
    node "$SCRIPT_DIR/deploy/check-runtime.cjs" --server --sharp
    if [ "$API_ONLY" = 0 ]; then
        [ -f "$CLIENT_DIR/dist/index.html" ] || { echo "Missing client build; run bash deploy.sh --prepare-only" >&2; exit 1; }
    fi
    echo "Installed prerequisites are ready. No application was started."
    exit 0
fi

if [ "$API_ONLY" = 1 ]; then
    node "$SCRIPT_DIR/deploy/check-idle.cjs" --backend-only
else
    node "$SCRIPT_DIR/deploy/check-idle.cjs"
fi
echo "[1/3] Installing locked server dependencies (including sharp native packages)..."
(cd "$SERVER_DIR" && npm ci --omit=dev --include=optional)
node "$SCRIPT_DIR/deploy/check-runtime.cjs" --server --sharp

if [ "$API_ONLY" = 0 ]; then
    echo "[2/3] Installing locked client dependencies and rebuilding..."
    (cd "$CLIENT_DIR" && npm ci --include=dev --include=optional && npm run build)
    [ -f "$CLIENT_DIR/dist/index.html" ] || { echo "Client build output is missing" >&2; exit 1; }
else
    echo "[2/3] API-only mode; no frontend dependencies or build required."
fi
# The server installer additionally makes static assets readable by the nginx user.
if [ "$MODE" = prepare ]; then
    echo "Selected dependencies and build are ready. No application was started."
    exit 0
fi

cd "$SERVER_DIR"
export PORT
export HOST="${HOST:-127.0.0.1}"
export NODE_ENV="${NODE_ENV:-production}"
# Routine deployment must never trigger KEEP_DB=0's destructive rebuild.
export KEEP_DB=1
export SERVE_CLIENT=$((1 - API_ONLY))

echo "[3/3] Starting the server in the foreground..."
if [ "$API_ONLY" = 0 ]; then echo "Frontend: http://localhost:$PORT"
else echo "API: http://localhost:$PORT/api/health"; fi
echo "Dashboard: http://localhost:$PORT/dashboard"
echo "No default account. Complete first-time setup locally before exposing the site."
echo "Listen address: $HOST:$PORT; press Ctrl+C to stop."
exec node index.js
