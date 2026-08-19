#!/usr/bin/env bash
# Cross-compile static binaries. Do not commit the output.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$DIR/dist}"
mkdir -p "$OUT"
cd "$DIR"
for spec in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do
  os="${spec%/*}"
  arch="${spec#*/}"
  ext=""
  [[ "$os" == windows ]] && ext=".exe"
  name="lookup-${os}-${arch}${ext}"
  echo "building $name"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$OUT/$name" .
done
echo "binaries in $OUT"
