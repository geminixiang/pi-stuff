#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -x "$DIR/lookup" ]]; then
  exec "$DIR/lookup" "$@"
fi
exec go run "$DIR/lookup.go" "$@"
