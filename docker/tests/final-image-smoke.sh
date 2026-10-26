#!/bin/bash
# Final-image smoke test: run the built image and prove what its manifest
# claims, on whatever architecture this host is.
#
#   bash docker/tests/final-image-smoke.sh <image>
#
# - the real entrypoint reaches ready for this boot as the node user;
# - the manifest exists and every agent/runtime version it names is the one
#   the installed CLI reports;
# - every bridge the manifest lists starts from its built entry point and
#   answers /global/health;
# - Codex's code-mode host is installed beside it;
# - Chromium launches for the `node` user.
#
# The container has no network, no host mounts or credentials, and uses full
# network policy to avoid DNS/firewall prerequisites. It is labelled for this
# run and removed on exit. Nothing else is touched.
set -euo pipefail

IMAGE="${1:?usage: final-image-smoke.sh <image>}"
RUN="ork-image-smoke-$$-${RANDOM}"
TOKEN="smoke-${RANDOM}${RANDOM}${RANDOM}"
MANIFEST=/usr/local/share/orkestrator/image-manifest.json

cleanup() { docker rm -f "$RUN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

docker run -d --name "$RUN" --label "orkestrator-image-smoke=$RUN" --network none \
    --shm-size=1g -e NETWORK_MODE=full "$IMAGE" >/dev/null

# Do not accept stale markers: readiness must name PID 1 from this boot.
ready=0
for _ in $(seq 1 120); do
    if docker exec -i "$RUN" bash 2>/dev/null <<'READY'
start=$(awk '{print $22}' /proc/1/stat)
jq -e --arg start "$start" '
    .version == 1 and .phase == "ready" and .pid1Start == $start
' /run/orkestrator/boot-status.json >/dev/null 2>&1
READY
    then
        ready=1
        break
    fi
    [ "$(docker inspect -f '{{.State.Running}}' "$RUN")" = true ] || break
    sleep 1
done
[ "$ready" = 1 ] || fail "entrypoint did not reach ready for the current boot"
docker exec "$RUN" bash -c '
    test "$(stat -c %U "/proc/$(cat /run/orkestrator/keepalive.pid)")" = node &&
    test "$(cat /etc/orkestrator/network-mode)" = full &&
    test -f /tmp/.entrypoint-complete
' || fail "entrypoint did not drop privileges or complete setup"
echo "ok   entrypoint ready (node)"

in_container() {
    docker exec -u node "$RUN" bash -c "$1"
}

manifest="$(docker exec "$RUN" cat "$MANIFEST")" || fail "no image manifest at $MANIFEST"
field() {
    printf '%s' "$manifest" | docker exec -i "$RUN" jq -r "$1"
}

# Run the same regression checks against the installed final-image artifact.
docker exec -i -u node "$RUN" bash -s -- /usr/local/bin/orkestrator-log-writer \
    <"$(dirname "$0")/log-writer-test.sh" || fail "log writer runtime checks failed"
# Close a real docker exec launch session while its detached producer keeps
# writing. The later exec must see output emitted after the launcher exited.
docker exec -i -u node "$RUN" bash -s <<'LAUNCH' || fail "log writer launch session failed"
    mkfifo /tmp/exec-session-start
    setsid bash -c '
        read -r _ </tmp/exec-session-start
        for ((i = 0; i < 30; i++)); do
            printf "session line %s\n" "$i"
            sleep 0.1
        done | /usr/local/bin/orkestrator-log-writer /tmp/exec-session.log 100 2
    ' </dev/null >/dev/null 2>&1 &
LAUNCH
# Release the producer only after the launch exec has returned.
in_container 'printf "start\n" >/tmp/exec-session-start' || fail "producer gate failed"
session_drained=0
for _ in $(seq 1 50); do
    if in_container 'grep -q "session line 29" /tmp/exec-session.log 2>/dev/null'; then
        session_drained=1
        break
    fi
    sleep 0.1
done
[ "$session_drained" = 1 ] || fail "log writer stopped after exec session closed"
echo "ok   bounded log writer (node, detached exec session)"

# Versions: the manifest must name what is installed.
for entry in claude codex opencode grok pi playwright; do
    expected="$(field ".agents.\"$entry\"")"
    # Startup warnings belong on stderr; retain the CLI status and compare its
    # version output rather than the first line of a merged diagnostic stream.
    reported="$(in_container "$entry --version")" || fail "$entry is not runnable"
    case "$reported" in
        *"$expected"*) echo "ok   $entry $expected" ;;
        *) fail "$entry reports '$reported', the manifest says $expected" ;;
    esac
done
for entry in bun node; do
    expected="$(field ".runtimes.\"$entry\"")"
    reported="$(in_container "$entry --version")"
    case "$reported" in
        *"$expected"*) echo "ok   $entry $expected" ;;
        *) fail "$entry reports '$reported', the manifest says $expected" ;;
    esac
done
in_container 'test -x "$(dirname "$(readlink -f "$(command -v codex)")")/codex-code-mode-host" || find /usr/local/share/npm-global -name codex-code-mode-host -type f | grep -q .' \
    || fail "codex-code-mode-host is missing"
echo "ok   codex code-mode host"

# Bridges: each listed bridge starts from its built entry point and is healthy.
bridge_environment() {
    case "$1" in
        claude-bridge) echo "CLAUDE_BRIDGE_TOKEN=$TOKEN" ;;
        codex-bridge) echo "CODEX_BRIDGE_TOKEN=$TOKEN CODEX_PATH=\$(command -v codex)" ;;
        cursor-bridge) echo "CURSOR_BRIDGE_TOKEN=$TOKEN CURSOR_BRIDGE_STATE_DIR=/tmp/cursor-state" ;;
        pi-bridge) echo "PI_BRIDGE_TOKEN=$TOKEN PI_AGENT_DIR=/tmp/pi-agent PI_SESSION_DIR=/tmp/pi-agent/sessions PI_BRIDGE_STATE_DIR=/tmp/pi-state" ;;
        acp-bridge) echo "ACP_BRIDGE_TOKEN=$TOKEN ACP_PROVIDER=grok ACP_STATE_DIR=/tmp/acp-state ACP_AGENT_PATH=\$(command -v grok)" ;;
    esac
}
bridge_port() {
    case "$1" in
        claude-bridge) echo 4097 ;;
        codex-bridge) echo 4098 ;;
        cursor-bridge) echo 4099 ;;
        acp-bridge) echo 4100 ;;
        pi-bridge) echo 4101 ;;
    esac
}
bridges="$(field '.bridges[]')"
[ -n "$bridges" ] || fail "the manifest lists no bridges"
for bridge in $bridges; do
    port="$(bridge_port "$bridge")"
    [ -n "$port" ] || fail "unknown bridge $bridge"
    in_container "test -f /opt/$bridge/dist/index.js" || fail "$bridge has no built entry point"
    arguments=""
    [ "$bridge" = acp-bridge ] && arguments="--provider=grok"
    docker exec -d -u node "$RUN" bash -c "cd /workspace; export PORT=$port HOSTNAME=127.0.0.1 CWD=/workspace $(bridge_environment "$bridge"); exec bun /opt/$bridge/dist/index.js $arguments > /tmp/$bridge.log 2>&1"
done
for bridge in $bridges; do
    port="$(bridge_port "$bridge")"
    healthy=0
    for _ in $(seq 1 60); do
        if in_container "curl -fsS -m 2 -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:$port/global/health >/dev/null 2>&1"; then
            healthy=1
            break
        fi
        sleep 1
    done
    if [ "$healthy" != 1 ]; then
        in_container "tail -n 30 /tmp/$bridge.log" >&2 || true
        fail "$bridge did not answer /global/health on $port"
    fi
    echo "ok   $bridge /global/health"
done

# Chromium, as the image's own verifier runs it.
in_container 'NODE_PATH=/usr/local/share/npm-global/lib/node_modules node /usr/local/share/verify-playwright.cjs' >/dev/null \
    || fail "Chromium did not launch for node"
echo "ok   chromium (node)"

echo "final image smoke: passed"
