#!/bin/sh
# Compiles the helpers into $1 (default: a temp dir) and prints the directory.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$(mktemp -d /private/tmp/ui-evidence.XXXXXX)}
mkdir -p "$out"
swiftc -O "$here/mouse.swift" -o "$out/mouse"
swiftc -O "$here/compare.swift" -o "$out/compare"
echo "$out"
