#!/usr/bin/env bash
# usage: manager-autoapprove.sh [tab...]
# Approves safe permission prompts in Rex tabs. With no tabs given, it watches every
# tab in manager-tabs.tsv and picks up tabs added or removed while it runs.
S=${MANAGER_AGENT_SESSION:-worker}
TSV=${MANAGER_TABS:-$HOME/.pi/manager-tabs.tsv}
fixed="$*"
declare -A last_needs
while true; do
  tabs=${fixed:-$(awk -F'\t' '$1!=0 && $3!=""{print $1}' "$TSV" | sort -un)}
  for n in $tabs; do
    B=$(awk -F'\t' -v n="$n" '$1==n{b=$3} END{print b}' "$TSV")
    [ -n "$B" ] || continue
    st=$(rex block call -s "$S" -b "$B" program_status 2>/dev/null | jq -r '.records[0] | "\(.state)|\(.kind)"')
    [ "$st" = "blocked|permission" ] || continue
    scr=$(rex capture -s "$S" -b "$B" --trim --unwrap 2>/dev/null | sed -n '/Confirm external or irreversible action/,$p')
    q=$(printf '%s\n' "$scr" | sed -n '2p')
    body=$(printf "%s\n" "$scr" | sed -n "3,40p" | tr "\n" " " | tr -s " ")
    ok=0
    case "$q" in
      *"Allow git push?"*)
        printf '%s' "$body" | grep -q -E 'push[^|;&]*(origin|-u)[^|;&]* (main|master)( |$)|:main|--force( |$)|--delete' || ok=1 ;;
      *"Allow GitHub pull-request mutation?"*)
        printf '%s' "$body" | grep -q -E 'gh pr (merge|close)|--admin' || ok=1 ;;
      *"Allow recursive deletion?"*)
        printf '%s' "$body" | grep -q -E '(rm -rf[^;&|]*|git worktree remove[^;&|]*)(~/wt/|/tmp/|\.terraform( |$))' && ! printf '%s' "$body" | grep -q -E 'rm -rf +(~|/|\$HOME)( |/?$)' && ok=1 ;;
    esac
    if [ $ok = 1 ]; then
      rex send-key -s "$S" -b "$B" enter >/dev/null
      echo "$(date '+%FT%T') tab $n approved: $q $(printf '%s' "$body" | tr '\n' ' ' | cut -c1-160)"
    else
      key="$n|$(printf '%s' "$q$body" | cksum | cut -d' ' -f1)"
      if [ "$key" != "${last_needs[$n]:-}" ]; then
        echo "$(date '+%FT%T') tab $n NEEDS MANAGER: $q $(printf '%s' "$body" | tr '\n' ' ' | cut -c1-200)"
        last_needs[$n]=$key
      fi
    fi
  done
  sleep 10
done
