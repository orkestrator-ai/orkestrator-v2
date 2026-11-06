#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars, and pipeline failures
# Root runs this, and the image PATH puts node-writable directories first.
# Resolve every command from root-owned directories only (security H2).
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
set -E            # Failures inside functions reach the fail-closed trap too
IFS=$'\n\t'       # Stricter word splitting

# Network policy contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY network-policy=3
#
# Policy 2 runs on the environment's own Docker network. Host access is not
# the gateway's /24 but exactly the host service ports the backend named, on
# the gateway and host.docker.internal addresses; inbound connections are
# accepted only on the container ports Docker publishes; IPv6 is disabled for
# the container and dropped here as well. Policy 1 (no policy file) keeps the
# earlier behaviour for containers created before it.
#
# Policy 3 is policy 2 with address, protocol and port tuples in place of
# addresses (firewall-domains.sh): an allowed domain answers on TCP 443 or on
# the port its entry names, and GitHub's ranges on TCP 443 and 22. Policies 1
# and 2 still open every port of an allowed address.
#
# This limits destinations. It does not stop data leaving through an allowed
# service, and a workload running as root in full mode can change it.
#
# An egress gateway on policy 3 also checks names (orkestrator-egress-filter,
# firewall-domains.sh): new TCP connections to an allowed address are
# redirected to a local daemon that checks the TLS SNI or HTTP Host against
# the allowlist before relaying them, and every DNS query is redirected to the
# same daemon, which answers only allowlisted names. The daemon's own sockets
# are marked, and only marked TCP and DNS leave the namespace. With the daemon
# gone, redirected traffic has nowhere to go: the namespace stays closed.
#
# Allowed domains are resolved into a set whose addresses expire (see
# firewall-domains.sh); a root refresher re-resolves them on their TTL, and
# `update-firewall.sh --set-domains` replaces the list in place, durably.

# shellcheck source=firewall-domains.sh
source /usr/local/lib/orkestrator/firewall-domains.sh

# The root entrypoint captures Docker's initial policy before dropping to node.
# A caller's environment and PID 1 memory are both controlled by node.
IFS= read -r NETWORK_MODE < /etc/orkestrator/network-mode
IFS= read -r ALLOWED_DOMAINS < /etc/orkestrator/allowed-domains
NETWORK_POLICY=1
HOST_SERVICE_PORTS=""
INGRESS_PORTS=""
if [ -f /etc/orkestrator/network-policy ]; then
    IFS= read -r NETWORK_POLICY < /etc/orkestrator/network-policy
    IFS= read -r HOST_SERVICE_PORTS < /etc/orkestrator/host-service-ports || true
    IFS= read -r INGRESS_PORTS < /etc/orkestrator/ingress-ports || true
fi
ork_use_policy "$NETWORK_POLICY"

STATUS_DIR="$ORK_STATUS_DIR"
STATUS_FILE="$ORK_STATUS_FILE"

write_status() {
    mkdir -p "$STATUS_DIR"
    chmod 0755 "$STATUS_DIR"
    local tmp="$STATUS_FILE.tmp.$$"
    printf '%s\n' "$1" > "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$STATUS_FILE"
}

# Check network mode - if full, skip firewall entirely
if [ "${NETWORK_MODE:-restricted}" = "full" ]; then
    echo "Network mode: FULL - skipping firewall configuration"
    echo "Container has unrestricted internet access"
    write_status "{\"policy\":$NETWORK_POLICY,\"mode\":\"full\",\"appliedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    exit 0
fi

echo "Network mode: RESTRICTED - configuring firewall"

# One firewall mutation at a time: a refresh or an edit waits for this.
mkdir -p "$STATUS_DIR"
exec 8>"$ORK_LOCK_FILE"
flock -w 120 8

firewall_fail_closed() {
    trap - ERR
    iptables -P INPUT DROP 2>/dev/null || true
    iptables -P FORWARD DROP 2>/dev/null || true
    iptables -P OUTPUT DROP 2>/dev/null || true
    ip6tables -P INPUT DROP 2>/dev/null || true
    ip6tables -P FORWARD DROP 2>/dev/null || true
    ip6tables -P OUTPUT DROP 2>/dev/null || true
    write_status "{\"policy\":$NETWORK_POLICY,\"mode\":\"restricted\",\"state\":\"failed\",\"appliedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" 2>/dev/null || true
}
trap firewall_fail_closed ERR

# IPv6 is not enforced by the rules below, so it is closed outright: only
# loopback. A container that has a non-loopback IPv6 address and no working
# ip6tables cannot be restricted, and the policy fails.
IPV6_STATE=blocked
if ip6tables -P INPUT DROP 2>/dev/null && ip6tables -P FORWARD DROP 2>/dev/null && ip6tables -P OUTPUT DROP 2>/dev/null; then
    ip6tables -F
    ip6tables -A INPUT -i lo -j ACCEPT
    ip6tables -A OUTPUT -o lo -j ACCEPT
elif awk '$6 != "lo" { found = 1 } END { exit !found }' /proc/net/if_inet6 2>/dev/null; then
    echo "ERROR: IPv6 is configured but ip6tables is unavailable"
    exit 1
else
    IPV6_STATE=disabled
fi

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Set the restrictive policies before clearing a single rule. Any later error
# therefore leaves the namespace closed, including failures in discovery.
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# Flush existing rules and delete existing ipsets
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true
ipset destroy "$ORK_NEXT_SET" 2>/dev/null || true

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

# The stored ALLOWED_DOMAINS list (comma-separated); `none` for an empty list
# (only GitHub); or the image defaults when nothing was configured at all.
if [ "${ALLOWED_DOMAINS:-}" = "none" ]; then
    echo "No allowed domains beyond GitHub"
    DOMAINS_CSV=""
elif [ -n "${ALLOWED_DOMAINS:-}" ]; then
    echo "Using custom allowed domains from ALLOWED_DOMAINS environment variable"
    DOMAINS_CSV="$ALLOWED_DOMAINS"
else
    echo "Using default allowed domains"
    DOMAINS_CSV=$(ork_default_domains)
    [ -n "$DOMAINS_CSV" ] || echo "WARNING: $ORK_DEFAULT_DOMAINS_FILE is missing or empty; allowing only GitHub"
fi

# Name checks run in an egress gateway on policy 3 (firewall-domains.sh). The
# daemon starts before any lookup below, because every query from here on,
# the firewall's own included, is redirected to it.
FILTER_STATE=$(ork_filter_state)
FILTER_MATCH=()
if [ "$FILTER_STATE" = enforced ]; then
    echo "Starting name checks (SNI, Host and DNS)"
    ork_write_filter_names "$DOMAINS_CSV"
    if ! ork_start_filter; then
        echo "ERROR: the name-check daemon did not start"
        exit 1
    fi
    FILTER_MATCH=(-m mark --mark "$ORK_FILTER_MARK")
    # Redirected traffic goes to this namespace's own address rather than to
    # 127.0.0.1: a packet with a non-loopback source routed to loopback is a
    # martian unless route_localnet is set, which a container cannot change.
    FILTER_ADDRESS=$(ip -4 route get 192.0.2.1 | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
    if [[ ! "$FILTER_ADDRESS" =~ $ORK_IPV4 ]]; then
        echo "ERROR: no address to redirect to for the name checks"
        exit 1
    fi
    # Docker's resolver and any resolver off this host; a resolver the
    # workload runs on loopback itself is left alone.
    for protocol in udp tcp; do
        iptables -t nat -I OUTPUT 1 -p "$protocol" --dport 53 ! -d 127.0.0.0/8 -m mark ! --mark "$ORK_FILTER_MARK" \
            -j DNAT --to-destination "$FILTER_ADDRESS:$ORK_FILTER_DNS_PORT"
        iptables -t nat -I OUTPUT 1 -p "$protocol" --dport 53 -d 127.0.0.11 -m mark ! --mark "$ORK_FILTER_MARK" \
            -j REDIRECT --to-ports "$ORK_FILTER_DNS_PORT"
    done
fi

# Docker's actual embedded resolver port is discoverable through procfs.
# Only marked daemon queries may reach it, including after Docker's DNAT.
if [ "$FILTER_STATE" = enforced ]; then
    iptables -A OUTPUT -d 127.0.0.11 -m mark ! --mark "$ORK_FILTER_MARK" -j REJECT
    # Docker's resolver sends from its private high port here and SNATs to
    # 53 in POSTROUTING. A workload can bind the unused .11:53 itself, but
    # must not impersonate that post-NAT endpoint on a connected query socket.
    iptables -A OUTPUT -p udp -s 127.0.0.11 --sport 53 -m mark ! --mark "$ORK_FILTER_MARK" -j REJECT
fi

# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
if [ "$FILTER_STATE" = enforced ]; then
    # Traffic redirected to the daemon. The filter sees a redirected packet
    # with the output interface it was first routed to, not loopback, so it
    # is admitted by its new destination.
    iptables -A OUTPUT -p tcp -d "$FILTER_ADDRESS" --dport "$ORK_FILTER_PROXY_PORT" -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$FILTER_ADDRESS" --dport "$ORK_FILTER_DNS_PORT" -j ACCEPT
    iptables -A OUTPUT -p udp -d "$FILTER_ADDRESS" --dport "$ORK_FILTER_DNS_PORT" -j ACCEPT
fi

# Responses are allowed only for connections this namespace initiated.
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# DNS may only reach the resolvers Docker placed in resolv.conf. This keeps UDP
# 53 from becoming a general-purpose exfiltration channel.
while read -r resolver; do
    [ -n "$resolver" ] || continue
    iptables -A OUTPUT -p udp -d "$resolver" --dport 53 "${FILTER_MATCH[@]}" -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$resolver" --dport 53 "${FILTER_MATCH[@]}" -j ACCEPT
done < <(awk '$1 == "nameserver" { print $2 }' "$ORK_RESOLV_CONF")

# On a user-defined network the nameserver is Docker's embedded resolver,
# which forwards to its upstream servers from inside this namespace. Docker
# names them in resolv.conf ("# ExtServers: [a b]"); an entry written as
# host(...) is contacted from the host namespace and needs no rule. With name
# checks the daemon asks these upstreams itself, and only its marked queries
# may reach them; the embedded resolver's own relays are redirected to it.
while read -r upstream; do
    [[ "$upstream" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || continue
    iptables -A OUTPUT -p udp -d "$upstream" --dport 53 "${FILTER_MATCH[@]}" -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$upstream" --dport 53 "${FILTER_MATCH[@]}" -j ACCEPT
done < <(sed -n 's/^# ExtServers: \[\(.*\)\]$/\1/p' "$ORK_RESOLV_CONF" | tr ' ' '\n')

# Create ipset with CIDR and per-entry expiry support
ork_create_set allowed-domains
if [ "$FILTER_STATE" = enforced ]; then
    # Every new TCP connection the workload opens to an allowed tuple goes to
    # the daemon first; the daemon's own, marked, connection is the one that
    # leaves.
    iptables -t nat -I OUTPUT 1 -p tcp ! --dport 53 -m mark ! --mark "$ORK_FILTER_MARK" \
        -m set --match-set allowed-domains dst,dst -j DNAT --to-destination "$FILTER_ADDRESS:$ORK_FILTER_PROXY_PORT"
fi

# Bootstrap only the GitHub metadata endpoint needed to discover the complete
# published git/web/API ranges. The ordinary allowlist rule is already active,
# so no temporary ACCEPT policy is required.
BOOTSTRAP_PORT=""
if [ "$ORK_TUPLES" = 1 ]; then BOOTSTRAP_PORT=",$ORK_DEFAULT_PORT"; fi
while read -r ip; do
    [ -n "$ip" ] && ipset add -exist allowed-domains "$ip$BOOTSTRAP_PORT" timeout 0
done < <(ork_dig +short A api.github.com | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/')
if [ "$FILTER_STATE" = enforced ]; then
    # UDP entries (`host:port/udp`) carry no name the daemon could check.
    iptables -A OUTPUT -p tcp "${FILTER_MATCH[@]}" -m set --match-set allowed-domains dst,dst -j ACCEPT
    iptables -A OUTPUT -p udp -m set --match-set allowed-domains dst,dst -j ACCEPT
elif [ "$ORK_TUPLES" = 1 ]; then
    iptables -A OUTPUT -m set --match-set allowed-domains dst,dst -j ACCEPT
else
    iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
fi

# GitHub's published web/api/git ranges. In order: the backend's hourly seed
# when it is under a day old (no call to GitHub at all), a live fetch of
# api.github.com/meta (cached in this container), or this container's last good
# copy when under seven days old. The endpoint allows 60 unauthenticated calls
# an hour per address, so fetching on every boot makes restarts fail closed
# under load. With nothing valid the firewall still fails.
GITHUB_SEED="$ORK_GITHUB_SEED"
GITHUB_CACHE="$ORK_GITHUB_CACHE"
GITHUB_SOURCE=""

fetch_github_ranges() {
    local gh_ranges tmp address
    local resolve_args=()
    if [ -d "$ORK_POLICY_DIR/trusted-network" ]; then
        address=$(ork_dig +short A api.github.com | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print; exit }')
        [ -n "$address" ] || return 1
        resolve_args=(--resolve "api.github.com:443:$address")
    fi
    echo "Fetching GitHub IP ranges..."
    gh_ranges=$(curl -fsS --max-time 20 "${resolve_args[@]}" https://api.github.com/meta) || return 1
    [ -n "$gh_ranges" ] || return 1
    if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
        echo "ERROR: GitHub API response missing required fields"
        return 1
    fi
    mkdir -p "$(dirname "$GITHUB_CACHE")"
    tmp="$GITHUB_CACHE.tmp.$$"
    {
        echo "# github-ranges $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$'
    } > "$tmp" || return 1
    mv -f "$tmp" "$GITHUB_CACHE"
}

echo "Processing GitHub IPs..."
GITHUB_FILE=""
if ork_ranges_fresh_within "$GITHUB_SEED" 86400 && ork_load_github_ranges allowed-domains "$GITHUB_SEED"; then
    GITHUB_SOURCE=seed GITHUB_FILE="$GITHUB_SEED"
elif fetch_github_ranges && ork_load_github_ranges allowed-domains "$GITHUB_CACHE"; then
    GITHUB_SOURCE=live GITHUB_FILE="$GITHUB_CACHE"
elif ork_ranges_fresh_within "$GITHUB_SEED" 604800 && ork_load_github_ranges allowed-domains "$GITHUB_SEED"; then
    GITHUB_SOURCE=seed-stale GITHUB_FILE="$GITHUB_SEED"
elif ork_ranges_fresh_within "$GITHUB_CACHE" 604800 && ork_load_github_ranges allowed-domains "$GITHUB_CACHE"; then
    GITHUB_SOURCE=cached GITHUB_FILE="$GITHUB_CACHE"
else
    echo "ERROR: Failed to fetch GitHub IP ranges"
    exit 1
fi
# Refreshes rebuild the set from the ranges this boot accepted.
ork_remember_github_ranges "$GITHUB_FILE"
echo "GitHub ranges from: $GITHUB_SOURCE"

# Resolve the allowed domains within fixed bounds (count, addresses per
# domain, parallel lookups, per-query deadline). Each address expires unless
# a refresh re-resolves it.
ork_add_domains allowed-domains "$DOMAINS_CSV"
ork_commit_addresses "$(ork_members "$ORK_SET")"
RESOLVED_DOMAINS="$ORK_RESOLVED_DOMAINS"
UNRESOLVED_DOMAINS="$ORK_UNRESOLVED_DOMAINS"

# Get host IP from default route
HOST_IP=$(ip route | grep default | cut -d" " -f3)
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host IP"
    exit 1
fi

if [ "$NETWORK_POLICY" = "2" ] || [ "$NETWORK_POLICY" = "3" ]; then
    # Host services: exactly the named ports, on the gateway and on whatever
    # host.docker.internal resolves to (Docker Desktop answers with its own
    # address). Kept in their own chain so update-firewall.sh can replace
    # them atomically when the backend's port changes.
    iptables -N ORK_HOST_SERVICES
    HOST_ADDRESSES="$HOST_IP"
    while read -r address; do
        [ -n "$address" ] && HOST_ADDRESSES="$HOST_ADDRESSES"$'\n'"$address"
    done < <(ork_host_addresses | sort -u)
    OLDIFS="$IFS"; IFS=','; read -ra SERVICE_PORTS <<< "$HOST_SERVICE_PORTS"; IFS="$OLDIFS"
    for address in $(printf '%s\n' "$HOST_ADDRESSES" | sort -u); do
        for port in "${SERVICE_PORTS[@]}"; do
            [ -n "$port" ] || continue
            iptables -A ORK_HOST_SERVICES -p tcp -d "$address" --dport "$port" -j ACCEPT
        done
    done
    iptables -A OUTPUT -j ORK_HOST_SERVICES
    # Ingress: only new connections to the ports Docker publishes. The
    # environment's network holds only this container and its gateway.
    OLDIFS="$IFS"; IFS=','; read -ra PUBLISHED_PORTS <<< "$INGRESS_PORTS"; IFS="$OLDIFS"
    for port in "${PUBLISHED_PORTS[@]}"; do
        [ -n "$port" ] || continue
        iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    done
    echo "Host services: ${HOST_SERVICE_PORTS:-none}; published ports: ${INGRESS_PORTS:-none}"
else
    HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
    echo "Host network detected as: $HOST_NETWORK"
    iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
    iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT
fi

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
# Probe a reserved example host the allowlist does not name: a user may allow
# example.com itself, which must not make every boot fail.
BLOCKED_PROBE=""
for candidate in example.com example.net example.org; do
    if [ "$ORK_TUPLES" = 1 ]; then
        # ork_add_domains grouped the validated entries by host. Only TCP
        # 443 permits this HTTPS probe; other ports and UDP do not.
        case $'\n'"${ORK_DOMAIN_PORTS[$candidate]:-}" in *$'\n''tcp:443'$'\n'*) continue ;; esac
    else
        case ",$DOMAINS_CSV," in *",$candidate,"*) continue ;; esac
    fi
    BLOCKED_PROBE="$candidate"
    break
done
if [ -z "$BLOCKED_PROBE" ]; then
    iptables -C OUTPUT -j REJECT --reject-with icmp-admin-prohibited
    echo "Firewall verification passed - every example host is allowed; the final REJECT rule is in place"
elif curl --connect-timeout 5 "https://$BLOCKED_PROBE" >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - was able to reach https://$BLOCKED_PROBE"
    exit 1
else
    echo "Firewall verification passed - unable to reach https://$BLOCKED_PROBE as expected"
fi

if [ "$FILTER_STATE" = enforced ]; then
    # A name off the allowlist gets no answer, and an allowed address asked
    # for a name off the allowlist refuses the connection.
    PROBE_ANSWER=$(ork_dig +time=3 +tries=1 orkestrator-dns-probe.invalid A 2>&1 || true)
    case "$PROBE_ANSWER" in
        *"status: REFUSED"*) ;;
        *)
            echo "ERROR: Firewall verification failed - a name off the allowlist was not refused by DNS"
            exit 1
            ;;
    esac
    PROBE_ADDRESS=$( { ork_dig +short A api.github.com || true; } | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && !found++')
    if [ -z "$PROBE_ADDRESS" ]; then
        echo "ERROR: Firewall verification failed - api.github.com did not resolve through the name checks"
        exit 1
    fi
    if curl -k -sS -o /dev/null --connect-timeout 5 --max-time 10 \
        --resolve "orkestrator-sni-probe.invalid:443:$PROBE_ADDRESS" https://orkestrator-sni-probe.invalid/ >/dev/null 2>&1; then
        echo "ERROR: Firewall verification failed - an allowed address accepted a name off the allowlist"
        exit 1
    fi
    echo "Firewall verification passed - names off the allowlist are refused by DNS and at TLS"
fi

# Verify GitHub is reachable. Any HTTP answer proves the path is open; the
# web host is used rather than the API, whose unauthenticated calls count
# against a 60-an-hour budget per address.
if ! curl -sS -o /dev/null --connect-timeout 5 --max-time 15 https://github.com/ >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - unable to reach https://github.com"
    exit 1
else
    echo "Firewall verification passed - able to reach https://github.com as expected"
fi

NOW=$(ork_now)
NEXT_DELAY=$(ork_next_delay 0)
printf '%s\n' "$NEXT_DELAY" > "$ORK_DELAY_FILE"
printf '0\n' > "$ORK_FAILURES_FILE"
write_status "{\"policy\":$NETWORK_POLICY,\"mode\":\"restricted\",\"state\":\"applied\",\"appliedAt\":\"$(ork_iso "$NOW")\",\"refreshedAt\":\"$(ork_iso "$NOW")\",\"nextRefreshAt\":\"$(ork_iso $((NOW + NEXT_DELAY)))\",\"domainsRevision\":\"$(ork_domains_revision "$(ork_revision_list "${ALLOWED_DOMAINS:-}")")\",\"resolvedDomains\":$RESOLVED_DOMAINS,\"unresolvedDomains\":$UNRESOLVED_DOMAINS,\"carriedDomains\":$ORK_CARRIED_DOMAINS,\"invalidDomains\":$ORK_INVALID_DOMAINS,\"refreshFailures\":0,\"allowedEntries\":$(ork_members allowed-domains | awk 'NF { count++ } END { print count + 0 }'),\"hostServicePorts\":\"$HOST_SERVICE_PORTS\",\"ipv6\":\"$IPV6_STATE\",\"githubRanges\":\"$GITHUB_SOURCE\",\"egressFilter\":\"$FILTER_STATE\"}"
trap - ERR

# Keep resolved addresses current. The refresher runs as root, so the
# workload cannot stop it; it holds its own single-instance lock and must not
# inherit this script's mutation lock.
if [ -x /usr/local/bin/update-firewall.sh ]; then
    setsid /usr/local/bin/update-firewall.sh --refresh-loop </dev/null >/dev/null 2>&1 8>&- &
fi
exec 8>&-
