#!/usr/bin/env bash
# usage:
#   manager-tab.sh list
#   manager-tab.sh new <n> <label> [--cwd DIR] [-- COMMAND...]   (default command: pi)
#   manager-tab.sh rename <n> <label>
#   manager-tab.sh close <n>
# Keeps manager-tabs.tsv (tab, window, block, label) in sync with the Rex worker session.
set -euo pipefail
S=${MANAGER_AGENT_SESSION:-worker}
TSV=${MANAGER_TABS:-$HOME/.pi/manager-tabs.tsv}
touch "$TSV"

field() { awk -F'\t' -v n="$1" -v f="$2" '$1==n{v=$f} END{print v}' "$TSV"; }
drop() { awk -F'\t' -v n="$1" '$1!=n' "$TSV" > "$TSV.tmp"; mv "$TSV.tmp" "$TSV"; }

cmd=${1:-list}; shift || true
case "$cmd" in
  list)
    while IFS=$'\t' read -r n w b label; do
      st=$(rex block call -s "$S" -b "$b" program_status 2>/dev/null | jq -r '.records[0].state // "gone"')
      printf '%s\t%s\t%s\n' "$n" "$st" "$label"
    done < <(sort -n "$TSV")
    ;;
  new)
    n=$1; label=$2; shift 2
    [ -z "$(field "$n" 3)" ] || { echo "tab $n already registered" >&2; exit 2; }
    cwd=$PWD
    if [ "${1:-}" = "--cwd" ]; then cwd=$2; shift 2; fi
    [ "${1:-}" = "--" ] && shift
    [ $# -gt 0 ] || set -- pi
    w=$(rex window new -s "$S" "$n $label" --cwd "$cwd" --focus=false --keep-open --json -- "$@" | jq -r .window_id)
    b=""
    for _ in 1 2 3 4 5; do
      b=$(rex block list -s "$S" --json | jq -r --arg w "$w" '.blocks[]|select(.window_id==$w)|.block_id' | head -1)
      [ -n "$b" ] && break
      sleep 1
    done
    [ -n "$b" ] || { echo "no block for $w" >&2; exit 1; }
    printf '%s\t%s\t%s\t%s\n' "$n" "$w" "$b" "$label" >> "$TSV"
    echo "tab $n: $w $b ($label)"
    ;;
  rename)
    n=$1; label=$2
    w=$(field "$n" 2); [ -n "$w" ] || { echo "tab $n not registered" >&2; exit 2; }
    rex window rename -s "$S" "$w" "$n $label" >/dev/null
    awk -F'\t' -v OFS='\t' -v n="$n" -v l="$label" '$1==n{$4=l} {print}' "$TSV" > "$TSV.tmp"; mv "$TSV.tmp" "$TSV"
    echo "tab $n: $label"
    ;;
  close)
    n=$1
    w=$(field "$n" 2); [ -n "$w" ] || { echo "tab $n not registered" >&2; exit 2; }
    rex window close -s "$S" "$w" >/dev/null 2>&1 || true
    drop "$n"
    echo "tab $n closed"
    ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
