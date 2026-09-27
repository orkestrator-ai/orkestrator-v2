#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars, and pipeline failures
IFS=$'\n\t'       # Stricter word splitting

# Network policy contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY network-policy=2
#
# Policy 2 runs on the environment's own Docker network. Host access is not
# the gateway's /24 but exactly the host service ports the backend named, on
# the gateway and host.docker.internal addresses; inbound connections are
# accepted only on the container ports Docker publishes; IPv6 is disabled for
# the container and dropped here as well. Policy 1 (no policy file) keeps the
# earlier behaviour for containers created before it.
#
# This limits destinations. It does not stop data leaving through an allowed
# service, and a workload running as root in full mode can change it.

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

STATUS_DIR=/run/orkestrator
STATUS_FILE="$STATUS_DIR/firewall.json"
# Bounds on what one policy application resolves.
MAX_DOMAINS=256
MAX_ADDRESSES_PER_DOMAIN=32

write_status() {
    mkdir -p "$STATUS_DIR"
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

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Responses are allowed only for connections this namespace initiated.
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# DNS may only reach the resolvers Docker placed in resolv.conf. This keeps UDP
# 53 from becoming a general-purpose exfiltration channel.
while read -r resolver; do
    [ -n "$resolver" ] || continue
    iptables -A OUTPUT -p udp -d "$resolver" --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$resolver" --dport 53 -j ACCEPT
done < <(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)

# On a user-defined network the nameserver is Docker's embedded resolver,
# which forwards to its upstream servers from inside this namespace. Docker
# names them in resolv.conf ("# ExtServers: [a b]"); an entry written as
# host(...) is contacted from the host namespace and needs no rule.
while read -r upstream; do
    [[ "$upstream" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || continue
    iptables -A OUTPUT -p udp -d "$upstream" --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$upstream" --dport 53 -j ACCEPT
done < <(sed -n 's/^# ExtServers: \[\(.*\)\]$/\1/p' /etc/resolv.conf | tr ' ' '\n')

# Create ipset with CIDR support
ipset create allowed-domains hash:net

# Bootstrap only the GitHub metadata endpoint needed to discover the complete
# published git/web/API ranges. The ordinary allowlist rule is already active,
# so no temporary ACCEPT policy is required.
while read -r ip; do
    [ -n "$ip" ] && ipset add allowed-domains "$ip"
done < <(dig +short A api.github.com | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/')
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# GitHub's published web/api/git ranges. In order: the backend's hourly seed
# when it is under a day old (no call to GitHub at all), a live fetch of
# api.github.com/meta (cached in this container), or this container's last good
# copy when under seven days old. The endpoint allows 60 unauthenticated calls
# an hour per address, so fetching on every boot makes restarts fail closed
# under load. With nothing valid the firewall still fails.
GITHUB_SEED=/etc/orkestrator-seed/github-ranges
GITHUB_CACHE=/var/lib/orkestrator/github-ranges
GITHUB_SOURCE=""

ranges_fresh_within() {
    local file="$1" max_age="$2" header stamp fetched
    [ -f "$file" ] && [ ! -L "$file" ] || return 1
    IFS= read -r header < "$file" || return 1
    stamp="${header#\# github-ranges }"
    [ "$stamp" != "$header" ] || return 1
    fetched=$(date -d "$stamp" +%s 2>/dev/null) || return 1
    [ $(( $(date +%s) - fetched )) -le "$max_age" ]
}

load_github_ranges() {
    local file="$1" cidr count=0
    while IFS= read -r cidr; do
        case "$cidr" in '#'*|'') continue ;; esac
        if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
            echo "ERROR: Invalid CIDR range in GitHub ranges: $cidr"
            return 1
        fi
        # The bootstrap above already added api.github.com's own /32, which the
        # published ranges usually repeat verbatim.
        ipset add -exist allowed-domains "$cidr"
        count=$((count + 1))
    done < "$file"
    [ "$count" -gt 0 ]
}

fetch_github_ranges() {
    local gh_ranges tmp
    echo "Fetching GitHub IP ranges..."
    gh_ranges=$(curl -fsS --max-time 20 https://api.github.com/meta) || return 1
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
if ranges_fresh_within "$GITHUB_SEED" 86400 && load_github_ranges "$GITHUB_SEED"; then
    GITHUB_SOURCE=seed
elif fetch_github_ranges && load_github_ranges "$GITHUB_CACHE"; then
    GITHUB_SOURCE=live
elif ranges_fresh_within "$GITHUB_SEED" 604800 && load_github_ranges "$GITHUB_SEED"; then
    GITHUB_SOURCE=seed-stale
elif ranges_fresh_within "$GITHUB_CACHE" 604800 && load_github_ranges "$GITHUB_CACHE"; then
    GITHUB_SOURCE=cached
else
    echo "ERROR: Failed to fetch GitHub IP ranges"
    exit 1
fi
echo "GitHub ranges from: $GITHUB_SOURCE"

# Parse ALLOWED_DOMAINS environment variable (comma-separated)
# Fall back to default domains if not set
if [ -n "${ALLOWED_DOMAINS:-}" ]; then
    echo "Using custom allowed domains from ALLOWED_DOMAINS environment variable"
    # Convert comma-separated string to array, restoring IFS temporarily
    OLDIFS="$IFS"
    IFS=','
    read -ra DOMAIN_ARRAY <<< "$ALLOWED_DOMAINS"
    IFS="$OLDIFS"
else
    echo "Using default allowed domains"
    DOMAIN_ARRAY=(
        # Package registries and runtimes
        "registry.npmjs.org"
        "npmjs.org"
        "nodejs.org"
        "bun.sh"
        "mise.jdx.dev"
        "mise-versions.jdx.dev"
        "aube.jdx.dev"

        # AI providers
        "opencode.ai"
        "api.anthropic.com"
        "anthropic.com"
        "openai.com"
        "googleapis.com"
        "api.openrouter.ai"
        "openrouter.ai"
        "huggingface.co"
        "groq.com"
        "deepseek.com"
        "moonshot.ai"
        "ollama.com"
        "api.ollama.com"
        "together.ai"
        "x.ai"
        "auth.x.ai"
        "api.x.ai"
        "cli-chat-proxy.grok.com"
        "api2.cursor.sh"
        "api3.cursor.sh"
        "api4.cursor.sh"
        "api5.cursor.sh"
        "repo42.cursor.sh"
        "authenticator.cursor.sh"
        "marketplace.cursorapi.com"
        "cursor-cdn.com"
        "cursor.com"
        "bedrock.amazonaws.com"
        "pi.dev"
        "radius.pi.dev"

        # Cloud providers
        "vercel.com"
        "cloudflare.com"
        "microsoft.com"
        "azure.com"
        "sap.com"
        "account.hana.ondemand.com"

        # Analytics and monitoring
        "sentry.io"
        "statsig.anthropic.com"
        "statsig.com"
        "helicone.ai"

        # VS Code and extensions
        "marketplace.visualstudio.com"
        "vscode.blob.core.windows.net"
        "update.code.visualstudio.com"

        # Other services
        "github.com"
        "mcp.context7.com"
        "cdn.jsdelivr.net"
        # Playwright browser downloads. The image ships its own pinned Chromium,
        # so this only matters when a project pins a different Playwright version.
        "cdn.playwright.dev"
    )
fi

# Resolve and add allowed domains from configuration, within fixed bounds.
if [ "${#DOMAIN_ARRAY[@]}" -gt "$MAX_DOMAINS" ]; then
    echo "ERROR: ${#DOMAIN_ARRAY[@]} allowed domains exceed the limit of $MAX_DOMAINS"
    exit 1
fi
RESOLVED_DOMAINS=0
UNRESOLVED_DOMAINS=0
for domain in "${DOMAIN_ARRAY[@]}"; do
    # Skip github.com domains (handled separately via GitHub API)
    if [[ "$domain" == *"github.com"* ]]; then
        echo "Skipping $domain (GitHub IPs are fetched via API)"
        continue
    fi

    echo "Resolving $domain..."
    ips=$(dig +time=3 +tries=1 +noall +answer A "$domain" | awk '$4 == "A" {print $5}' | head -n "$MAX_ADDRESSES_PER_DOMAIN")
    if [ -z "$ips" ]; then
        echo "WARNING: Failed to resolve $domain, skipping"
        UNRESOLVED_DOMAINS=$((UNRESOLVED_DOMAINS + 1))
        continue
    fi
    RESOLVED_DOMAINS=$((RESOLVED_DOMAINS + 1))

    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "WARNING: Invalid IP from DNS for $domain: $ip, skipping"
            continue
        fi
        echo "Adding $ip for $domain"
        ipset add allowed-domains "$ip" 2>/dev/null || true
    done < <(echo "$ips")
done

# Get host IP from default route
HOST_IP=$(ip route | grep default | cut -d" " -f3)
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host IP"
    exit 1
fi

if [ "$NETWORK_POLICY" = "2" ]; then
    # Host services: exactly the named ports, on the gateway and on whatever
    # host.docker.internal resolves to (Docker Desktop answers with its own
    # address). Kept in their own chain so update-firewall.sh can replace
    # them atomically when the backend's port changes.
    iptables -N ORK_HOST_SERVICES
    HOST_ADDRESSES="$HOST_IP"
    while read -r address; do
        [ -n "$address" ] && HOST_ADDRESSES="$HOST_ADDRESSES"$'\n'"$address"
    done < <(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}' | sort -u)
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
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - was able to reach https://example.com"
    exit 1
else
    echo "Firewall verification passed - unable to reach https://example.com as expected"
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

write_status "{\"policy\":$NETWORK_POLICY,\"mode\":\"restricted\",\"state\":\"applied\",\"appliedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"resolvedDomains\":$RESOLVED_DOMAINS,\"unresolvedDomains\":$UNRESOLVED_DOMAINS,\"allowedEntries\":$(ipset list allowed-domains | awk '/^Members:/ { members = 1; next } members && NF { count++ } END { print count + 0 }'),\"hostServicePorts\":\"$HOST_SERVICE_PORTS\",\"ipv6\":\"$IPV6_STATE\",\"githubRanges\":\"$GITHUB_SOURCE\"}"
trap - ERR
