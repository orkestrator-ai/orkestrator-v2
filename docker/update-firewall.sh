#!/bin/bash
# Runtime firewall updates for Orkestrator containers.
#
# Usage:
#   update-firewall.sh --set-domains domain1,domain2,...
#   update-firewall.sh --add domain1,domain2,...
#   update-firewall.sh --remove domain1,domain2,...
#   update-firewall.sh --refresh
#   update-firewall.sh --list
#   update-firewall.sh --host-ports 41234,41235   (network policy 2 only)
#
# Must be run as root via `docker exec --user root`. The node sudoers file
# does not grant this script; runtime allowlist edits are an operator action,
# and the backend uses --set-domains to apply the list saved in the app.
#
# Domain edits are durable: the stored list the firewall boots from is
# replaced as well, so a restart applies the same list. The allowlist is
# rebuilt beside the live set and swapped in, and addresses that leave it are
# revoked (firewall-domains.sh). --add and --remove edit the stored list; the
# app shows a list that differs from its saved one and replaces it the next
# time it applies its own.

set -euo pipefail
IFS=$'\n\t'

# shellcheck source=firewall-domains.sh
source /usr/local/lib/orkestrator/firewall-domains.sh

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# A stored list stays below this size; each entry is also bounded by the
# domain rules when it is resolved.
MAX_DOMAINS_BYTES=65536

usage() {
    echo "Usage: $0 [--set-domains|--add|--remove|--refresh|--list|--host-ports] [value]"
    exit 1
}

fail() {
    echo -e "${RED}ERROR: $1${NC}" >&2
    exit "${2:-1}"
}

stored_domains() {
    local value=""
    IFS= read -r value < "$ORK_POLICY_DIR/allowed-domains" || true
    printf '%s' "$value"
}

# Takes the mutation lock (shared with init-firewall.sh and the refresher).
take_lock() {
    mkdir -p "$ORK_STATUS_DIR"
    chmod 0755 "$ORK_STATUS_DIR"
    exec 8>"$ORK_LOCK_FILE"
    flock -w "${1:-60}" 8 || fail "another firewall update is running" 75
}

firewall_restricted() {
    [ "$(cat "$ORK_POLICY_DIR/network-mode" 2>/dev/null)" = "restricted" ]
}

store_domains() {
    local tmp="$ORK_POLICY_DIR/.allowed-domains.tmp"
    printf '%s\n' "$1" > "$tmp"
    chown root:root "$tmp" 2>/dev/null || true
    chmod 0644 "$tmp"
    mv -f "$tmp" "$ORK_POLICY_DIR/allowed-domains"
}

refresh_status() {
    local csv="$1" failures="$2" now delay
    now=$(ork_now)
    delay=$(ork_next_delay "$failures")
    printf '%s\n' "$delay" > "$ORK_DELAY_FILE"
    printf '%s\n' "$failures" > "$ORK_FAILURES_FILE"
    local expiry=null
    [ "$ORK_EARLIEST_EXPIRY" -gt 0 ] && expiry="\"$(ork_iso "$ORK_EARLIEST_EXPIRY")\""
    ork_merge_status "\"state\":\"applied\",\"refreshedAt\":\"$(ork_iso "$now")\",\"nextRefreshAt\":\"$(ork_iso $((now + delay)))\",\"domainsRevision\":\"$(ork_domains_revision "$csv")\",\"resolvedDomains\":$ORK_RESOLVED_DOMAINS,\"unresolvedDomains\":$ORK_UNRESOLVED_DOMAINS,\"carriedDomains\":$ORK_CARRIED_DOMAINS,\"invalidDomains\":$ORK_INVALID_DOMAINS,\"carriedUntil\":$expiry,\"refreshFailures\":$failures,\"revokedEntries\":$ORK_REVOKED_ENTRIES,\"revocation\":\"$ORK_REVOCATION\",\"allowedEntries\":$(ork_members "$ORK_SET" | awk 'NF { n++ } END { print n + 0 }')"
}

# Replaces the stored list and the live allowlist. The live set is swapped
# first and the list stored after, so a crash in between leaves a container
# that boots with its previous list and reports that revision.
set_domains() {
    local csv="$1"
    [ "${#csv}" -le "$MAX_DOMAINS_BYTES" ] || fail "domain list is too large" 2
    case "$csv" in
        *[!A-Za-z0-9.,*_-]*) fail "domain list contains characters outside a domain name" 2 ;;
    esac
    take_lock 60
    if ! firewall_restricted; then
        store_domains "$csv"
        echo "Stored; full network access has no allowlist to apply"
        return 0
    fi
    ipset list "$ORK_SET" >/dev/null 2>&1 || fail "the firewall is not initialized"
    local effective="$csv"
    [ -n "$effective" ] || effective=$(default_domains_csv)
    ork_rebuild_allowlist "$effective" || fail "the allowlist could not be rebuilt; the previous one is still active"
    store_domains "$csv"
    refresh_status "$csv" 0
    echo -e "${GREEN}Applied $ORK_RESOLVED_DOMAINS domains ($ORK_UNRESOLVED_DOMAINS unresolved, $ORK_REVOKED_ENTRIES entries revoked)${NC}"
}

# An empty stored list means the image defaults, which live in init-firewall.sh.
default_domains_csv() {
    awk '/^    DOMAIN_ARRAY=\($/ { list = 1; next } list && /^    \)$/ { exit } list { gsub(/[" ]/, ""); if ($0 != "" && $0 !~ /^#/) print }' \
        /usr/local/bin/init-firewall.sh | paste -sd, -
}

edit_domains() {
    local operation="$1" csv="$2" current entry
    local -a next=()
    current=$(stored_domains)
    ork_split_domains "$current"
    local -a existing=("${ORK_DOMAIN_LIST[@]}")
    ork_split_domains "$csv"
    local -a changes=("${ORK_DOMAIN_LIST[@]}")
    if [ "$operation" = add ]; then
        next=("${existing[@]}")
        for entry in "${changes[@]}"; do
            printf '%s\n' "${next[@]}" | grep -Fxq -- "$entry" || next+=("$entry")
        done
    else
        for entry in "${existing[@]}"; do
            printf '%s\n' "${changes[@]}" | grep -Fxq -- "$entry" || next+=("$entry")
        done
    fi
    set_domains "$(IFS=','; printf '%s' "${next[*]}")"
}

# One refresh: re-resolve the stored list and swap. A failure keeps the live
# set (whose entries still expire) and schedules a sooner retry.
refresh_once() {
    take_lock 5
    firewall_restricted || return 0
    ipset list "$ORK_SET" >/dev/null 2>&1 || return 0
    local csv effective failures=0
    csv=$(stored_domains)
    effective="$csv"
    [ -n "$effective" ] || effective=$(default_domains_csv)
    IFS= read -r failures < "$ORK_FAILURES_FILE" 2>/dev/null || failures=0
    [[ "$failures" =~ ^[0-9]+$ ]] || failures=0
    if ork_rebuild_allowlist "$effective"; then
        # Unresolved domains count as a failed refresh for scheduling, so a
        # transient DNS outage is retried well before the carried addresses
        # expire.
        if [ "$ORK_UNRESOLVED_DOMAINS" -gt 0 ]; then failures=$((failures + 1)); else failures=0; fi
        refresh_status "$csv" "$failures"
    else
        failures=$((failures + 1))
        local delay
        delay=$(ork_next_delay "$failures")
        printf '%s\n' "$delay" > "$ORK_DELAY_FILE"
        printf '%s\n' "$failures" > "$ORK_FAILURES_FILE"
        ork_merge_status "\"refreshFailures\":$failures,\"nextRefreshAt\":\"$(ork_iso $(( $(ork_now) + delay )))\""
        return 1
    fi
}

# Runs refreshes on the recorded schedule until signalled. Single instance.
refresh_loop() {
    mkdir -p "$ORK_STATUS_DIR"
    exec 9>"$ORK_STATUS_DIR/refresher.lock"
    flock -n 9 || exit 0
    local sleeper="" delay
    trap '[ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null; exit 0' TERM INT HUP
    while :; do
        IFS= read -r delay < "$ORK_DELAY_FILE" 2>/dev/null || delay="$ORK_REFRESH_MIN"
        [[ "$delay" =~ ^[0-9]+$ ]] && [ "$delay" -ge 1 ] && [ "$delay" -le 86400 ] || delay="$ORK_REFRESH_MIN"
        sleep "$delay" 8>&- 9>&- &
        sleeper=$!
        wait "$sleeper" || true
        sleeper=""
        ( refresh_once ) >/dev/null 2>&1 || true
    done
}

# List current ipset entries
list_entries() {
    if ! ipset list allowed-domains &>/dev/null; then
        echo -e "${RED}ERROR: allowed-domains ipset does not exist. Is the firewall initialized?${NC}" >&2
        exit 1
    fi

    echo "Current allowed-domains ipset entries:"
    echo "========================================"
    ipset list allowed-domains
}

# Replace the host service ports of a policy-2 firewall. The new chain is
# built beside the old one and swapped in before the old one is removed, so
# there is no moment with neither; the policy file is updated too, so a
# restart applies the same ports.
set_host_ports() {
    local ports_csv="$1"
    case "$ports_csv" in
        *[!0-9,]*) echo -e "${RED}ERROR: host ports must be comma-separated numbers${NC}" >&2; exit 1 ;;
    esac
    if [ ! -f /etc/orkestrator/network-policy ] || [ "$(cat /etc/orkestrator/network-policy)" != "2" ]; then
        echo -e "${RED}ERROR: host service ports apply only to network policy 2${NC}" >&2
        exit 1
    fi
    take_lock 60
    if [ "$(cat /etc/orkestrator/network-mode)" = "full" ]; then
        printf '%s\n' "$ports_csv" > /etc/orkestrator/host-service-ports
        return 0
    fi
    local gateway
    gateway=$(ip route | awk '/^default/ { print $3; exit }')
    [ -n "$gateway" ] || { echo -e "${RED}ERROR: no default route${NC}" >&2; exit 1; }
    local addresses
    addresses=$( { echo "$gateway"; getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}'; } | sort -u)
    iptables -N ORK_HOST_SERVICES_NEXT 2>/dev/null || iptables -F ORK_HOST_SERVICES_NEXT
    local port address
    IFS=',' read -ra PORTS <<< "$ports_csv"
    for port in "${PORTS[@]}"; do
        [ -n "$port" ] || continue
        if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
            echo -e "${RED}ERROR: invalid port $port${NC}" >&2
            exit 1
        fi
        while read -r address; do
            [ -n "$address" ] && iptables -A ORK_HOST_SERVICES_NEXT -p tcp -d "$address" --dport "$port" -j ACCEPT
        done <<< "$addresses"
    done
    iptables -I OUTPUT 1 -j ORK_HOST_SERVICES_NEXT
    if iptables -C OUTPUT -j ORK_HOST_SERVICES 2>/dev/null; then
        iptables -D OUTPUT -j ORK_HOST_SERVICES
    fi
    iptables -F ORK_HOST_SERVICES 2>/dev/null || true
    iptables -X ORK_HOST_SERVICES 2>/dev/null || true
    iptables -E ORK_HOST_SERVICES_NEXT ORK_HOST_SERVICES
    local tmp=/etc/orkestrator/.host-service-ports.tmp
    printf '%s\n' "$ports_csv" > "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" /etc/orkestrator/host-service-ports
    echo "Host service ports: ${ports_csv:-none}"
}

# Main
if [ $# -lt 1 ]; then
    usage
fi

case "$1" in
    --set-domains)
        [ $# -ge 2 ] || usage
        set_domains "$2"
        ;;
    --add|--remove)
        [ $# -ge 2 ] || usage
        edit_domains "${1#--}" "$2"
        ;;
    --refresh)
        refresh_once
        ;;
    --refresh-loop)
        refresh_loop
        ;;
    --list)
        list_entries
        ;;
    --host-ports)
        set_host_ports "${2:-}"
        ;;
    *)
        echo -e "${RED}ERROR: Unknown option: $1${NC}" >&2
        usage
        ;;
esac
