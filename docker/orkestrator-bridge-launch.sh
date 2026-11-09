#!/bin/sh
# Start a bridge with nothing the agent's uid could have prepared.
#
# Bridge launch contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY bridge-launch=1
# ORKESTRATOR_CAPABILITY opencode-launch=1
#
#   docker exec -i --user node --workdir / <container> \
#     /usr/local/bin/orkestrator-bridge-launch <kind> <environment-snapshot>
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
# `opencode` starts the container's OpenCode server the same way, from the
# root-owned /opt/opencode binary in /workspace, with only the configuration
# the backend wrote as root to /run/orkestrator-opencode: no project
# configuration (/workspace/.opencode, opencode.json), no ~/.config/opencode
# and no ~/.opencode, all of which node can write and any of which could add a
# plugin that runs inside the server. The OpenCode variables below are set
# after the backend's, so stdin cannot change them. Its credential plugin
# applies the snapshot for the tools the server runs
# (agent-credential-files.ts).
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
# OpenCode's server inherits this script's environment (see below), so it
# starts again with nothing but its own arguments and stdin.
if [ "${1:-}" = opencode ] && [ "${ORKESTRATOR_BRIDGE_LAUNCH_CLEAN:-}" != 1 ]; then
    exec /usr/bin/env -i ORKESTRATOR_BRIDGE_LAUNCH_CLEAN=1 PATH=/usr/sbin:/usr/bin:/sbin:/bin \
        /bin/sh /usr/local/bin/orkestrator-bridge-launch "$@"
fi
[ "$#" -eq 2 ] || fail "usage: orkestrator-bridge-launch <kind> <environment-snapshot>"
kind="$1"
snapshot="$2"
extra=""
workdir=/
case "$kind" in
    claude) entry=/opt/claude-bridge/dist/index.js log=/tmp/claude-bridge.log ;;
    codex) entry=/opt/codex-bridge/dist/index.js log=/tmp/codex-bridge.log ;;
    cursor) entry=/opt/cursor-bridge/dist/index.js log=/tmp/cursor-bridge.log ;;
    pi) entry=/opt/pi-bridge/dist/index.js log=/tmp/pi-bridge.log ;;
    grok) entry=/opt/acp-bridge/dist/index.js log=/tmp/grok-acp-bridge.log extra=--provider=grok ;;
    # The compiled binary reads no bunfig.toml or .env from its working
    # directory; OpenCode answers a request without one for its own.
    opencode) entry="" log=/tmp/opencode-serve.log workdir=/workspace ;;
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

cd "$workdir"
if [ "$kind" = opencode ]; then
    # OpenCode compares the plain password, so unlike a bridge's verifier it
    # can never be an argument: every process's argv is readable by node. It
    # goes into this short-lived script's environment, which re-ran itself
    # under `env -i` above, and from there into the server's alone. The log
    # writer reads a FIFO and starts under `env -i`, so no long-lived process
    # but the server holds it.
    for line in "$@"; do export "$line"; done
    export ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT="$snapshot" ORKESTRATOR_BRIDGE_LAUNCH_KEYS="$keys"
    export PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/node USER=node LOGNAME=node LANG=C.UTF-8
    export XDG_CONFIG_HOME=/run/orkestrator-opencode/config
    export OPENCODE_TEST_HOME=/run/orkestrator-opencode/home
    export OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_AUTOUPDATE=1
    # Project configuration off also drops the checkout's AGENTS.md from the
    # instructions; it is text, not code, so it is named back in.
    export OPENCODE_CONFIG_CONTENT='{"instructions":["/workspace/AGENTS.md"]}'
    export OPENCODE_SERVER_USERNAME=opencode
    unset ORKESTRATOR_BRIDGE_LAUNCH_CLEAN
    fifo_dir=$(mktemp -d /tmp/.orkestrator-opencode-launch.XXXXXX)
    mkfifo "$fifo_dir/log"
    setsid /usr/bin/env -i PATH=/usr/bin:/bin /usr/local/bin/orkestrator-log-writer "$log" \
        <"$fifo_dir/log" >/dev/null 2>&1 &
    exec 3>"$fifo_dir/log"
    rm -rf "$fifo_dir"
    setsid /opt/opencode/bin/opencode serve --port 4096 --hostname 0.0.0.0 \
        </dev/null >&3 2>&3 3>&- &
    exit 0
fi
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
