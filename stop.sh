#!/usr/bin/env bash
# Stop only a development supervisor started from this checkout.
set -euo pipefail
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command -v node >/dev/null || { echo "Node.js is required to verify process ownership" >&2; exit 1; }
exec node "$APP_ROOT/deploy/development.cjs" stop "$@"
