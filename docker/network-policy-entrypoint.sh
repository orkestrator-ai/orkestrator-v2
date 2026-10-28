#!/bin/bash
set -euo pipefail

# Docker launches this sudo command as its entrypoint before any node code
# runs. The sudo permission remains available after startup, so a later call
# must never rewrite policy from a node-controlled environment.
#
# Network policy v2 (per-environment network) adds the policy version, the
# host service ports the workload may call back to, and the container ports
# Docker publishes. Each must be a comma-separated list of port numbers.
# Policy v3 records the same files and narrows each allowed address to
# protocol and port tuples (init-firewall.sh).
#
# Egress enforcement is recorded with them: `container` (or no record) runs
# the firewall in this namespace, which needs NET_ADMIN; `gateway` means the
# namespace belongs to the environment's egress gateway
# (orkestrator-egress-gateway), which enforces the same firewall from outside
# this workload, and this boot only verifies that it does.
#
#   network-policy-entrypoint.sh --record-only   records and validates, then exits
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
        1|2|3) network_policy="${ORKESTRATOR_NETWORK_POLICY:-1}" ;;
        *) echo "Invalid network policy version" >&2; exit 1 ;;
    esac
    case "${ORKESTRATOR_EGRESS:-container}" in
        container|gateway) egress="${ORKESTRATOR_EGRESS:-container}" ;;
        *) echo "Invalid egress enforcement" >&2; exit 1 ;;
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
    printf '%s\n' "$egress" > /etc/orkestrator/egress
    chown root:root /etc/orkestrator/network-mode /etc/orkestrator/allowed-domains \
        /etc/orkestrator/network-policy /etc/orkestrator/host-service-ports \
        /etc/orkestrator/ingress-ports /etc/orkestrator/egress
    chmod 0644 /etc/orkestrator/network-mode /etc/orkestrator/allowed-domains \
        /etc/orkestrator/network-policy /etc/orkestrator/host-service-ports \
        /etc/orkestrator/ingress-ports /etc/orkestrator/egress
fi

# A container whose policy was captured before v2 has only the first two
# files; it keeps the legacy policy. One captured before egress enforcement
# was recorded runs its own firewall.
if [ ! -e /etc/orkestrator/network-policy ]; then
    policy_files="/etc/orkestrator/network-mode /etc/orkestrator/allowed-domains"
else
    policy_files="/etc/orkestrator/network-mode /etc/orkestrator/allowed-domains /etc/orkestrator/network-policy /etc/orkestrator/host-service-ports /etc/orkestrator/ingress-ports"
fi
if [ -e /etc/orkestrator/egress ]; then
    policy_files="$policy_files /etc/orkestrator/egress"
fi

# A partial write or a changed owner/mode fails closed on container restart.
for file in $policy_files; do
    if [ ! -f "$file" ] || [ -L "$file" ] || [ "$(stat -c '%u:%a' "$file")" != "0:644" ]; then
        echo "Invalid root-owned network policy" >&2
        exit 1
    fi
done

if [ "${1:-}" = "--record-only" ]; then
    exit 0
fi

# This boot's readiness record opens here, before the firewall step, so the
# backend sees the current boot `initializing` while the firewall runs. The
# node entrypoint keeps this boot id (ORKESTRATOR_BOOT_ID) and owns the record
# from then on, so nothing is opened in a directory node could not write.
FIREWALL_RESULT_DIR=/run/orkestrator-network
install -d -o root -g root -m 0755 "$FIREWALL_RESULT_DIR"
BOOT_STATUS_DIR=/run/orkestrator
if [ -d "$BOOT_STATUS_DIR" ] && setpriv --reuid=node --regid=node --init-groups test -w "$BOOT_STATUS_DIR"; then
    rm -f /tmp/.environment-ready /tmp/.entrypoint-complete "$BOOT_STATUS_DIR/boot-status.json"
    ORKESTRATOR_BOOT_ID="$(cat /proc/sys/kernel/random/uuid)"
    # Exclusively create in root's directory. Never open or chmod a path
    # planted by node, including a symlink or a directory at the destination.
    boot_record=$(mktemp "$FIREWALL_RESULT_DIR/boot-status.XXXXXXXXXX")
    printf '{"version":1,"bootId":"%s","pid1Start":"%s","phase":"initializing","failureCode":null,"updatedAt":"%s"}\n' \
        "$ORKESTRATOR_BOOT_ID" "$(awk '{print $22}' /proc/1/stat)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        > "$boot_record" && chmod 0644 "$boot_record" && mv -fT -- "$boot_record" "$BOOT_STATUS_DIR/boot-status.json"
    export ORKESTRATOR_BOOT_ID
fi

# The firewall step runs here, as root, before privileges drop: node needs no
# sudo grant for it. Its outcome goes to a root-owned file that entrypoint.sh
# reads to report the boot, so a failure keeps its reason code.
#   applied, failed, missing                 this namespace's own firewall
#   full, full-failed                        full mode (the firewall only reports)
#   gateway, gateway-unverified, gateway-unavailable
#                                            the egress gateway's firewall
rm -f "$FIREWALL_RESULT_DIR/firewall-boot"
network_mode=""
egress=container
IFS= read -r network_mode < /etc/orkestrator/network-mode || true
if [ -f /etc/orkestrator/egress ]; then IFS= read -r egress < /etc/orkestrator/egress || true; fi

# A gateway rejects every destination it does not allow with
# icmp-admin-prohibited, which a connect reports as "No route to host" at
# once. A namespace without that rule lets the attempt leave (it times out on
# this reserved TEST-NET-1 address), and one whose gateway has gone has no
# route at all. Only the first proves that enforcement is in place.
egress_probe() {
    local output
    if output=$(timeout 5 bash -c 'exec 3<>/dev/tcp/192.0.2.1/443' 2>&1); then
        echo gateway-unverified
        return
    fi
    case "$output" in
        *"No route to host"*) echo gateway ;;
        *"Network is unreachable"*) echo gateway-unavailable ;;
        *) echo gateway-unverified ;;
    esac
}

if [ "$network_mode" = restricted ] && [ "$egress" = gateway ]; then
    firewall_boot=$(egress_probe)
elif [ ! -x /usr/local/bin/init-firewall.sh ]; then
    if [ "$network_mode" = full ]; then firewall_boot=full-failed; else firewall_boot=missing; fi
elif /usr/local/bin/init-firewall.sh; then
    if [ "$network_mode" = full ]; then firewall_boot=full; else firewall_boot=applied; fi
else
    if [ "$network_mode" = full ]; then firewall_boot=full-failed; else firewall_boot=failed; fi
fi
umask 022
printf '%s\n' "$firewall_boot" > "$FIREWALL_RESULT_DIR/firewall-boot"

# Staged inputs (staged-inputs=3, see entrypoint.sh). The backend binds its
# staged revision read-only, owner-only (0700/0600) and owned by its own user,
# so node (uid 1000) can open them only on a rootful daemon whose host user is
# uid 1000. Under rootless Docker the backend's user is container root and
# node a subordinate UID; on a rootful daemon with any other host user
# (GitHub's runners, a second user on a shared host) the mounts belong to that
# uid. Each mount node cannot read in full is copied, root reading and node
# writing, into a node-owned 0700 directory the entrypoint reads instead.
# Nothing is widened on the host or for any other user. The relay is rebuilt
# from the mounts on every boot, so emptying the revision (revocation) empties
# it at the next start.
STAGED_INPUT_RELAY_DIR=/run/orkestrator-inputs
# The mount points below `/`, as the backend binds them
# (apps/backend/src/core/portable-inputs.ts and the project seed files).
STAGED_INPUT_MOUNTS="claude-config claude-config.json codex-home opencode-config opencode-data opencode-state/model.json grok-home grok-config pi-config cursor-config tmp/gitconfig project-env opencode-project-json"
# The backend's own staging bounds (INPUT_LIMITS totals).
STAGED_INPUT_RELAY_MAX_ENTRIES=20000
STAGED_INPUT_RELAY_MAX_BYTES=536870912

as_input_user() {
    setpriv --reuid=node --regid=node --init-groups "$@"
}

relay_staged_inputs() {
    local source_root="$1" relay_dir="$2" owner="$3"
    local name source parent unreadable entries bytes
    # Root's own directory under root-owned /run: node cannot plant it, and
    # rm never follows a link node left inside it.
    rm -rf --one-file-system -- "$relay_dir"
    for name in $STAGED_INPUT_MOUNTS; do
        source="$source_root/$name"
        # A mount point is a real file or directory; a link is never followed.
        { [ -e "$source" ] && [ ! -L "$source" ]; } || continue
        unreadable=$(as_input_user find -P "$source" ! -readable -print -quit 2>/dev/null) || unreadable=yes
        [ -n "$unreadable" ] || continue
        entries=$(find -P "$source" 2>/dev/null | head -n "$((STAGED_INPUT_RELAY_MAX_ENTRIES + 1))" | wc -l) || true
        bytes=$(du -s -B1 --apparent-size "$source" 2>/dev/null | cut -f1) || true
        if [ "${entries:-0}" -gt "$STAGED_INPUT_RELAY_MAX_ENTRIES" ] || [ "${bytes:-0}" -gt "$STAGED_INPUT_RELAY_MAX_BYTES" ]; then
            echo "Staged input /$name is over the relay bounds and stays unreadable" >&2
            continue
        fi
        [ -d "$relay_dir" ] || install -d -o "$owner" -g "$owner" -m 0700 "$relay_dir"
        parent="$relay_dir/$(dirname "$name")"
        as_input_user mkdir -p -m 0700 "$parent" || continue
        # tar -c archives links as links and -x as node writes only where node
        # can; modes keep the staged 0700/0600 under umask 077.
        if ! tar -C "$(dirname "$source")" -cf - "$(basename "$source")" 2>/dev/null |
            as_input_user sh -c 'umask 077; exec tar -C "$1" -xf - --no-same-owner --no-same-permissions' sh "$parent"; then
            echo "Staged input /$name could not be relayed" >&2
            as_input_user rm -rf -- "$relay_dir/$name" || true
        fi
    done
}

relay_staged_inputs "" "$STAGED_INPUT_RELAY_DIR" node || echo "Staged inputs were not relayed" >&2

export HOME=/home/node USER=node LOGNAME=node
exec setpriv --reuid=node --regid=node --init-groups /usr/local/bin/entrypoint.sh "$@"
