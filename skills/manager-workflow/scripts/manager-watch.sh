#!/usr/bin/env bash
# usage: manager-watch.sh [--init | --follow]
# Reports tabs in manager-tabs.tsv that turned done/blocked/error. Each report
# saves the tab's full last reply to $REPORTS/tab<N>-<time>.md and prints the path.
set -uo pipefail
export LC_ALL=${LC_ALL:-en_US.UTF-8}
S=${MANAGER_AGENT_SESSION:-worker}
TSV=${MANAGER_TABS:-$HOME/.pi/manager-tabs.tsv}
SEEN=$HOME/.pi/manager-watch.seen
REPORTS=${MANAGER_REPORTS:-$HOME/.pi/manager-reports}
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
mkdir -p "$REPORTS"
touch "$SEEN"

report() {
  local n=$1 b=$2 st=$3 ts=$4 label screen file
  label=$(awk -F'\t' -v n="$n" '$1==n{print $4}' "$TSV" | tail -1)
  screen=$(rex capture -s "$S" -b "$b" --trim --unwrap 2>/dev/null)
  file="$REPORTS/tab$n-$(date +%Y%m%dT%H%M%S).md"
  if ! printf '%s\n' "$screen" | python3 "$HERE/last-reply.py" > "$file" 2>/dev/null; then
    printf '%s\n' "$screen" | grep -v -E '^\s*$|^─|TPS |↑|~/Github|Elapsed' | tail -80 > "$file"
  fi
  echo "===== tab $n state=$st at $ts ($label) report=$file"
  case "$st" in
    blocked|error) printf '%s\n' "$screen" | grep -v -E '^\s*$|^─|TPS |↑|~/Github|Elapsed' | tail -"${LINES_OUT:-12}" | cut -c1-170 ;;
    *) head -c 1200 "$file" | cut -c1-170 ;;
  esac
  echo
  awk -F'\t' -v n="$n" '$1!=n' "$SEEN" > "$SEEN.tmp"; printf '%s\t%s\n' "$n" "$ts" >> "$SEEN.tmp"; mv "$SEEN.tmp" "$SEEN"
}

pending() {
  local found=0
  while IFS=$'\t' read -r n w b rest; do
    [ "$n" = 0 ] && continue
    [ -z "$b" ] && continue
    rec=$(rex block call -s "$S" -b "$b" program_status 2>/dev/null | jq -r '.records[0]|"\(.state)\t\(.updated_at)"' 2>/dev/null) || continue
    st=${rec%%$'\t'*}; ts=${rec#*$'\t'}
    case "$st" in done|blocked|error) ;; *) continue;; esac
    if [ "$st" = done ] && rex capture -s "$S" -b "$b" --trim --unwrap 2>/dev/null | tail -8 | grep -q -E '[0-9]+ running agents?|⠙|⠋|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏'; then
      continue
    fi
    last=$(awk -F'\t' -v n="$n" '$1==n{print $2}' "$SEEN")
    [ "$ts" = "$last" ] && continue
    report "$n" "$b" "$st" "$ts"; found=1
  done < <(awk -F'\t' '{last[$1]=$0} END{for(k in last) print last[k]}' "$TSV")
  return $((1-found))
}

if [ "${1:-}" = "--init" ]; then
  while IFS=$'\t' read -r n w b rest; do
    [ -z "$b" ] && continue
    ts=$(rex block call -s "$S" -b "$b" program_status 2>/dev/null | jq -r '.records[0].updated_at // empty')
    [ -n "$ts" ] && printf '%s\t%s\n' "$n" "$ts"
  done < <(awk -F'\t' '{last[$1]=$0} END{for(k in last) print last[k]}' "$TSV") > "$SEEN"
  echo "seeded $(wc -l < "$SEEN") tabs"; exit 0
fi

if [ "${1:-}" != "--follow" ]; then pending && exit 0; else pending; fi

if [ "${1:-}" = "--follow" ]; then
  ( while sleep "${SWEEP_SECONDS:-120}"; do pending || true; done ) &
  trap 'kill $! 2>/dev/null' EXIT
fi

rex events -s "$S" --json | while IFS= read -r line; do
  ev=$(jq -r 'select(.payload.event.type=="block_event") | .payload.event.payload | select(.name=="program_status_changed" or .name=="desktop_notification") | .name' <<<"$line" 2>/dev/null)
  [ -z "$ev" ] && continue
  sleep 5
  if [ "${1:-}" = "--follow" ]; then pending; else if pending; then pkill -P $$ rex 2>/dev/null || true; exit 0; fi; fi
done
