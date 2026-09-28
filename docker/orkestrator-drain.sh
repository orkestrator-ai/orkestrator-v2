#!/bin/bash
# Graceful drain of every workload process before an explicit stop.
#
# Drain contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY graceful-shutdown=1
#
# Run by the backend as root through `docker exec` immediately before
# `docker stop`. Docker's own stop only signals PID 1, so processes started by
# `docker exec` (bridges, terminals, dev servers) would otherwise be killed
# without a chance to flush journals and transcripts. This signals each of
# them with SIGTERM, waits up to the grace period, and reports what remained.
# It does not escalate: the caller's `docker stop` does, and records a forced
# outcome when it had to.
#
# Output (one line): ORKESTRATOR_DRAIN signalled=<n> remaining=<n>
set -u

GRACE_SECONDS="${1:-10}"
case "$GRACE_SECONDS" in
    ''|*[!0-9]*) GRACE_SECONDS=10 ;;
esac
[ "$GRACE_SECONDS" -gt 60 ] && GRACE_SECONDS=60

KEEPALIVE_PID="$(cat /run/orkestrator/keepalive.pid 2>/dev/null || true)"
SELF=$$
PARENT=$PPID

# The keepalive and every process between it and PID 1 hold the container
# open. Under `--init` the entrypoint's `sudo` sits in that chain; signalling
# it would take the keepalive (and the container) down with it.
PROTECTED=" "
pid="$KEEPALIVE_PID"
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    PROTECTED="${PROTECTED}${pid} "
    pid="$(awk '/^PPid:/ {print $2}' "/proc/$pid/status" 2>/dev/null)"
done

# True when the process descends from this script (its own subshells and the
# `ps`/`awk` they run are not workload).
is_own_descendant() {
    local current="$1" depth=0
    while [ -n "$current" ] && [ "$current" -gt 1 ] 2>/dev/null && [ "$depth" -lt 64 ]; do
        [ "$current" = "$SELF" ] && return 0
        current="$(awk '/^PPid:/ {print $2}' "/proc/$current/status" 2>/dev/null)"
        depth=$((depth + 1))
    done
    return 1
}

workload_pids() {
    local pid
    for pid in $(ps -eo pid= 2>/dev/null); do
        # PID 1, the keepalive chain, this script and the exec shell that
        # launched it are not workload.
        [ "$pid" -le 1 ] && continue
        [ "$pid" = "$SELF" ] && continue
        [ "$pid" = "$PARENT" ] && continue
        case "$PROTECTED" in *" $pid "*) continue ;; esac
        # Skip processes that already exited between listing and signalling.
        [ -d "/proc/$pid" ] || continue
        # Zombies are already dead; init reaps them.
        [ "$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" = "Z" ] && continue
        is_own_descendant "$pid" && continue
        echo "$pid"
    done
}

signalled=0
for pid in $(workload_pids); do
    if kill -TERM "$pid" 2>/dev/null; then
        signalled=$((signalled + 1))
    fi
done

deadline=$(( $(date +%s) + GRACE_SECONDS ))
remaining="$(workload_pids | wc -l)"
while [ "$remaining" -gt 0 ] && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 0.2
    remaining="$(workload_pids | wc -l)"
done

echo "ORKESTRATOR_DRAIN signalled=${signalled} remaining=${remaining}"
