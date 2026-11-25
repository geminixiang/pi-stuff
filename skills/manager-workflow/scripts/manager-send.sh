#!/usr/bin/env bash
# usage: manager-send.sh <tab-number> <message | @file>
set -uo pipefail
S=${MANAGER_AGENT_SESSION:-worker}
TSV=${MANAGER_TABS:-$HOME/.pi/manager-tabs.tsv}
n=$1; shift
msg=$*
[ "${msg:0:1}" = "@" ] && msg=$(cat "${msg:1}")
msg=$(printf '%s' "$msg" | sed -E 's/[。.[:space:]]+$//')
B=$(awk -F'\t' -v n="$n" '$1==n{b=$3} END{print b}' "$TSV")
[ -n "$B" ] || { echo "tab $n not in $TSV" >&2; exit 2; }

screen() { rex capture -s "$S" -b "$B" --trim --unwrap 2>/dev/null; }
status() { rex block call -s "$S" -b "$B" program_status 2>/dev/null | jq -r '.records[0] | "\(.state // "unknown")\t\(.updated_at // "")"'; }
clear_input() { for _ in $(seq 1 "${1:-60}"); do rex send-key -s "$S" -b "$B" backspace >/dev/null; done; }

before=$(status)
before_state=${before%%$'\t'*}
probe=$(printf '%s' "$msg" | tr -s '[:space:]' ' ' | cut -c1-40)
rex send -s "$S" -b "$B" "$msg" || { echo "send failed" >&2; exit 1; }
sleep 1
rex send-key -s "$S" -b "$B" escape >/dev/null
sleep 0.5
tail_txt=$(screen | grep -v -E '^\s*$|^─|TPS |↑|^~/|Elapsed' | tail -3 | tr -d '\n')
if printf '%s' "$tail_txt" | grep -q -E '\.[A-Za-z_-]+/$'; then
  junk=$(printf '%s' "$tail_txt" | grep -o -E '\.[A-Za-z_-]+/$')
  clear_input "${#junk}"
  echo "removed autocomplete junk: $junk" >&2
fi
rex send-key -s "$S" -b "$B" enter >/dev/null
for _ in 1 2 3 4 5 6; do
  sleep 3
  now=$(status)
  st=${now%%$'\t'*}
  if [ "$st" = working ]; then echo "tab $n: sent, working"; exit 0; fi
  if screen | grep -q 'Option+Up to edit all queued messages'; then echo "tab $n: queued (agent busy: $before_state)"; exit 0; fi
  if [ "$now" != "$before" ] && screen | tr -s '[:space:]' ' ' | grep -qF "$probe"; then
    echo "tab $n: sent, already $st"; exit 0
  fi
done
echo "tab $n: NOT CONFIRMED (state=$(status | cut -f1)); last lines:" >&2
screen | tail -5 | cut -c1-160 >&2
exit 3
