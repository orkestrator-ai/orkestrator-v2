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
#
# Network policy 3 stores address, protocol and port tuples rather than
# addresses: an allowed domain is reachable on TCP 443, or on exactly the port
# its entry names (`host:port` over TCP, `host:port/udp` over UDP), and
# GitHub's ranges on TCP 443 and 22. Earlier policies store addresses, open on
# every port, and are unchanged.

ORK_SET=allowed-domains
ORK_NEXT_SET=allowed-domains-next
ORK_POLICY_DIR=/etc/orkestrator
ORK_DEFAULT_DOMAINS_FILE=/usr/local/lib/orkestrator/default-allowed-domains
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

# Gateway lookups must never consult Docker's workload-writable network files.
# Legacy in-container enforcement retains its resolver behavior.
ORK_RESOLV_CONF=/etc/resolv.conf
if [ -d "$ORK_POLICY_DIR/trusted-network" ]; then
    ORK_RESOLV_CONF="$ORK_POLICY_DIR/trusted-network/resolv.conf"
fi
ork_dig() {
    if [ "$ORK_RESOLV_CONF" = /etc/resolv.conf ]; then
        dig "$@"
        return
    fi
    local resolver answer
    while read -r resolver; do
        [ -n "$resolver" ] || continue
        if answer=$(dig -r @"$resolver" "$@"); then
            printf '%s\n' "$answer"
            return 0
        fi
    done < <(awk '$1 == "nameserver" { print $2 }' "$ORK_RESOLV_CONF")
    return 1
}
ork_host_addresses() {
    if [ -d "$ORK_POLICY_DIR/trusted-network" ]; then
        cat "$ORK_POLICY_DIR/trusted-network/host-addresses"
    else
        getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}'
    fi
}

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
# Policy 3 entry: domain, then an optional port and protocol.
ORK_ENTRY='^([^:/]+)(:([1-9][0-9]{0,4})(/(tcp|udp))?)?$'
ORK_TUPLE='^([^,]+),(tcp|udp):([0-9]+)$'

# Set by ork_use_policy: 1 when the set holds policy 3 tuples.
ORK_TUPLES=0
ORK_DEFAULT_PORT=tcp:443
ORK_GITHUB_PORTS=(tcp:443 tcp:22)

ork_now() { date +%s; }

# The recorded network policy version; a container captured before policy 2
# has no file and runs policy 1.
ork_recorded_policy() {
    local version=""
    if [ -f "$ORK_POLICY_DIR/network-policy" ]; then
        IFS= read -r version < "$ORK_POLICY_DIR/network-policy" || true
    fi
    printf '%s' "${version:-1}"
}

# Selects the set layout for a network policy version.
ork_use_policy() {
    if [ "$1" = 3 ]; then ORK_TUPLES=1; else ORK_TUPLES=0; fi
}

ork_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# The revision of a domain list: the same digest the backend computes over the
# comma-separated list it configured.
ork_domains_revision() {
    printf '%s' "$1" | sha256sum | cut -c1-16
}

# The list a stored value stands for when computing its revision: `none` is
# the empty list.
ork_revision_list() {
    if [ "$1" = "none" ]; then printf ''; else printf '%s' "$1"; fi
}

# The image defaults, comma-separated: the list generated from the backend's
# canonical defaults (scripts/generate-default-allowed-domains.ts). A missing
# file is an empty list, which allows nothing beyond GitHub.
ork_default_domains() {
    [ -r "$ORK_DEFAULT_DOMAINS_FILE" ] || return 0
    awk '{ gsub(/[ \t\r]/, "") } $0 != "" && $0 !~ /^#/' "$ORK_DEFAULT_DOMAINS_FILE" | paste -sd, -
}

# The domains a stored value applies: `none` is nothing beyond GitHub, empty
# is the image defaults.
ork_effective_domains() {
    case "$1" in
        none) printf '' ;;
        '') ork_default_domains ;;
        *) printf '%s' "$1" ;;
    esac
}

ork_create_set() {
    local type=hash:net
    if [ "$ORK_TUPLES" = 1 ]; then type=hash:net,port; fi
    ipset create "$1" "$type" timeout 0 maxelem "$ORK_MAX_ENTRIES"
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
    local set="$1" file="$2" cidr spec count=0
    while IFS= read -r cidr; do
        case "$cidr" in '#'*|'') continue ;; esac
        if [[ ! "$cidr" =~ $ORK_CIDR ]]; then
            echo "ERROR: Invalid CIDR range in GitHub ranges: $cidr"
            return 1
        fi
        # The bootstrap already added api.github.com's own /32, which the
        # published ranges usually repeat verbatim.
        if [ "$ORK_TUPLES" = 1 ]; then
            for spec in "${ORK_GITHUB_PORTS[@]}"; do
                ipset add -exist "$set" "$cidr,$spec" timeout 0 || return 1
            done
        else
            ipset add -exist "$set" "$cidr" timeout 0 || return 1
        fi
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

# Policy 3: groups ORK_DOMAIN_LIST's entries by domain, leaving each domain
# once in ORK_DOMAIN_LIST and its protocol:port specs, one per line, in
# ORK_DOMAIN_PORTS. An entry without a port is TCP 443. An entry whose port
# or protocol is malformed is dropped and counted in ORK_INVALID_PORTS.
ork_group_entries() {
    local entry domain port
    local -a domains=()
    declare -gA ORK_DOMAIN_PORTS=()
    ORK_INVALID_PORTS=0
    for entry in "${ORK_DOMAIN_LIST[@]}"; do
        if [[ ! "$entry" =~ $ORK_ENTRY ]] || [ "${BASH_REMATCH[3]:-443}" -gt 65535 ]; then
            ORK_INVALID_PORTS=$((ORK_INVALID_PORTS + 1))
            continue
        fi
        domain="${BASH_REMATCH[1],,}"
        port="${BASH_REMATCH[5]:-tcp}:${BASH_REMATCH[3]:-443}"
        if [ -z "${ORK_DOMAIN_PORTS[$domain]+set}" ]; then
            domains+=("$domain")
            ORK_DOMAIN_PORTS[$domain]=""
        fi
        ORK_DOMAIN_PORTS[$domain]+="$port"$'\n'
    done
    ORK_DOMAIN_LIST=("${domains[@]}")
}

# Adds one address of a domain: the address itself, or under policy 3 one
# tuple per protocol and port the domain's entries name.
ork_add_address() {
    local set="$1" domain="$2" address="$3" timeout="$4" spec
    if [ "$ORK_TUPLES" != 1 ]; then
        ipset add -exist "$set" "$address" timeout "$timeout"
        return
    fi
    while IFS= read -r spec; do
        [ -n "$spec" ] || continue
        ipset add -exist "$set" "$address,$spec" timeout "$timeout" || return 1
    done <<< "${ORK_DOMAIN_PORTS[$domain]}"
}

# GitHub ranges cover the built-in TCP ports only. Explicit extra tuples
# must be resolved like any other domain so edits can add and revoke them.
ork_github_covers_entries() {
    local domain="$1" spec
    [[ "$domain" == github.com || "$domain" == *.github.com ]] || return 1
    [ "$ORK_TUPLES" = 1 ] || return 0
    while IFS= read -r spec; do
        case "$spec" in ''|tcp:443|tcp:22) ;; *) return 1 ;; esac
    done <<< "${ORK_DOMAIN_PORTS[$domain]}"
    return 0
}

# Resolves ORK_DOMAIN_LIST with bounded concurrency. Each domain's answer
# lands in "$1/<index>" as "address ttl" lines; an empty or missing file is a
# failure. Invalid names and entries covered by GitHub ranges are skipped.
ork_resolve_all() {
    local dir="$1" index=0 domain running=0
    ORK_INVALID_DOMAINS=0
    for domain in "${ORK_DOMAIN_LIST[@]}"; do
        if ork_github_covers_entries "$domain"; then
            : > "$dir/skip.$index"
        elif [ "${#domain}" -gt 253 ] || [[ ! "$domain" =~ $ORK_DOMAIN ]]; then
            ORK_INVALID_DOMAINS=$((ORK_INVALID_DOMAINS + 1))
            : > "$dir/skip.$index"
        else
            # A failed lookup leaves an empty file; it must not reach the
            # caller's ERR trap from this subshell.
            (
                { ork_dig +time=3 +tries=2 +noall +answer A "$domain" 2>/dev/null || true; } \
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
    ORK_INVALID_PORTS=0
    if [ "$ORK_TUPLES" = 1 ]; then ork_group_entries; fi
    dir=$(mktemp -d) || return 1
    ork_resolve_all "$dir"
    ORK_INVALID_DOMAINS=$((ORK_INVALID_DOMAINS + ORK_INVALID_PORTS))
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
                ork_add_address "$set" "$domain" "$address" "$ORK_ADDRESS_LIFETIME" || return 1
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
                ork_add_address "$set" "$domain" "$address" "$remaining" || return 1
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

# Deletes tracked connections to entries that left the set; a policy 3 tuple
# revokes only its own protocol and port. Sets ORK_REVOKED_ENTRIES and
# ORK_REVOCATION ("conntrack" or "unavailable").
ork_revoke() {
    local old="$1" new="$2" entry address count=0
    local -a port=()
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
        address="$entry"
        port=()
        if [[ "$entry" =~ $ORK_TUPLE ]]; then
            address="${BASH_REMATCH[1]}"
            port=(-p "${BASH_REMATCH[2]}" --dport "${BASH_REMATCH[3]}")
        fi
        if [[ "$address" =~ $ORK_CIDR ]]; then
            conntrack -D "${port[@]}" -d "${address%/*}" --mask-dst "$(ork_prefix_mask "${address#*/}")" >/dev/null 2>&1 || true
        elif [[ "$address" =~ $ORK_IPV4 ]]; then
            conntrack -D "${port[@]}" -d "$address" >/dev/null 2>&1 || true
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
