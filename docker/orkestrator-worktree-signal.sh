#!/bin/bash
# Container worktree change doorbell.
#
# Worktree signal contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY container-worktree-signal=1
#
#   orkestrator-worktree-signal start    curl config on stdin; replaces any watcher
#   orkestrator-worktree-signal watch    the watcher itself (started by `start`)
#
# The backend serves a quiet container's Files panel from its last scan while
# this watcher is confirmed, so every change it can see must ring. A ring
# carries no paths or content: the backend rescans the whole worktree, so an
# overflow costs nothing extra. The reason header only ever makes the backend
# do more work (`ready` confirms the watches, `lost` drops back to timers).
#
# Excluded from the watches: node_modules (the tree skips it and its watch
# count is unbounded), Git's object store, logs and transient Git lock files.
# A Git-visible change there is caught by the backend's safety scan.
set -u
root="${ORKESTRATOR_WORKTREE_SIGNAL_ROOT:-/workspace}"
config="${ORKESTRATOR_WORKTREE_SIGNAL_CONFIG:-/tmp/.orkestrator-worktree-signal}"
pidfile="$config.pid"
# One ring per burst: after this much quiet, or this long after the burst began.
settle="${ORKESTRATOR_WORKTREE_SIGNAL_SETTLE:-0.3}"
max_wait_us="${ORKESTRATOR_WORKTREE_SIGNAL_MAX_WAIT_US:-1000000}"
# Keep legitimate separated bursts below the receiver's flood threshold.
min_gap_us=1000000
# Convert fractional seconds without depending on an external calculator.
printf -v settle_us '%.0f' "${settle}e6"
exclude='(^|/)node_modules(/|$)|/\.git/(objects|logs|lfs|rr-cache|modules)(/|$)|/\.git/.*\.lock$'

ring() {
  [ -r "$config" ] || return 0
  # Detached, bounded, and never with the credential in argv.
  curl --config "$config" --request POST --silent --fail --noproxy '*' \
    --header "X-Orkestrator-Signal: $1" --connect-timeout 2 --max-time 3 \
    --output /dev/null </dev/null >/dev/null 2>&1 &
}

stop_previous() {
  local pid
  [ -r "$pidfile" ] || return 0
  read -r pid < "$pidfile" || return 0
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac
  # /tmp survives a container restart, so the pid may now be someone else's.
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'orkestrator-worktree-signal watch' || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
}

case "${1:-}" in
  start)
    umask 077
    tmp="$config.$$"
    cat > "$tmp" || { rm -f "$tmp"; exit 1; }
    mv -f "$tmp" "$config" || exit 1
    command -v inotifywait >/dev/null 2>&1 || exit 1
    [ -d "$root" ] || exit 1
    stop_previous
    # Its own session, so a replacement can stop the whole pipeline, and no
    # inherited descriptor keeps this exec open.
    setsid -f "$0" watch </dev/null >/dev/null 2>&1
    exit 0
    ;;
  watch) ;;
  *)
    echo "usage: orkestrator-worktree-signal start|watch" >&2
    exit 2
    ;;
esac

echo "$$" > "$pidfile"
# Stopped by a replacement: its config is already in place, so a `lost` ring
# here would demote the new watcher.
trap 'trap - TERM; kill -TERM 0 2>/dev/null; exit 0' TERM INT HUP

inotifywait --monitor --recursive \
  --event modify,close_write,attrib,create,delete,move,delete_self,move_self \
  --exclude "$exclude" --format 'E %e' "$root" 2>&1 | {
  pending=0
  last_ring_us=0
  while :; do
    if (( pending )); then
      now_us="${EPOCHREALTIME/./}"
      due_us=$(( quiet_us < deadline_us ? quiet_us : deadline_us ))
      (( due_us < last_ring_us + min_gap_us )) && due_us=$(( last_ring_us + min_gap_us ))
      wait_us=$(( due_us - now_us ))
      if (( wait_us <= 0 )); then
        ring "$reason"
        last_ring_us="$now_us"
        pending=0
        continue
      fi
      printf -v timeout '%d.%06d' "$((wait_us / 1000000))" "$((wait_us % 1000000))"
      IFS= read -r -t "$timeout" line
    else
      IFS= read -r line
    fi
    status=$?
    if (( status > 128 )); then continue; fi # quiet/max-wait deadline
    if (( status != 0 )); then
      # Preserve the trailing change even when the event source exits.
      if (( pending )); then sleep "$timeout"; ring "$reason"; fi
      break
    fi
    case "$line" in
      "Watches established.") ring ready; continue ;;
      "E "*) ;;
      *) continue ;;
    esac
    now_us="${EPOCHREALTIME/./}"
    if (( !pending )); then
      pending=1
      deadline_us=$(( now_us + max_wait_us ))
      reason=change
    fi
    quiet_us=$(( now_us + settle_us ))
    case "$line" in *Q_OVERFLOW*) reason=overflow ;; esac
  done
}
# inotifywait ended by itself (watch limit, root removed): stop trusting us.
ring lost
wait
