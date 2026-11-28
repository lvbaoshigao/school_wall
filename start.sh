#!/usr/bin/env bash
# Start the development backend and Vite in the foreground. Ctrl+C stops both.
set -euo pipefail
umask 077
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command -v node >/dev/null || { echo "Install Node.js >=22.13.0 first" >&2; exit 1; }
exec node "$APP_ROOT/deploy/development.cjs" start "$@"
