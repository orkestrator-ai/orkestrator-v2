#!/bin/bash
set -euo pipefail

# Docker launches this sudo command as its entrypoint before any node code
# runs. The sudo permission remains available after startup, so a later call
# must never rewrite policy from a node-controlled environment.
if [ ! -e /etc/orkestrator/network-mode ] && [ ! -e /etc/orkestrator/allowed-domains ]; then
    case "${NETWORK_MODE:-restricted}" in
        full|restricted) network_mode="${NETWORK_MODE:-restricted}" ;;
        *) echo "Invalid network mode" >&2; exit 1 ;;
    esac
    install -d -o root -g root -m 0755 /etc/orkestrator
    umask 022
    printf '%s\n' "$network_mode" > /etc/orkestrator/network-mode
    printf '%s\n' "${ALLOWED_DOMAINS:-}" > /etc/orkestrator/allowed-domains
    chown root:root /etc/orkestrator/network-mode /etc/orkestrator/allowed-domains
    chmod 0644 /etc/orkestrator/network-mode /etc/orkestrator/allowed-domains
fi

# A partial write or a changed owner/mode fails closed on container restart.
for file in /etc/orkestrator/network-mode /etc/orkestrator/allowed-domains; do
    if [ ! -f "$file" ] || [ -L "$file" ] || [ "$(stat -c '%u:%a' "$file")" != "0:644" ]; then
        echo "Invalid root-owned network policy" >&2
        exit 1
    fi
done

export HOME=/home/node USER=node LOGNAME=node
exec setpriv --reuid=node --regid=node --init-groups /usr/local/bin/entrypoint.sh "$@"
