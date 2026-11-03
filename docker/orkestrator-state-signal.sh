#!/bin/sh
# ORKESTRATOR_CAPABILITY claude-state-signal=3
# ORKESTRATOR_CAPABILITY tmux-hook-signal=1
# Usage: orkestrator-state-signal [working|waiting|failed|hook]
# Persist bounded revision/completion counters before ringing. A lost POST
# cannot hide a whole turn. No argument is the install's non-mutating probe.
# `failed` (version 3, the StopFailure hook) is a turn that ended on an API
# error: it bumps the revision but is not a completion. The legacy state file
# remains readable by older backends, which know no `failed`, so it says idle.
# `hook` (tmux-hook-signal=1) is the claude-tmux hook script's doorbell: it
# writes no state and rings the separate tmux hook credential, so a backend
# reads a tab's hook directory when a hook fires instead of on every tick.
state_file="${ORKESTRATOR_STATE_FILE:-/tmp/.claude-state}"
snapshot="${state_file}-snapshot"
case "${1:-}" in
  working|waiting|failed)
    (
      flock -w 1 9 || exit 1
      previous=idle revision=0 completions=0
      if [ -f "$snapshot" ]; then
        read -r previous revision completions < "$snapshot" || exit 1
        case "$previous" in working|waiting|idle|failed) ;; *) exit 1 ;; esac
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
      legacy="$1"
      [ "$legacy" = failed ] && legacy=idle
      printf '%s\n' "$legacy" > "$state_file"
    ) 9>"${snapshot}.lock" || exit 0
    ;;
  "") ;;
  hook) ;;
  *) exit 0 ;;
esac
# Never block the hook on network I/O or expose the credential in argv.
if [ "${1:-}" = hook ]; then
  config="${ORKESTRATOR_TMUX_HOOK_SIGNAL_CONFIG:-/tmp/.orkestrator-tmux-hook-signal}"
else
  config="${ORKESTRATOR_STATE_SIGNAL_CONFIG:-/tmp/.orkestrator-claude-state-signal}"
fi
[ -r "$config" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
curl --config "$config" --request POST --silent --fail --noproxy '*' \
  --connect-timeout 2 --max-time 3 --output /dev/null 9>&- </dev/null >/dev/null 2>&1 &
