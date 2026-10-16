#!/bin/sh
# ORKESTRATOR_CAPABILITY claude-state-signal=2
# Usage: orkestrator-state-signal [working|waiting]
# Persist bounded revision/completion counters before ringing. A lost POST
# cannot hide a whole turn. No argument is the install's non-mutating probe.
# The legacy state file remains readable by older backends.
state_file="${ORKESTRATOR_STATE_FILE:-/tmp/.claude-state}"
snapshot="${state_file}-snapshot"
case "${1:-}" in
  working|waiting)
    (
      flock -w 1 9 || exit 1
      previous=idle revision=0 completions=0
      if [ -f "$snapshot" ]; then
        read -r previous revision completions < "$snapshot" || exit 1
        case "$previous" in working|waiting|idle) ;; *) exit 1 ;; esac
        case "$revision:$completions" in *[!0-9:]*|:*|*:) exit 1 ;; esac
        [ "${#revision}" -le 14 ] && [ "${#completions}" -le 14 ] || exit 1
      fi
      revision=$((revision + 1))
      if [ "$1" = waiting ] && [ "$previous" = working ]; then
        completions=$((completions + 1))
      fi
      tmp="$snapshot.$$"
      trap 'rm -f "$tmp"' EXIT
      printf '%s %s %s\n' "$1" "$revision" "$completions" > "$tmp" || exit 1
      mv -f "$tmp" "$snapshot" || exit 1
      printf '%s\n' "$1" > "$state_file"
    ) 9>"${snapshot}.lock" || exit 0
    ;;
  "") ;;
  *) exit 0 ;;
esac
# Never block the hook on network I/O or expose the credential in argv.
config="${ORKESTRATOR_STATE_SIGNAL_CONFIG:-/tmp/.orkestrator-claude-state-signal}"
[ -r "$config" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
curl --config "$config" --request POST --silent --fail --noproxy '*' \
  --connect-timeout 2 --max-time 3 --output /dev/null 9>&- </dev/null >/dev/null 2>&1 &
