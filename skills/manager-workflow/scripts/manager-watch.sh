#!/usr/bin/env bash
# usage: manager-watch.sh [--init | --follow]
# Reports tabs in manager-tabs.tsv that turned done/blocked/error, using the program
# status each tab's program reports to Rex (OSC 7501): state, kind and message.
# Each report saves the tab's full last reply to $REPORTS/tab<N>-<time>.md.
# A tab that stays blocked is reported again every $REALERT_SECONDS.
set -uo pipefail
export LC_ALL=${LC_ALL:-en_US.UTF-8}
S=${MANAGER_AGENT_SESSION:-worker}
TSV=${MANAGER_TABS:-$HOME/.pi/manager-tabs.tsv}
SEEN=${MANAGER_SEEN:-$HOME/.pi/manager-watch.seen}
REPORTS=${MANAGER_REPORTS:-$HOME/.pi/manager-reports}
REALERT=${REALERT_SECONDS:-300}
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
mkdir -p "$REPORTS"
touch "$SEEN"

epoch() { date -j -f '%Y-%m-%dT%H:%M:%S' "${1%%.*}" +%s 2>/dev/null || date -d "$1" +%s; }

status_of() {
  rex block call -s "$S" -b "$1" program_status 2>/dev/null \
    | jq -r '.records | (map(select(.id == null)) + .)[0] // {} | [.state // "", .kind // "", .updated_at // "", (.msg // "")] | @tsv'
}

report() {
  local n=$1 b=$2 st=$3 kind=$4 ts=$5 msg=$6 label screen file note=""
  label=$(awk -F'\t' -v n="$n" '$1==n{print $4}' "$TSV" | tail -1)
  screen=$(rex capture -s "$S" -b "$b" --trim --unwrap 2>/dev/null)
  file="$REPORTS/tab$n-$(date +%Y%m%dT%H%M%S).md"
  if ! printf '%s\n' "$screen" | python3 "$HERE/last-reply.py" > "$file" 2>/dev/null; then
    printf '%s\n' "$screen" | grep -v -E '^\s*$|^─|TPS |↑|~/Github|Elapsed' | tail -80 > "$file"
  fi
  [ -n "$kind" ] && note=" kind=$kind"
  [ -n "$msg" ] && note="$note msg=$(printf '%s' "$msg" | cut -c1-120)"
  printf '\n===== tab %s state=%s%s at %s (%s) report=%s\n' "$n" "$st" "$note" "$ts" "$label" "$file"
  case "$st" in
    blocked|error) printf '%s\n' "$screen" | grep -v -E '^\s*$|^─|TPS |↑|~/Github|Elapsed' | tail -"${LINES_OUT:-12}" | cut -c1-170 ;;
    *) head -c 1200 "$file" | cut -c1-170 ;;
  esac
  echo
  awk -F'\t' -v n="$n" '$1!=n' "$SEEN" > "$SEEN.tmp"
  printf '%s\t%s\t%s\n' "$n" "$ts" "$(date +%s)" >> "$SEEN.tmp"
  mv "$SEEN.tmp" "$SEEN"
}

pending() {
  local found=0 now lock="$SEEN.lock"
  mkdir "$lock" 2>/dev/null || return 1
  trap 'rmdir "$lock" 2>/dev/null' RETURN
  now=$(date +%s)
  while IFS=$'\t' read -r n w b rest; do
    [ "$n" = 0 ] && continue
    [ -z "$b" ] && continue
    IFS=$'\t' read -r st kind ts msg < <(status_of "$b")
    case "$st" in done|blocked|error) ;; *) continue;; esac
    if [ "$st" = done ] && rex capture -s "$S" -b "$b" --trim --unwrap 2>/dev/null | tail -8 | grep -q -E '[0-9]+ running agents?|⠙|⠋|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏'; then
      continue
    fi
    seen=$(awk -F'\t' -v n="$n" '$1==n{print $2"\t"$3}' "$SEEN")
    last_ts=${seen%%$'\t'*}
    last_at=${seen#*$'\t'}
    if [ "$ts" = "$last_ts" ]; then
      [ "$st" = blocked ] || continue
      [ -n "$last_at" ] && [ $((now - last_at)) -lt "$REALERT" ] && continue
      st="blocked-still($(( (now - $(epoch "$ts")) / 60 ))m)"
    fi
    report "$n" "$b" "$st" "$kind" "$ts" "$msg"; found=1
  done < <(awk -F'\t' '{last[$1]=$0} END{for(k in last) print last[k]}' "$TSV")
  return $((1-found))
}

if [ "${1:-}" = "--init" ]; then
  while IFS=$'\t' read -r n w b rest; do
    [ -z "$b" ] && continue
    IFS=$'\t' read -r st kind ts msg < <(status_of "$b")
    [ -n "$ts" ] && printf '%s\t%s\t%s\n' "$n" "$ts" "$(date +%s)"
  done < <(awk -F'\t' '{last[$1]=$0} END{for(k in last) print last[k]}' "$TSV") > "$SEEN"
  echo "seeded $(wc -l < "$SEEN") tabs"; exit 0
fi

if [ "${1:-}" != "--follow" ]; then pending && exit 0; else pending; fi

( while sleep "${SWEEP_SECONDS:-60}"; do pending || true; done ) &
trap 'kill $! 2>/dev/null' EXIT

rex events -s "$S" --json | while IFS= read -r line; do
  ev=$(jq -r 'select(.payload.event.type=="block_event") | .payload.event.payload | select(.name=="program_status_changed" or .name=="desktop_notification") | .name' <<<"$line" 2>/dev/null)
  [ -z "$ev" ] && continue
  sleep 3
  pending || true
done
