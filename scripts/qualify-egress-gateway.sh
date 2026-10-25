#!/bin/bash
# External egress prototype (0018 item 1): a gateway container owns the
# environment's network namespace and runs the unchanged init-firewall.sh
# with NET_ADMIN; the workload joins that namespace (`--network
# container:<gateway>`) with no added capability. The backend now creates this
# topology itself (apps/backend/src/core/egress-gateway.ts, with the image's
# orkestrator-egress-gateway entrypoint), and the live firewall, network,
# readiness and replacement suites qualify that path. This script keeps the
# 2026-10-22 prototype's own policy recording and checks.
#
#   scripts/qualify-egress-gateway.sh [image]
#
# Tests the image's baked firewall scripts; build the supplied development
# image from this checkout first. No working-tree files are mounted.
# Needs outbound access to registry.npmjs.org, example.com, pypi.org and
# GitHub, plus python3 on the host for a host-service listener. Every
# resource carries a run-private `orkestrator-owner` label and is removed on
# exit. Exits 0 when every check matched, 1 when one did not, 2 on setup
# errors.
set -euo pipefail

IMAGE="${1:-orkestrator-v2:latest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="egp$(python3 -c 'import secrets; print(secrets.token_hex(12))')"
LABEL="orkestrator-owner=egress-gateway-$RUN"
NET="$RUN-net" GW="$RUN-gw" WL="$RUN-wl"
STAGE="$(mktemp -d)"
HOST_PID=""
FAILED=0
CREATED_CONTAINERS=()
CREATED_NETWORK=""

cleanup() {
    for container in ${CREATED_CONTAINERS[@]+"${CREATED_CONTAINERS[@]}"}; do
        docker rm -f "$container" >/dev/null 2>&1 || true
    done
    if [ -n "$CREATED_NETWORK" ]; then docker network rm "$CREATED_NETWORK" >/dev/null 2>&1 || true; fi
    if [ -n "$HOST_PID" ]; then kill "$HOST_PID" 2>/dev/null || true; wait "$HOST_PID" 2>/dev/null || true; fi
    rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'exit 2' INT TERM

# Record creation before starting: even a failed start leaves an owned object.
create_container() {
    local name="$1"; shift
    docker create --name "$name" --label "$LABEL" "$@" >/dev/null || exit 2
    CREATED_CONTAINERS+=("$name")
    docker start "$name" >/dev/null || exit 2
}

rules_digest() { docker exec "$GW" bash -o pipefail -c "iptables-save | sed '/^#/d' | sha256sum"; }

now() { python3 -c 'import time; print(time.time())'; }
check() {
    if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; else echo "FAIL $1: expected $2, got $3"; FAILED=1; fi
}
# ok when the command succeeds inside the workload as $1, blocked otherwise.
probe() { docker exec -u "$1" "$WL" sh -c "$2" >/dev/null 2>&1 && echo ok || echo blocked; }

wait_gateway() {
    local gateway="${1:-$GW}"
    for _ in $(seq 1 180); do
        docker exec "$gateway" test -e /tmp/egress-ready 2>/dev/null && return 0
        if docker exec "$gateway" test -e /tmp/egress-failed 2>/dev/null; then
            docker exec "$gateway" cat /tmp/init.log >&2
            return 1
        fi
        sleep 0.5
    done
    return 1
}

egress() {
    check "$1: HTTPS to an allowed domain" ok "$(probe node 'curl -fsS -o /dev/null --max-time 8 https://registry.npmjs.org/')"
    check "$1: the one extra port an entry names" ok "$(probe node 'curl -sS -o /dev/null --max-time 8 http://example.com/')"
    check "$1: another port on that address" blocked "$(probe node 'curl -sS -o /dev/null --max-time 6 https://example.com/')"
    check "$1: a domain off the list" blocked "$(probe node 'curl -sS -o /dev/null --max-time 6 https://pypi.org/')"
    check "$1: Git over SSH to GitHub" ok "$(probe node 'timeout 8 bash -c "exec 3<>/dev/tcp/github.com/22"')"
}

docker network create --label "$LABEL" "$NET" >/dev/null || exit 2
CREATED_NETWORK="$NET"

# Docker Desktop forwards host.docker.internal to loopback. Native Linux
# Engine reaches the host's default bridge address. An explicit bind address
# supports other daemon configurations without exposing a file server.
HOST_BIND="${ORKESTRATOR_PROBE_BIND:-}"
if [ -z "$HOST_BIND" ]; then
    case "$(docker info --format '{{.OperatingSystem}}')" in
        *Docker\ Desktop*) HOST_BIND=127.0.0.1 ;;
        *) HOST_BIND=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}') ;;
    esac
fi
python3 "$ROOT/scripts/egress-probe-server.py" --bind "$HOST_BIND" --ports-file "$STAGE/ports" &
HOST_PID=$!
for _ in $(seq 1 100); do
    [ -s "$STAGE/ports" ] && break
    kill -0 "$HOST_PID" 2>/dev/null || { echo "setup: host listener failed" >&2; exit 2; }
    sleep 0.05
done
[ -s "$STAGE/ports" ] || exit 2
read -r HOST_PORT DENIED_HOST_PORT < "$STAGE/ports"

# The gateway records policy 3 the way network-policy-entrypoint.sh does,
# applies the firewall (which also starts the refresher), then idles. Port
# publishing belongs to the namespace owner, so 8080 is published here.
policy_command='install -d -m 0755 /etc/orkestrator; umask 022
printf "%s\n" restricted > /etc/orkestrator/network-mode
printf "%s\n" "${ALLOWED_DOMAINS:-}" > /etc/orkestrator/allowed-domains
printf "%s\n" 3 > /etc/orkestrator/network-policy
printf "%s\n" "${HOST_SERVICE_PORTS:-}" > /etc/orkestrator/host-service-ports
printf "%s\n" 8080 > /etc/orkestrator/ingress-ports'
gateway_command="set -e; $policy_command"'
rm -f /tmp/egress-ready /tmp/egress-failed
if /usr/local/bin/init-firewall.sh > /tmp/init.log 2>&1; then touch /tmp/egress-ready; else touch /tmp/egress-failed; fi
exec sleep infinity'
# Boot both unset and explicitly empty Docker environment values using the
# packaged fallback. Verify the image contents rather than hiding stale COPYs
# with bind mounts. These namespaces are separate from the tamper target.
for defaults in absent empty; do
    boot="$RUN-default-$defaults"
    default_env=()
    if [ "$defaults" = empty ]; then default_env=(-e ALLOWED_DOMAINS=); fi
    create_container "$boot" --network "$NET" --add-host host.docker.internal:host-gateway \
        --cap-add NET_ADMIN --user root ${default_env[@]+"${default_env[@]}"} --entrypoint bash "$IMAGE" -c "$gateway_command"
    wait_gateway "$boot" || { echo "setup: $defaults default boot failed" >&2; exit 2; }
    for file in init-firewall.sh update-firewall.sh firewall-domains.sh default-allowed-domains; do
        case "$file" in
            init-firewall.sh|update-firewall.sh) target="/usr/local/bin/$file" ;;
            *) target="/usr/local/lib/orkestrator/$file" ;;
        esac
        docker exec "$boot" cat "$target" > "$STAGE/baked-$file"
        cmp "$ROOT/docker/$file" "$STAGE/baked-$file" || { echo "setup: rebuild image: stale $file" >&2; exit 2; }
    done
    check "$defaults ALLOWED_DOMAINS boots with packaged defaults" ok \
        "$(docker exec "$boot" bash -c 'jq -e ".state == \"applied\"" /run/orkestrator-firewall/firewall.json >/dev/null && curl -fsS -o /dev/null --max-time 8 https://registry.npmjs.org/' && echo ok || echo blocked)"
    # Positive control: with NET_ADMIN and valid policy, the identical root
    # init command must succeed. It runs in its own namespace.
    check "$defaults privileged root init control" ok \
        "$(docker exec -u root "$boot" /usr/local/bin/init-firewall.sh >/dev/null 2>&1 && echo ok || echo blocked)"
    docker stop "$boot" >/dev/null
done

started=$(now)
create_container "$GW" --network "$NET" --add-host host.docker.internal:host-gateway --cap-add NET_ADMIN --user root \
    -p 127.0.0.1::8080 -e ALLOWED_DOMAINS="registry.npmjs.org,example.com:80" \
    -e HOST_SERVICE_PORTS="$HOST_PORT" --entrypoint bash "$IMAGE" \
    -c "$gateway_command"
wait_gateway || { echo "setup: the gateway firewall did not apply" >&2; exit 2; }
echo "gateway firewall applied $(python3 -c "print(round($(now) - $started, 1))") s after docker start"

create_container "$WL" --network "container:$GW" \
    --entrypoint sleep "$IMAGE" infinity
# sleep bypasses entrypoint policy capture. Install the same root-owned policy
# so sudo reaches the firewall operations, rather than failing on missing files.
docker exec -u root -e ALLOWED_DOMAINS=registry.npmjs.org,example.com:80 \
    -e HOST_SERVICE_PORTS="$HOST_PORT" "$WL" bash -ec "$policy_command"
# container: mode cannot accept --add-host. Use the gateway's resolved address
# explicitly for workload curls (the gateway's hosts file is not shared).
HOST_ADDRESS=$(docker exec "$GW" getent ahostsv4 host.docker.internal | awk 'NR == 1 { print $1 }')
[ -n "$HOST_ADDRESS" ] || { echo "setup: host alias did not resolve" >&2; exit 2; }
# Admit both live ports for the control, then close the second one again.
docker exec "$GW" /usr/local/bin/update-firewall.sh --host-ports "$HOST_PORT,$DENIED_HOST_PORT" >/dev/null
for port in "$HOST_PORT" "$DENIED_HOST_PORT"; do
    docker exec "$GW" curl -fsS -o /dev/null --max-time 6 "http://$HOST_ADDRESS:$port/probe" || {
        echo "setup: host listener $port is unreachable even when admitted" >&2; exit 2;
    }
done
docker exec "$GW" /usr/local/bin/update-firewall.sh --host-ports "$HOST_PORT" >/dev/null
check "workload effective capabilities" "0000000000000000" \
    "$(docker exec "$WL" awk '/^CapEff/ { print $2 }' /proc/self/status)"
egress "gateway-owned rules"

check "workload root sets OUTPUT to ACCEPT" blocked "$(probe root 'iptables -P OUTPUT ACCEPT')"
check "workload root flushes the rules" blocked "$(probe root 'iptables -F')"
check "workload root flushes the allowlist" blocked "$(probe root 'ipset flush allowed-domains')"
rules_before=$(rules_digest)
# node has no sudo grant for the firewall: the root entrypoint runs it.
check "node has no sudo grant for init" blocked "$(probe node 'sudo -n /usr/local/bin/init-firewall.sh')"
# Root in the workload reaches iptables and is denied. Require an iptables
# permission diagnostic as well as nonzero exit: missing policy or other setup
# errors must not count as tamper resistance.
check "workload root init reaches iptables and is denied" ok "$(probe root '
    /usr/local/bin/init-firewall.sh > /tmp/tamper.log 2>&1
    code=$?
    [ "$code" -ne 0 ] && grep -Eiq "iptables.*(Permission denied|Operation not permitted|must be root)|Permission denied.*(root|iptables)" /tmp/tamper.log
')"
check "gateway rules unchanged after workload init" "$rules_before" "$(rules_digest)"
check "a domain off the list after those attempts" blocked "$(probe node 'curl -sS -o /dev/null --max-time 6 https://pypi.org/')"

docker exec -u root "$GW" /usr/local/bin/update-firewall.sh --add pypi.org >/dev/null 2>&1
check "an edit through the gateway opens a domain" ok "$(probe node 'curl -fsS -o /dev/null --max-time 8 https://pypi.org/')"
docker exec -u root "$GW" /usr/local/bin/update-firewall.sh --remove pypi.org >/dev/null 2>&1
check "removing it closes it again" blocked "$(probe node 'curl -sS -o /dev/null --max-time 6 https://pypi.org/')"

docker exec -d -u node "$WL" node -e 'require("http").createServer((q, r) => r.end("ok")).listen(8080)'
sleep 2
published=$(docker port "$GW" 8080/tcp | head -n 1 | sed 's/.*://')
check "host reaches the workload's published port" ok \
    "$(curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$published/" && echo ok || echo blocked)"
check "workload reaches the named host service port" ok \
    "$(probe node "curl -fsS -o /dev/null --max-time 6 http://$HOST_ADDRESS:$HOST_PORT/probe")"
check "workload reaches another host port" blocked \
    "$(probe node "curl -fsS -o /dev/null --max-time 4 http://$HOST_ADDRESS:$DENIED_HOST_PORT/probe")"

docker restart "$WL" >/dev/null
egress "after a workload restart"

# A restarted gateway gets a new namespace; the running workload keeps the
# old one, which has lost its interface: it fails closed until it restarts.
docker exec "$GW" rm -f /tmp/egress-ready
docker restart "$GW" >/dev/null
check "workload after a gateway restart: allowed domain" blocked \
    "$(probe node 'curl -fsS -o /dev/null --max-time 6 https://registry.npmjs.org/')"
check "workload after a gateway restart: interfaces" "lo" \
    "$(docker exec "$WL" sh -c 'ls /sys/class/net' | grep -Ev '^(bonding_masters|erspan0|gre0|gretap0|ip6gre0|ip6tnl0|ip6_vti0|ip_vti0|sit0|tunl0)$' | paste -sd, -)"
wait_gateway || { echo "FAIL the gateway did not re-apply its firewall"; FAILED=1; }
docker restart "$WL" >/dev/null
egress "after the gateway then the workload restart"

docker stats --no-stream --format 'overhead {{.Name}}: memory {{.MemUsage}}, pids {{.PIDs}}' "$GW" "$WL"
exit "$FAILED"
