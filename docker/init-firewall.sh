#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars, and pipeline failures
IFS=$'\n\t'       # Stricter word splitting

# Check network mode - if full, skip firewall entirely
if [ "${NETWORK_MODE:-restricted}" = "full" ]; then
    echo "Network mode: FULL - skipping firewall configuration"
    echo "Container has unrestricted internet access"
    exit 0
fi

echo "Network mode: RESTRICTED - configuring firewall"

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

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

# First allow DNS and localhost before any restrictions
# Allow outbound DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
# Allow inbound DNS responses
iptables -A INPUT -p udp --sport 53 -j ACCEPT
# Allow outbound SSH
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
# Allow inbound SSH responses
iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Create ipset with CIDR support
ipset create allowed-domains hash:net

# Fetch GitHub meta information and aggregate + add their IP ranges
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -s https://api.github.com/meta)
if [ -z "$gh_ranges" ]; then
    echo "ERROR: Failed to fetch GitHub IP ranges"
    exit 1
fi

if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
    echo "ERROR: GitHub API response missing required fields"
    exit 1
fi

echo "Processing GitHub IPs..."
while read -r cidr; do
    if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
        echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
        exit 1
    fi
    echo "Adding GitHub range $cidr"
    ipset add allowed-domains "$cidr"
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

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

# Resolve and add allowed domains from configuration
for domain in "${DOMAIN_ARRAY[@]}"; do
    # Skip github.com domains (handled separately via GitHub API)
    if [[ "$domain" == *"github.com"* ]]; then
        echo "Skipping $domain (GitHub IPs are fetched via API)"
        continue
    fi

    echo "Resolving $domain..."
    ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
    if [ -z "$ips" ]; then
        echo "WARNING: Failed to resolve $domain, skipping"
        continue
    fi

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

HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
echo "Host network detected as: $HOST_NETWORK"

# Set up remaining iptables rules
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# Set default policies to DROP first
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# First allow established connections for already approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Then allow only specific outbound traffic to allowed domains
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

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

# Verify GitHub API access
if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
    exit 1
else
    echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi
