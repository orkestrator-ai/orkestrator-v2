#!/bin/bash
# Runtime firewall update script for Claude Code environments
# Allows adding/removing domains from the allowed-domains ipset at runtime
#
# Usage:
#   update-firewall.sh --add domain1,domain2,...
#   update-firewall.sh --remove domain1,domain2,...
#   update-firewall.sh --list
#
# Must be run as root via `docker exec --user root`. The node sudoers file
# no longer grants this script; runtime allowlist edits are an operator action.

set -euo pipefail
IFS=$'\n\t'

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

usage() {
    echo "Usage: $0 [--add|--remove|--list] [domain1,domain2,...]"
    echo ""
    echo "Options:"
    echo "  --add domain1,domain2,...    Add domains to the firewall whitelist"
    echo "  --remove domain1,domain2,... Remove domains from the firewall whitelist"
    echo "  --list                       List current ipset entries"
    echo ""
    echo "Examples:"
    echo "  $0 --add api.example.com,cdn.example.com"
    echo "  $0 --remove api.example.com"
    echo "  $0 --list"
    exit 1
}

# Validate domain format
validate_domain() {
    local domain="$1"
    # Basic domain validation regex
    if [[ ! "$domain" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; then
        echo -e "${RED}ERROR: Invalid domain format: $domain${NC}" >&2
        return 1
    fi
    return 0
}

# Resolve domain to IP addresses
resolve_domain() {
    local domain="$1"
    local ips

    ips=$(dig +noall +answer A "$domain" 2>/dev/null | awk '$4 == "A" {print $5}')

    if [ -z "$ips" ]; then
        echo -e "${YELLOW}WARNING: Could not resolve $domain${NC}" >&2
        return 1
    fi

    echo "$ips"
}

# Add domains to the whitelist
add_domains() {
    local domains_csv="$1"
    local added=0
    local failed=0

    # Check if ipset exists
    if ! ipset list allowed-domains &>/dev/null; then
        echo -e "${RED}ERROR: allowed-domains ipset does not exist. Is the firewall initialized?${NC}" >&2
        exit 1
    fi

    # Parse comma-separated domains
    IFS=',' read -ra DOMAINS <<< "$domains_csv"

    for domain in "${DOMAINS[@]}"; do
        # Trim whitespace
        domain=$(echo "$domain" | xargs)

        if [ -z "$domain" ]; then
            continue
        fi

        # Skip github.com domains (handled by init-firewall.sh via API)
        if [[ "$domain" == *"github.com"* ]]; then
            echo -e "${YELLOW}Skipping $domain (GitHub IPs are managed via API)${NC}"
            continue
        fi

        # Validate domain format
        if ! validate_domain "$domain"; then
            ((failed++))
            continue
        fi

        echo "Resolving $domain..."
        local ips
        if ! ips=$(resolve_domain "$domain"); then
            ((failed++))
            continue
        fi

        while read -r ip; do
            if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
                echo -e "${YELLOW}WARNING: Invalid IP from DNS for $domain: $ip${NC}" >&2
                continue
            fi

            # Add to ipset (ignore duplicates)
            if ipset add allowed-domains "$ip" 2>/dev/null; then
                echo -e "${GREEN}Added $ip for $domain${NC}"
                ((added++))
            else
                echo -e "${YELLOW}$ip already in whitelist (or error)${NC}"
            fi
        done <<< "$ips"
    done

    echo ""
    echo -e "${GREEN}Summary: Added $added IPs, $failed domains failed${NC}"
}

# Remove domains from the whitelist
remove_domains() {
    local domains_csv="$1"
    local removed=0
    local failed=0

    # Check if ipset exists
    if ! ipset list allowed-domains &>/dev/null; then
        echo -e "${RED}ERROR: allowed-domains ipset does not exist. Is the firewall initialized?${NC}" >&2
        exit 1
    fi

    # Parse comma-separated domains
    IFS=',' read -ra DOMAINS <<< "$domains_csv"

    for domain in "${DOMAINS[@]}"; do
        # Trim whitespace
        domain=$(echo "$domain" | xargs)

        if [ -z "$domain" ]; then
            continue
        fi

        # Validate domain format
        if ! validate_domain "$domain"; then
            ((failed++))
            continue
        fi

        echo "Resolving $domain..."
        local ips
        if ! ips=$(resolve_domain "$domain"); then
            ((failed++))
            continue
        fi

        while read -r ip; do
            if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
                echo -e "${YELLOW}WARNING: Invalid IP from DNS for $domain: $ip${NC}" >&2
                continue
            fi

            # Remove from ipset
            if ipset del allowed-domains "$ip" 2>/dev/null; then
                echo -e "${GREEN}Removed $ip for $domain${NC}"
                ((removed++))
            else
                echo -e "${YELLOW}$ip not in whitelist (or error)${NC}"
            fi
        done <<< "$ips"
    done

    echo ""
    echo -e "${GREEN}Summary: Removed $removed IPs, $failed domains failed${NC}"
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

# Main
if [ $# -lt 1 ]; then
    usage
fi

case "$1" in
    --add)
        if [ $# -lt 2 ]; then
            echo -e "${RED}ERROR: --add requires a comma-separated list of domains${NC}" >&2
            usage
        fi
        add_domains "$2"
        ;;
    --remove)
        if [ $# -lt 2 ]; then
            echo -e "${RED}ERROR: --remove requires a comma-separated list of domains${NC}" >&2
            usage
        fi
        remove_domains "$2"
        ;;
    --list)
        list_entries
        ;;
    *)
        echo -e "${RED}ERROR: Unknown option: $1${NC}" >&2
        usage
        ;;
esac
