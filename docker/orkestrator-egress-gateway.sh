#!/bin/bash
# Egress gateway for one restricted environment runtime.
#
# Egress gateway contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY egress-gateway=1
#
# The backend runs this as the entrypoint of a small companion container
# (`<runtime>-egress`, root, NET_ADMIN, /run on tmpfs) that owns the
# environment's network namespace; the workload joins it with `--network
# container:<gateway>` and no added capability, so nothing in the workload,
# root included, can change the rules. The gateway records the policy exactly
# as the workload's root entrypoint does, applies the unchanged
# init-firewall.sh (which also starts the refresher), then idles. Live edits
# and the status report (`/run/orkestrator-firewall/firewall.json`) belong to
# the gateway. /run is a fresh tmpfs on every start, so a report there always
# describes this boot: the backend starts the workload only once it says
# `applied`, and the workload's entrypoint verifies enforcement again.
#
# A failed firewall leaves the namespace closed (init-firewall.sh fails
# closed) and the gateway running, so the report and log stay readable.
set -euo pipefail

/usr/local/bin/network-policy-entrypoint.sh --record-only
if ! /usr/local/bin/init-firewall.sh; then
    # init-firewall.sh closes the namespace and reports `failed` itself; a
    # script that is missing or died before its trap did neither.
    iptables -P INPUT DROP 2>/dev/null || true
    iptables -P FORWARD DROP 2>/dev/null || true
    iptables -P OUTPUT DROP 2>/dev/null || true
    if [ ! -s /run/orkestrator-firewall/firewall.json ]; then
        install -d -m 0755 /run/orkestrator-firewall
        printf '{"mode":"restricted","state":"failed","appliedAt":"%s"}\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /run/orkestrator-firewall/firewall.json
    fi
    echo "Egress gateway: firewall initialization failed; the namespace stays closed" >&2
fi

trap 'exit 0' TERM INT
sleep infinity &
wait $!
