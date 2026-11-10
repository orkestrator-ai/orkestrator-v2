#!/bin/sh
# Start a bridge with nothing the agent's uid could have prepared.
#
# Bridge launch contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY bridge-launch=1
#
#   docker exec -i --user node --workdir / <container> \
#     /usr/local/bin/orkestrator-bridge-launch <kind> <environment-snapshot>
#
# It prints `orkestrator-bridge-session=<id>`, the session the bridge runs in.
# A launcher from before that line prints nothing, and the backend then
# records the bridge's socket without the session check.
#
# The backend's start script runs as node in a login shell, so it reads
# ~/.bash_profile, ~/.profile and the /tmp/orkestrator-ai snapshot, all of which
# node can write: a function, BUN_OPTIONS or LD_PRELOAD planted there would run
# inside the bridge and see each token presented to it. So that script only
# prepares, and records the environment it built in <environment-snapshot>.
# This script, root-owned and run by the backend's own exec rather than from
# that shell, starts the bridge under `env -i`: a fixed PATH of root-owned
# directories, a root-owned working directory (no bunfig.toml, no .env) and
# only the variables the backend wrote to stdin (NAME=VALUE, one per line: the
# token's verifier, the authority key, the port). The bridge applies the
# snapshot to its own environment once it is running, for the agents it
# spawns, where a loader variable can no longer reach it
# (packages/protocol/src/node/bridge-launch-environment.ts).
#
# /bin/sh is dash, which reads no startup file when non-interactive; bash
# would source $BASH_ENV.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

fail() {
    printf 'orkestrator-bridge-launch: %s\n' "$1" >&2
    exit "${2:-64}"
}

[ "$(id -u)" -ne 0 ] || fail "refusing to run a bridge as root"
[ "$#" -eq 2 ] || fail "usage: orkestrator-bridge-launch <kind> <environment-snapshot>"
kind="$1"
snapshot="$2"
extra=""
case "$kind" in
    claude) entry=/opt/claude-bridge/dist/index.js log=/tmp/claude-bridge.log ;;
    codex) entry=/opt/codex-bridge/dist/index.js log=/tmp/codex-bridge.log ;;
    cursor) entry=/opt/cursor-bridge/dist/index.js log=/tmp/cursor-bridge.log ;;
    pi) entry=/opt/pi-bridge/dist/index.js log=/tmp/pi-bridge.log ;;
    grok) entry=/opt/acp-bridge/dist/index.js log=/tmp/grok-acp-bridge.log extra=--provider=grok ;;
    *) fail "unknown bridge: $kind" ;;
esac
case "$snapshot" in
    /tmp/.orkestrator-bridge-env-"$kind"-*) ;;
    *) fail "the environment snapshot must be this bridge's" ;;
esac
case "${snapshot#/tmp/.orkestrator-bridge-env-"$kind"-}" in
    *[!0-9a-f]* | "") fail "the environment snapshot must be this bridge's" ;;
esac

# The backend's variables, kept as separate arguments so no value is ever
# evaluated. Each name is checked; a value cannot hold a newline.
set --
keys=""
while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    name="${line%%=*}"
    [ "$name" != "$line" ] || fail "expected NAME=VALUE on stdin"
    case "$name" in
        "" | [!A-Z]* | *[!A-Z0-9_]*) fail "invalid variable name" ;;
        PATH | HOME | USER | LOGNAME | LANG | ORKESTRATOR_BRIDGE_LAUNCH_*) fail "reserved variable: $name" ;;
    esac
    set -- "$@" "$line"
    keys="${keys:+$keys,}$name"
done

cd /
# A new session, detached from this exec, with every descriptor closed to it,
# so `docker exec` returns once the bridge is started. The log writer is
# root-owned too and gets the same empty environment.
setsid sh -c '
    log="$1" entry="$2" extra="$3" snapshot="$4" keys="$5"
    shift 5
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/node USER=node LOGNAME=node \
        LANG=C.UTF-8 ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT="$snapshot" \
        ORKESTRATOR_BRIDGE_LAUNCH_KEYS="$keys" ORKESTRATOR_BRIDGE_LAUNCH_WORKDIR=/workspace "$@" \
        /usr/local/bin/bun --config=/dev/null --no-env-file "$entry" ${extra:+"$extra"} 2>&1 |
        env -i PATH=/usr/bin:/bin /usr/local/bin/orkestrator-log-writer "$log"
' orkestrator-bridge "$log" "$entry" "$extra" "$snapshot" "$keys" "$@" </dev/null >/dev/null 2>&1 &
# The bridge's session, for the backend to record its socket only while a
# bridge in it lives (container-bridge-listener.ts). dash gives a background
# job no process group of its own, so setsid calls setsid(2) in place rather
# than forking, and the job's pid is the session's id. No process can join
# that session later.
printf 'orkestrator-bridge-session=%s\n' "$!"
