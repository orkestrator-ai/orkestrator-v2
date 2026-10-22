#!/bin/bash
# External egress prototype (0018 item 3): a gateway container owns the
# environment's network namespace and runs the unchanged init-firewall.sh
# with NET_ADMIN; the workload joins that namespace (`--network
# container:<gateway>`) with no added capability. Nothing in the backend
# creates this topology yet; this script only proves the path on one daemon.
#
#   scripts/qualify-egress-gateway.sh [image]
#
# Uses the working tree's firewall scripts, bind-mounted over the image's.
# Needs outbound access to registry.npmjs.org, example.com, pypi.org and
# GitHub, plus python3 on the host for a host-service listener. Every
# resource carries a run-private `orkestrator-owner` label and is removed on
# exit. Exits 0 when every check matched, 1 when one did not, 2 on setup
# errors.
set -uo pipefail

IMAGE="${1:-orkestrator-v2:latest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="egp$(date +%s)"
LABEL="orkestrator-owner=egress-gateway-$RUN"
NET="$RUN-net" GW="$RUN-gw" WL="$RUN-wl"
STAGE="$(mktemp -d)"
HOST_PID=""
FAILED=0

cleanup() {
    docker rm -f "$GW" "$WL" >/dev/null 2>&1
    docker network rm "$NET" >/dev/null 2>&1
    [ -n "$HOST_PID" ] && kill "$HOST_PID" 2>/dev/null
    rm -rf "$STAGE"
}
trap cleanup EXIT

now() { python3 -c 'import time; print(time.time())'; }
check() {
    if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; else echo "FAIL $1: expected $2, got $3"; FAILED=1; fi
}
# ok when the command succeeds inside the workload as $1, blocked otherwise.
probe() { docker exec -u "$1" "$WL" sh -c "$2" >/dev/null 2>&1 && echo ok || echo blocked; }

wait_gateway() {
    for _ in $(seq 1 180); do
        docker exec "$GW" test -e /tmp/egress-ready 2>/dev/null && return 0
        if docker exec "$GW" test -e /tmp/egress-failed 2>/dev/null; then
            docker exec "$GW" cat /tmp/init.log >&2
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

# The image runs the firewall scripts from root-owned executable copies.
cp "$ROOT"/docker/{init-firewall.sh,update-firewall.sh,firewall-domains.sh,default-allowed-domains} "$STAGE/"
chmod 0755 "$STAGE"/*.sh
chmod 0644 "$STAGE/default-allowed-domains"
mounts=(
    -v "$STAGE/init-firewall.sh:/usr/local/bin/init-firewall.sh:ro"
    -v "$STAGE/update-firewall.sh:/usr/local/bin/update-firewall.sh:ro"
    -v "$STAGE/firewall-domains.sh:/usr/local/lib/orkestrator/firewall-domains.sh:ro"
    -v "$STAGE/default-allowed-domains:/usr/local/lib/orkestrator/default-allowed-domains:ro"
)

HOST_PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])')
python3 -m http.server "$HOST_PORT" --bind 0.0.0.0 >/dev/null 2>&1 &
HOST_PID=$!

docker network create --label "$LABEL" "$NET" >/dev/null || exit 2
# The gateway records policy 3 the way network-policy-entrypoint.sh does,
# applies the firewall (which also starts the refresher), then idles. Port
# publishing belongs to the namespace owner, so 8080 is published here.
gateway_command='install -d -m 0755 /etc/orkestrator; umask 022
printf "%s\n" restricted > /etc/orkestrator/network-mode
printf "%s\n" "$ALLOWED_DOMAINS" > /etc/orkestrator/allowed-domains
printf "%s\n" 3 > /etc/orkestrator/network-policy
printf "%s\n" "$HOST_SERVICE_PORTS" > /etc/orkestrator/host-service-ports
printf "%s\n" 8080 > /etc/orkestrator/ingress-ports
rm -f /tmp/egress-ready /tmp/egress-failed
if /usr/local/bin/init-firewall.sh > /tmp/init.log 2>&1; then touch /tmp/egress-ready; else touch /tmp/egress-failed; fi
exec sleep infinity'
started=$(now)
docker run -d --name "$GW" --label "$LABEL" --network "$NET" --cap-add NET_ADMIN --user root \
    -p 127.0.0.1::8080 -e ALLOWED_DOMAINS="registry.npmjs.org,example.com:80" \
    -e HOST_SERVICE_PORTS="$HOST_PORT" "${mounts[@]}" --entrypoint bash "$IMAGE" \
    -c "$gateway_command" >/dev/null || exit 2
wait_gateway || { echo "setup: the gateway firewall did not apply" >&2; exit 2; }
echo "gateway firewall applied $(python3 -c "print(round($(now) - $started, 1))") s after docker run"

docker run -d --name "$WL" --label "$LABEL" --network "container:$GW" \
    --entrypoint sleep "$IMAGE" infinity >/dev/null || exit 2
check "workload effective capabilities" "0000000000000000" \
    "$(docker exec "$WL" awk '/^CapEff/ { print $2 }' /proc/self/status)"
egress "gateway-owned rules"

check "workload root sets OUTPUT to ACCEPT" blocked "$(probe root 'iptables -P OUTPUT ACCEPT')"
check "workload root flushes the rules" blocked "$(probe root 'iptables -F')"
check "workload root flushes the allowlist" blocked "$(probe root 'ipset flush allowed-domains')"
check "node reruns init-firewall through sudo" blocked "$(probe node 'sudo -n /usr/local/bin/init-firewall.sh')"
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
    "$(probe node "curl -fsS -o /dev/null --max-time 6 http://host.docker.internal:$HOST_PORT/")"
check "workload reaches another host port" blocked \
    "$(probe node 'curl -sS -o /dev/null --max-time 4 http://host.docker.internal:1/')"

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
