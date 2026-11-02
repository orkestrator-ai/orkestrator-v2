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
# An interactive shell (the setup terminal, a terminal tab) ignores SIGTERM,
# so waiting for it used to hold every stop for the whole grace period. The
# drain waits only for processes that can act on SIGTERM. Once they have gone,
# each process that ignores SIGTERM but has a controlling terminal gets
# SIGHUP, the signal a closed terminal sends, and is waited for in turn. A
# process that ignores SIGTERM with no terminal, or SIGHUP as well, is not
# waited for: it counts as remaining and goes down with the container.
#
# Output (one line): ORKESTRATOR_DRAIN signalled=<n> remaining=<n> hungup=<n>
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

# True when signal $2 is in process $1's ignored set.
ignores_signal() {
    local mask
    mask="$(awk '/^SigIgn:/ {print $2}' "/proc/$1/status" 2>/dev/null)"
    [ -n "$mask" ] && [ $(( (16#$mask >> ($2 - 1)) & 1 )) -eq 1 ]
}

# True when the process has a controlling terminal. The command name in
# /proc/<pid>/stat may contain spaces, so fields are counted after it:
# state ppid pgrp session tty_nr.
has_terminal() {
    local stat
    stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
    # shellcheck disable=SC2086 # split into the fields after the command name
    set -- ${stat##*) }
    [ "${5:-0}" != 0 ]
}

# The processes worth waiting for: those that can act on SIGTERM and, after
# the hangup (`hup`), those that were hung up.
waited_pids() {
    local pid
    for pid in $(workload_pids); do
        if ! ignores_signal "$pid" 15; then
            echo "$pid"
        elif [ "$1" = hup ] && has_terminal "$pid" && ! ignores_signal "$pid" 1; then
            echo "$pid"
        fi
    done
}

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

wait_for() {
    while [ -n "$(waited_pids "$1")" ] && [ "$(now_ms)" -lt "$deadline" ]; do
        sleep 0.2
    done
}

signalled=0
for pid in $(workload_pids); do
    if kill -TERM "$pid" 2>/dev/null; then
        signalled=$((signalled + 1))
    fi
done

deadline=$(( $(now_ms) + GRACE_SECONDS * 1000 ))
wait_for term

# Hang up interactive shells only now, so the jobs they ran have had the whole
# grace period to finish on SIGTERM.
hungup=0
for pid in $(workload_pids); do
    ignores_signal "$pid" 15 && has_terminal "$pid" || continue
    ignores_signal "$pid" 1 && continue
    if kill -HUP "$pid" 2>/dev/null; then
        hungup=$((hungup + 1))
    fi
done
[ "$hungup" -gt 0 ] && wait_for hup

remaining="$(workload_pids | wc -l)"
echo "ORKESTRATOR_DRAIN signalled=${signalled} remaining=${remaining} hungup=${hungup}"
