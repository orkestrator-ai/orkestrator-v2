#!/bin/bash
# Allowlist construction shared by init-firewall.sh and update-firewall.sh.
# Sourced, never executed; both callers run as root.
#
# Refresh contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY network-refresh=1
#
# The allowed-domains set is always built beside the live one and swapped in,
# so a refresh or an edit never passes through an empty or allow-all set.
# Every resolved address carries a kernel timeout: it is trusted for
# ORK_ADDRESS_LIFETIME after its last successful resolution. A refresh that
# cannot resolve a domain keeps that domain's previous addresses only until
# their recorded expiry, and the kernel drops them then even when no refresh
# runs at all. An address that leaves the set is revoked: its tracked
# connections are deleted, so established flows are re-checked against the new
# set rather than continuing on an old conntrack entry.

ORK_SET=allowed-domains
ORK_NEXT_SET=allowed-domains-next
ORK_POLICY_DIR=/etc/orkestrator
# Root-only: /run/orkestrator belongs to node, which must not be able to plant
# a lock, a schedule or a status report here. node cannot create entries in
# /run, so this directory can only have been made by root.
ORK_STATUS_DIR=/run/orkestrator-firewall
ORK_STATUS_FILE="$ORK_STATUS_DIR/firewall.json"
ORK_LOCK_FILE="$ORK_STATUS_DIR/firewall.lock"
ORK_DELAY_FILE="$ORK_STATUS_DIR/refresh-delay"
ORK_FAILURES_FILE="$ORK_STATUS_DIR/refresh-failures"
ORK_STATE_DIR=/var/lib/orkestrator
ORK_ADDRESSES="$ORK_STATE_DIR/domain-addresses"
ORK_GITHUB_ACTIVE="$ORK_STATE_DIR/github-ranges-active"
ORK_GITHUB_SEED=/etc/orkestrator-seed/github-ranges
ORK_GITHUB_CACHE="$ORK_STATE_DIR/github-ranges"

# Fixed bounds on one application.
ORK_MAX_DOMAINS=256
ORK_MAX_ADDRESSES_PER_DOMAIN=32
ORK_MAX_ENTRIES=32768
ORK_MAX_REVOCATIONS=4096
ORK_RESOLVE_PARALLEL=8
# Six hours: how long an address stays trusted without a successful
# re-resolution of its domain.
ORK_ADDRESS_LIFETIME=21600
# Refresh cadence follows the shortest record TTL, within these bounds; after a
# failure it retries sooner with doubling backoff.
ORK_REFRESH_MIN=300
ORK_REFRESH_MAX=1800
ORK_RETRY_FIRST=60

ORK_IPV4='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
ORK_CIDR='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$'
ORK_DOMAIN='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'

ork_now() { date +%s; }

ork_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# The revision of a domain list: the same digest the backend computes over the
# comma-separated list it configured.
ork_domains_revision() {
    printf '%s' "$1" | sha256sum | cut -c1-16
}

ork_create_set() {
    ipset create "$1" hash:net timeout 0 maxelem "$ORK_MAX_ENTRIES"
}

# Members of a set, one per line, without their timeouts.
ork_members() {
    { ipset list "$1" 2>/dev/null || true; } \
        | awk '/^Members:/ { members = 1; next } members && NF { print $1 }' | LC_ALL=C sort -u
}

ork_ranges_fresh_within() {
    local file="$1" max_age="$2" header stamp fetched
    [ -f "$file" ] && [ ! -L "$file" ] || return 1
    IFS= read -r header < "$file" || return 1
    stamp="${header#\# github-ranges }"
    [ "$stamp" != "$header" ] || return 1
    fetched=$(date -d "$stamp" +%s 2>/dev/null) || return 1
    [ $(( $(ork_now) - fetched )) -le "$max_age" ]
}

# Adds a GitHub ranges file to a set (permanently, until the next build).
ork_load_github_ranges() {
    local set="$1" file="$2" cidr count=0
    while IFS= read -r cidr; do
        case "$cidr" in '#'*|'') continue ;; esac
        if [[ ! "$cidr" =~ $ORK_CIDR ]]; then
            echo "ERROR: Invalid CIDR range in GitHub ranges: $cidr"
            return 1
        fi
        # The bootstrap already added api.github.com's own /32, which the
        # published ranges usually repeat verbatim.
        ipset add -exist "$set" "$cidr" timeout 0 || return 1
        count=$((count + 1))
    done < "$file"
    [ "$count" -gt 0 ]
}

ork_remember_github_ranges() {
    local file="$1" tmp
    [ "$file" = "$ORK_GITHUB_ACTIVE" ] && return 0
    mkdir -p "$ORK_STATE_DIR"
    tmp="$ORK_GITHUB_ACTIVE.tmp.$$"
    cp "$file" "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$ORK_GITHUB_ACTIVE"
}

# Splits a comma-separated list into ORK_DOMAIN_LIST, dropping blanks.
ork_split_domains() {
    local csv="$1" entry
    local -a raw=()
    ORK_DOMAIN_LIST=()
    IFS=',' read -ra raw <<< "$csv"
    for entry in "${raw[@]}"; do
        entry="${entry//[[:space:]]/}"
        [ -n "$entry" ] && ORK_DOMAIN_LIST+=("$entry")
    done
}

# Resolves ORK_DOMAIN_LIST with bounded concurrency. Each domain's answer
# lands in "$1/<index>" as "address ttl" lines; an empty or missing file is a
# failure. Invalid names and GitHub's own hosts are not resolved.
ork_resolve_all() {
    local dir="$1" index=0 domain running=0
    ORK_INVALID_DOMAINS=0
    for domain in "${ORK_DOMAIN_LIST[@]}"; do
        if [[ "$domain" == *"github.com"* ]]; then
            : > "$dir/skip.$index"
        elif [ "${#domain}" -gt 253 ] || [[ ! "$domain" =~ $ORK_DOMAIN ]]; then
            ORK_INVALID_DOMAINS=$((ORK_INVALID_DOMAINS + 1))
            : > "$dir/skip.$index"
        else
            # A failed lookup leaves an empty file; it must not reach the
            # caller's ERR trap from this subshell.
            (
                { dig +time=3 +tries=2 +noall +answer A "$domain" 2>/dev/null || true; } \
                    | awk -v max="$ORK_MAX_ADDRESSES_PER_DOMAIN" '$4 == "A" && n < max { print $5, $2; n++ }' \
                    > "$dir/$index" || true
            ) &
            running=$((running + 1))
            if [ "$running" -ge "$ORK_RESOLVE_PARALLEL" ]; then
                wait -n || true
                running=$((running - 1))
            fi
        fi
        index=$((index + 1))
    done
    wait || true
}

# Fills a set with the configured domains' addresses. A domain keeps the
# unexpired addresses an earlier resolution gave it, whether or not it
# resolves now: a CDN that rotates its answer must not have its open
# connections revoked, and an address stays trusted only until ORK_ADDRESS_LIFETIME
# after the last answer that contained it. Writes the next address record to
# "$ORK_ADDRESSES.next". Sets ORK_RESOLVED_DOMAINS, ORK_UNRESOLVED_DOMAINS,
# ORK_CARRIED_DOMAINS (unresolved domains still using earlier addresses),
# ORK_INVALID_DOMAINS, ORK_MIN_TTL and ORK_EARLIEST_EXPIRY (earliest expiry
# of a carried domain's addresses, 0 when none).
ork_add_domains() {
    local set="$1" csv="$2" now dir index domain address ttl expires remaining kept resolved
    now=$(ork_now)
    ork_split_domains "$csv"
    if [ "${#ORK_DOMAIN_LIST[@]}" -gt "$ORK_MAX_DOMAINS" ]; then
        echo "ERROR: ${#ORK_DOMAIN_LIST[@]} allowed domains exceed the limit of $ORK_MAX_DOMAINS"
        return 1
    fi
    dir=$(mktemp -d) || return 1
    ork_resolve_all "$dir"
    mkdir -p "$ORK_STATE_DIR" || return 1
    : > "$ORK_ADDRESSES.next" || return 1
    ORK_RESOLVED_DOMAINS=0
    ORK_UNRESOLVED_DOMAINS=0
    ORK_CARRIED_DOMAINS=0
    ORK_MIN_TTL=0
    ORK_EARLIEST_EXPIRY=0
    index=0
    for domain in "${ORK_DOMAIN_LIST[@]}"; do
        if [ -e "$dir/skip.$index" ]; then
            index=$((index + 1))
            continue
        fi
        resolved=""
        if [ -s "$dir/$index" ]; then
            ORK_RESOLVED_DOMAINS=$((ORK_RESOLVED_DOMAINS + 1))
            expires=$((now + ORK_ADDRESS_LIFETIME))
            while IFS=' ' read -r address ttl; do
                [[ "$address" =~ $ORK_IPV4 ]] || continue
                ipset add -exist "$set" "$address" timeout "$ORK_ADDRESS_LIFETIME" || return 1
                printf '%s %s %s\n' "$domain" "$address" "$expires" >> "$ORK_ADDRESSES.next"
                resolved="$resolved $address "
                if [[ "$ttl" =~ ^[0-9]+$ ]] && { [ "$ORK_MIN_TTL" -eq 0 ] || [ "$ttl" -lt "$ORK_MIN_TTL" ]; }; then
                    ORK_MIN_TTL="$ttl"
                fi
            done < "$dir/$index"
        else
            echo "WARNING: Failed to resolve $domain"
            ORK_UNRESOLVED_DOMAINS=$((ORK_UNRESOLVED_DOMAINS + 1))
        fi
        # Earlier addresses of this domain, most recently confirmed first,
        # bounded per domain.
        kept=0
        if [ -f "$ORK_ADDRESSES" ]; then
            while IFS=' ' read -r address expires; do
                [ "$kept" -lt "$ORK_MAX_ADDRESSES_PER_DOMAIN" ] || break
                [[ "$address" =~ $ORK_IPV4 && "$expires" =~ ^[0-9]+$ ]] || continue
                case "$resolved" in *" $address "*) continue ;; esac
                remaining=$((expires - now))
                [ "$remaining" -gt 0 ] || continue
                ipset add -exist "$set" "$address" timeout "$remaining" || return 1
                printf '%s %s %s\n' "$domain" "$address" "$expires" >> "$ORK_ADDRESSES.next"
                kept=$((kept + 1))
                if [ -z "$resolved" ] && { [ "$ORK_EARLIEST_EXPIRY" -eq 0 ] || [ "$expires" -lt "$ORK_EARLIEST_EXPIRY" ]; }; then
                    ORK_EARLIEST_EXPIRY="$expires"
                fi
            done < <(awk -v d="$domain" '$1 == d { print $2, $3 }' "$ORK_ADDRESSES" | sort -k2,2nr)
        fi
        if [ -z "$resolved" ] && [ "$kept" -gt 0 ]; then
            ORK_CARRIED_DOMAINS=$((ORK_CARRIED_DOMAINS + 1))
        fi
        index=$((index + 1))
    done
    rm -rf "$dir"
}

ork_commit_addresses() {
    chmod 0644 "$ORK_ADDRESSES.next"
    mv -f "$ORK_ADDRESSES.next" "$ORK_ADDRESSES"
}

# Next refresh delay in seconds.
ork_next_delay() {
    local failures="$1" delay
    if [ "$failures" -gt 0 ]; then
        delay=$((ORK_RETRY_FIRST << (failures - 1 < 5 ? failures - 1 : 5)))
        [ "$delay" -gt "$ORK_REFRESH_MIN" ] && delay="$ORK_REFRESH_MIN"
    else
        delay="$ORK_MIN_TTL"
        [ "$delay" -lt "$ORK_REFRESH_MIN" ] && delay="$ORK_REFRESH_MIN"
        [ "$delay" -gt "$ORK_REFRESH_MAX" ] && delay="$ORK_REFRESH_MAX"
    fi
    echo "$delay"
}

ork_prefix_mask() {
    local bits="$1" mask=$(( (0xffffffff << (32 - $1)) & 0xffffffff ))
    [ "$bits" -eq 0 ] && mask=0
    printf '%d.%d.%d.%d' $((mask >> 24 & 255)) $((mask >> 16 & 255)) $((mask >> 8 & 255)) $((mask & 255))
}

# Deletes tracked connections to entries that left the set. Sets
# ORK_REVOKED_ENTRIES and ORK_REVOCATION ("conntrack" or "unavailable").
ork_revoke() {
    local old="$1" new="$2" entry count=0
    ORK_REVOKED_ENTRIES=0
    if ! command -v conntrack >/dev/null 2>&1; then
        ORK_REVOCATION=unavailable
        ORK_REVOKED_ENTRIES=$(LC_ALL=C comm -23 <(printf '%s\n' "$old") <(printf '%s\n' "$new") | awk 'NF { n++ } END { print n + 0 }')
        return 0
    fi
    ORK_REVOCATION=conntrack
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        [ "$count" -lt "$ORK_MAX_REVOCATIONS" ] || break
        if [[ "$entry" =~ $ORK_CIDR ]]; then
            conntrack -D -d "${entry%/*}" --mask-dst "$(ork_prefix_mask "${entry#*/}")" >/dev/null 2>&1 || true
        elif [[ "$entry" =~ $ORK_IPV4 ]]; then
            conntrack -D -d "$entry" >/dev/null 2>&1 || true
        else
            continue
        fi
        count=$((count + 1))
    done < <(LC_ALL=C comm -23 <(printf '%s\n' "$old") <(printf '%s\n' "$new"))
    ORK_REVOKED_ENTRIES="$count"
}

# Merges fields into the status report (a JSON object literal body), keeping
# what the initial application recorded.
ork_merge_status() {
    local patch="$1" tmp="$ORK_STATUS_FILE.tmp.$$"
    mkdir -p "$ORK_STATUS_DIR"
    if [ -f "$ORK_STATUS_FILE" ] && jq -c --argjson patch "{$patch}" '. + $patch' "$ORK_STATUS_FILE" > "$tmp" 2>/dev/null; then
        :
    else
        printf '{%s}\n' "$patch" > "$tmp"
    fi
    chmod 0644 "$tmp"
    mv -f "$tmp" "$ORK_STATUS_FILE"
}

# Rebuilds the allowlist for a domain list and activates it atomically:
# GitHub's ranges and api.github.com, then the domains. On success the old set
# is gone, removed entries are revoked, and the address record is committed.
ork_rebuild_allowlist() {
    local csv="$1" old new
    if ork_ranges_fresh_within "$ORK_GITHUB_SEED" 86400 && [ "$ORK_GITHUB_SEED" -nt "$ORK_GITHUB_ACTIVE" ]; then
        ork_remember_github_ranges "$ORK_GITHUB_SEED"
    fi
    [ -f "$ORK_GITHUB_ACTIVE" ] || { echo "ERROR: no GitHub ranges recorded"; return 1; }
    ipset destroy "$ORK_NEXT_SET" 2>/dev/null || true
    ork_create_set "$ORK_NEXT_SET" || return 1
    # Callers test this function, which suspends errexit inside it, so every
    # step that matters checks its own status.
    if ! ork_load_github_ranges "$ORK_NEXT_SET" "$ORK_GITHUB_ACTIVE" \
        || ! ork_add_domains "$ORK_NEXT_SET" "$csv"; then
        ipset destroy "$ORK_NEXT_SET" 2>/dev/null || true
        return 1
    fi
    old=$(ork_members "$ORK_SET")
    if ! ipset swap "$ORK_NEXT_SET" "$ORK_SET"; then
        ipset destroy "$ORK_NEXT_SET" 2>/dev/null || true
        return 1
    fi
    ipset destroy "$ORK_NEXT_SET" 2>/dev/null || true
    new=$(ork_members "$ORK_SET")
    ork_revoke "$old" "$new"
    ork_commit_addresses || return 1
}
