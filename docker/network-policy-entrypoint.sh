#!/bin/bash
set -euo pipefail

# Docker launches this sudo command as its entrypoint before any node code
# runs. The sudo permission remains available after startup, so a later call
# must never rewrite policy from a node-controlled environment.
#
# Network policy v2 (per-environment network) adds the policy version, the
# host service ports the workload may call back to, and the container ports
# Docker publishes. Each must be a comma-separated list of port numbers.
policy_ports() {
    case "$1" in
        '') return 0 ;;
        *[!0-9,]*) echo "Invalid network policy port list" >&2; exit 1 ;;
    esac
}
if [ ! -e /etc/orkestrator/network-mode ] && [ ! -e /etc/orkestrator/allowed-domains ]; then
    case "${NETWORK_MODE:-restricted}" in
        full|restricted) network_mode="${NETWORK_MODE:-restricted}" ;;
        *) echo "Invalid network mode" >&2; exit 1 ;;
    esac
    case "${ORKESTRATOR_NETWORK_POLICY:-1}" in
        1|2) network_policy="${ORKESTRATOR_NETWORK_POLICY:-1}" ;;
        *) echo "Invalid network policy version" >&2; exit 1 ;;
    esac
    policy_ports "${ORKESTRATOR_HOST_SERVICE_PORTS:-}"
    policy_ports "${ORKESTRATOR_INGRESS_PORTS:-}"
    install -d -o root -g root -m 0755 /etc/orkestrator
    umask 022
    printf '%s\n' "$network_mode" > /etc/orkestrator/network-mode
    printf '%s\n' "${ALLOWED_DOMAINS:-}" > /etc/orkestrator/allowed-domains
    printf '%s\n' "$network_policy" > /etc/orkestrator/network-policy
    printf '%s\n' "${ORKESTRATOR_HOST_SERVICE_PORTS:-}" > /etc/orkestrator/host-service-ports
    printf '%s\n' "${ORKESTRATOR_INGRESS_PORTS:-}" > /etc/orkestrator/ingress-ports
    chown root:root /etc/orkestrator/network-mode /etc/orkestrator/allowed-domains \
        /etc/orkestrator/network-policy /etc/orkestrator/host-service-ports \
        /etc/orkestrator/ingress-ports
    chmod 0644 /etc/orkestrator/network-mode /etc/orkestrator/allowed-domains \
        /etc/orkestrator/network-policy /etc/orkestrator/host-service-ports \
        /etc/orkestrator/ingress-ports
fi

# A container whose policy was captured before v2 has only the first two
# files; it keeps the legacy policy.
if [ ! -e /etc/orkestrator/network-policy ]; then
    policy_files="/etc/orkestrator/network-mode /etc/orkestrator/allowed-domains"
else
    policy_files="/etc/orkestrator/network-mode /etc/orkestrator/allowed-domains /etc/orkestrator/network-policy /etc/orkestrator/host-service-ports /etc/orkestrator/ingress-ports"
fi

# A partial write or a changed owner/mode fails closed on container restart.
for file in $policy_files; do
    if [ ! -f "$file" ] || [ -L "$file" ] || [ "$(stat -c '%u:%a' "$file")" != "0:644" ]; then
        echo "Invalid root-owned network policy" >&2
        exit 1
    fi
done

export HOME=/home/node USER=node LOGNAME=node
exec setpriv --reuid=node --regid=node --init-groups /usr/local/bin/entrypoint.sh "$@"
