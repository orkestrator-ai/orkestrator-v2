#!/bin/bash
# Entrypoint script for Claude Code environments
# Handles minimal setup, then starts shell where workspace-setup.sh runs visibly

set -e

# Boot status contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY boot-status=1
# ORKESTRATOR_CAPABILITY bridge-credential=1
#
# Readiness belongs to this boot only. Markers from an earlier start of the
# same container are removed before anything else runs, and every status
# record names this boot's id and PID 1's start time, which changes on every
# container start. The backend accepts a record only when that start time
# matches the one it reads itself, so a record left by a previous boot can
# never release setup or agent launch.
BOOT_STATUS_DIR=/run/orkestrator
BOOT_STATUS_FILE="$BOOT_STATUS_DIR/boot-status.json"
rm -f /tmp/.environment-ready /tmp/.entrypoint-complete "$BOOT_STATUS_FILE"
# Container terminal shell records (CONTAINER_TERMINAL_PID_RECORD_COMMAND in
# apps/backend/src/core/container-scripts.ts) name processes of an earlier
# boot; none of them is alive now. Each shell start also sweeps its own uid's.
rm -rf "/tmp/orkestrator-terminals-$(id -u)"
mkdir -p "$BOOT_STATUS_DIR/processes"
# The root entrypoint opened this boot's record before its firewall step;
# keep its id so the record names one boot throughout.
case "${ORKESTRATOR_BOOT_ID:-}" in
    ????????-????-????-????-????????????) BOOT_ID="$ORKESTRATOR_BOOT_ID" ;;
    *) BOOT_ID="$(cat /proc/sys/kernel/random/uuid)" ;;
esac
unset ORKESTRATOR_BOOT_ID
BOOT_PID1_START="$(awk '{print $22}' /proc/1/stat)"
BOOT_PHASE=""
BOOT_FAILURE_CODE=""

# Portable input contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY staged-inputs=5
#
# Agent configuration and credentials arrive only at the read-only mount
# points below (/claude-config, /codex-home, /opencode-*, /grok-*, /pi-config,
# /cursor-config, /agents-skills, /claude-config.json, /tmp/gitconfig), and
# this script copies a bounded allowlist from each. Version 2 adds
# /cursor-config (Cursor's mcp.json only). Version 3 reads a mount node cannot
# open (rootless Docker) from the copy the root entrypoint relayed
# (staged_input_path). Version 4 adds /agents-skills (~/.agents/skills). Version 5
# leaves an input alone when copying it would change nothing, and removes what an
# earlier boot imported once it leaves the mounts (import_agent_input). A backend
# that sees this capability stages exactly that allowlist for enabled
# providers and binds the staged copies instead of whole host agent homes
# (apps/backend/src/core/portable-inputs.ts); the two lists must stay in step.

# Under rootless Docker, or on a rootful daemon whose host user is not uid
# 1000, node cannot open the owner-only staged mounts.
# network-policy-entrypoint.sh (relay_staged_inputs) then copied each such
# mount into node's own STAGED_INPUT_RELAY_DIR, keeping its absolute path
# below it. A mount path resolves to that copy when one exists, to itself
# otherwise. The copy helpers resolve their source root the same way, inline,
# so each works alone.
STAGED_INPUT_RELAY_DIR=/run/orkestrator-inputs
staged_input_path() {
    local relayed="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$1"
    if [ -e "$relayed" ] && [ ! -L "$relayed" ]; then
        printf '%s\n' "$relayed"
    else
        printf '%s\n' "$1"
    fi
}

# Atomic: a reader sees the previous record or this one, never a partial one.
write_boot_status() {
    BOOT_PHASE="$1"
    local failure="${2:-}"
    local failure_json=null
    [ -n "$failure" ] && failure_json="\"$failure\""
    local tmp="$BOOT_STATUS_FILE.$$.tmp"
    printf '{"version":1,"bootId":"%s","pid1Start":"%s","phase":"%s","failureCode":%s,"updatedAt":"%s"}\n' \
        "$BOOT_ID" "$BOOT_PID1_START" "$BOOT_PHASE" "$failure_json" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        > "$tmp" && mv -f "$tmp" "$BOOT_STATUS_FILE"
}

# Any exit before `ready` is a failed boot with a fixed reason code.
on_entrypoint_exit() {
    local status=$?
    if [ "$BOOT_PHASE" != "ready" ]; then
        write_boot_status failed "${BOOT_FAILURE_CODE:-entrypoint-failed}" || true
    fi
    exit "$status"
}
trap on_entrypoint_exit EXIT
write_boot_status initializing

# Progress file for workspace-setup.sh to read
PROGRESS_FILE="/tmp/.entrypoint-progress"
echo "" > "$PROGRESS_FILE"

# Function to log progress both to stdout and progress file.
# The terminal the user actually watches replays PROGRESS_FILE only, so anything
# they need to act on — a skipped auth.json leaves Codex looking logged out —
# has to go through here rather than stdout, which is `docker logs` territory.
# PROGRESS_FILE is initialized above, so every caller below is safe.
log_progress() {
    echo "$1"
    echo "$1" >> "$PROGRESS_FILE"
}

# Shared, agent-neutral copy helpers.
#
# Claude, Codex and OpenCode all mount a host config directory read-only and copy
# a bounded subset of it into writable container state. That subset is always an
# allowlist: every one of these homes also holds session history, logs, caches and
# host-platform binaries that are large, unportable, or private to the host. Each
# agent passes its own display name as the fourth argument so warnings name the
# agent whose state was skipped.
#
# Every skip is both warned about individually and accumulated, because a single
# warning line scrolls past in a wall of setup output. Losing an allowlisted
# entry is not cosmetic — a host that symlinks ~/.claude/commands into a dotfiles
# repo (ordinary) gets a container with none of its custom commands — so each
# agent block ends with one consolidated line naming everything it dropped.
AGENT_COPY_SKIPPED=""

agent_copy_warn() {
    local relative_path="$1"
    local message="$2"
    local suffix="${3:-}"

    log_progress "Warning: $message: $relative_path${suffix:+ $suffix}"
    AGENT_COPY_SKIPPED="${AGENT_COPY_SKIPPED:+$AGENT_COPY_SKIPPED, }$relative_path"
}

# Emits the consolidated summary for one agent and re-arms the accumulator for
# the next. Callers invoke this even when nothing was skipped, so the reset is
# unconditional; a leaked entry would otherwise be re-reported under the wrong
# agent's name.
report_agent_copy_skips() {
    local label="$1"

    if [ -n "${AGENT_COPY_SKIPPED:-}" ]; then
        log_progress "  $label host config NOT copied into this container: $AGENT_COPY_SKIPPED"
        log_progress "  (symlinked, oversized or unreadable entries are skipped by design - see the warnings above)"
    fi
    AGENT_COPY_SKIPPED=""
}

# Claude, Codex and Grok refresh tokens are single-use, and most OpenCode and Pi
# OAuth logins rotate theirs: a container copy that refreshed would spend the
# token the host still holds and sign the host and other containers out.
# The backend stages these logins access-only
# (packages/protocol/src/login-snapshots.ts); this blanks the refresh token
# again in the container's own copy, so a host-mounted home or a copy imported
# before that change cannot refresh either. Codex's `last_refresh` is set to now
# so it uses the access token until it expires rather than trying a refresh it
# cannot make. OpenCode and Pi keep API keys and the OAuth logins whose refresh
# token is reused rather than rotated (NON_ROTATING_OAUTH_PROVIDERS there).
# Their files also hold logins made inside the container, which are its own to
# refresh, so only the providers the mounted host file (source root and
# relative path, the 4th and 5th arguments) holds as rotating OAuth are
# blanked, and nothing is touched when there is no such file. A file that
# cannot be read as JSON is removed, never kept whole.
restrict_imported_login() {
    local file="$1"
    local kind="$2"
    local label="$3"
    local source_root="${4:-}"
    local source_relative="${5:-}"
    local source=""
    # A relayed copy of a staged mount stands in for it (staged_input_path).
    case "$source_root" in
        /*) if [ -e "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ]; then
                source_root="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root"
            fi ;;
    esac

    [ -f "$file" ] && [ ! -L "$file" ] || return 0
    if [ "$kind" = opencode ] || [ "$kind" = pi ]; then
        agent_source_path_has_symlink "$source_root" "$source_relative" && return 0
        source="$source_root/$source_relative"
        [ -f "$source" ] || return 0
    fi
    if ! node -e '
        const fs = require("fs");
        const [file, kind, source] = process.argv.slice(1);
        const login = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!login || typeof login !== "object" || Array.isArray(login)) process.exit(1);
        if (kind === "claude") {
          const strip = (entry) => {
            if (entry && typeof entry === "object") delete entry.refreshToken;
          };
          strip(login.claudeAiOauth);
          if (login.mcpOAuth && typeof login.mcpOAuth === "object") Object.values(login.mcpOAuth).forEach(strip);
        } else if (kind === "grok") {
          for (const entry of Object.values(login)) {
            if (entry && typeof entry === "object" && "refresh_token" in entry) entry.refresh_token = "";
          }
        } else if (kind === "opencode" || kind === "pi") {
          const reusable = { opencode: ["github-copilot"], pi: ["github-copilot", "meta"] }[kind];
          const rotating = (entries) =>
            Object.entries(entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {})
              .filter(([provider, entry]) => entry && typeof entry === "object" && entry.type === "oauth" && !reusable.includes(provider))
              .map(([provider]) => provider);
          let host = [];
          try { host = rotating(JSON.parse(fs.readFileSync(source, "utf8"))); } catch {}
          for (const provider of rotating(login)) {
            if (host.includes(provider)) login[provider].refresh = "";
          }
        } else if (login.tokens && typeof login.tokens === "object") {
          if ("refresh_token" in login.tokens) login.tokens.refresh_token = "";
          login.last_refresh = new Date().toISOString();
        }
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(login), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, file);
    ' "$file" "$kind" "$source" 2>/dev/null; then
        rm -f "$file" "$file".*.tmp
        log_progress "Warning: removed an unreadable $label login; sign in again inside the container if needed"
    fi
}

# Allowlist entries can be nested ("plugins/cache"), so testing only the final
# component leaves every parent free to be a link: a symlinked "plugins" holding
# a real "cache" passed that test and let find/cp resolve straight into excluded
# runtime state. Walk every component below the source root instead, and treat
# ".." as unsafe so a future allowlist entry cannot escape the root either.
agent_source_path_has_symlink() {
    local source_root="$1"
    local relative_path="$2"
    local current="$source_root"
    local remainder="$relative_path"
    local component

    if [ -L "$source_root" ]; then
        return 0
    fi

    while [ -n "$remainder" ]; do
        component="${remainder%%/*}"
        if [ "$component" = "$remainder" ]; then
            remainder=""
        else
            remainder="${remainder#*/}"
        fi
        if [ -z "$component" ]; then
            continue
        fi
        if [ "$component" = ".." ]; then
            return 0
        fi
        current="$current/$component"
        if [ -L "$current" ]; then
            return 0
        fi
    done

    return 1
}

# Destination paths are writable container state, so a previous workload can
# replace the destination root or any component below it with a link between
# container starts. The root's parents are outside this helper's owned boundary
# (and standard systems commonly link paths such as /var), so start at the
# destination root itself.
agent_destination_path_has_symlink() {
    local destination_root="$1"
    local relative_path="$2"
    local current="$destination_root"
    local remainder="$relative_path"
    local component

    if [ -L "$destination_root" ]; then
        return 0
    fi

    while [ -n "$remainder" ]; do
        component="${remainder%%/*}"
        if [ "$component" = "$remainder" ]; then
            remainder=""
        else
            remainder="${remainder#*/}"
        fi
        if [ -z "$component" ] || [ "$component" = "." ]; then
            continue
        fi
        if [ "$component" = ".." ]; then
            return 0
        fi
        current="$current/$component"
        if [ -L "$current" ]; then
            return 0
        fi
    done

    return 1
}

# Write ~/.claude/.credentials.json as a fresh regular 0600 file. A reused
# container can replace the destination leaf with a symlink into the
# workspace; redirection and cp would follow it. mktemp plus rename never
# writes through that leaf, and a parent-directory symlink is refused.
publish_claude_credentials() {
    local destination_root="$HOME/.claude"
    local relative_path=".credentials.json"
    local destination_path="$destination_root/$relative_path"
    local source_path="${1:-}"
    local contents="${2:-}"
    local destination_parent
    local temporary_path

    if ! mkdir -p "$destination_root"; then
        echo "Failed to create Claude credential directory" >&2
        return 1
    fi
    if [ -L "$destination_root" ]; then
        echo "Refusing Claude credential write: destination directory is a symlink" >&2
        return 1
    fi
    if [ -L "$destination_path" ]; then
        rm -f "$destination_path" || return 1
    fi
    if [ -n "$source_path" ]; then
        if agent_source_path_has_symlink "$(dirname "$source_path")" "$(basename "$source_path")"; then
            echo "Refusing Claude credential copy: source path is a symlink" >&2
            return 1
        fi
        if [ ! -f "$source_path" ]; then
            echo "Refusing Claude credential copy: source is not a regular file" >&2
            return 1
        fi
    fi
    destination_parent="$(dirname "$destination_path")"
    temporary_path="$(mktemp "$destination_parent/.credentials.json.XXXXXX")" || {
        echo "Failed to create Claude credential tempfile" >&2
        return 1
    }
    if [ -n "$source_path" ]; then
        if ! cp "$source_path" "$temporary_path"; then
            rm -f "$temporary_path"
            echo "Failed to copy Claude credentials" >&2
            return 1
        fi
    elif ! printf '%s\n' "$contents" > "$temporary_path"; then
        rm -f "$temporary_path"
        echo "Failed to write Claude credentials" >&2
        return 1
    fi
    # Sanitize the private payload before publication. A concurrent backend
    # push must win even if it lands while this import is being restricted.
    restrict_imported_login "$temporary_path" claude Claude
    if [ ! -f "$temporary_path" ]; then return 1; fi
    if ! chmod 600 "$temporary_path"; then
        rm -f "$temporary_path"
        return 1
    fi
    # Atomic create-if-absent, unlike a test followed by rename. The backend
    # replaces this file atomically, so its newer payload always wins.
    if ! node -e 'require("fs").linkSync(process.argv[1], process.argv[2])' "$temporary_path" "$destination_path" 2>/dev/null; then
        if [ -f "$destination_path" ] && [ ! -L "$destination_path" ]; then
            rm -f "$temporary_path"
            return 0
        fi
        rm -f "$temporary_path"
        echo "Failed to publish Claude credentials" >&2
        return 1
    fi
    rm -f "$temporary_path"
    chmod 600 "$destination_path"
}

copy_agent_file() {
    AGENT_FILE_PUBLISHED=false
    local source_root="$1"
    # A relayed copy of a staged mount stands in for it (staged_input_path).
    case "$source_root" in
        /*) if [ -e "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ]; then
                source_root="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root"
            fi ;;
    esac
    local destination_root="$2"
    local relative_path="$3"
    # Display name of the calling agent, used only in warnings.
    local label="${4:-Agent}"
    local source_path="$source_root/$relative_path"
    local destination_path="$destination_root/$relative_path"
    local max_bytes="${AGENT_COPY_MAX_FILE_BYTES:-10485760}"
    local file_bytes
    local destination_parent
    local temporary_path

    # An allowlisted name must be a real file in the mounted agent home. Following
    # a link anywhere along the path could turn an allowlisted name into an
    # arbitrary rollout, log, credential, or other host file.
    if agent_source_path_has_symlink "$source_root" "$relative_path"; then
        agent_copy_warn "$relative_path" "Skipping symlinked $label file"
        return 0
    fi

    if [ ! -f "$source_path" ]; then
        return 0
    fi

    if agent_destination_path_has_symlink "$destination_root" "$relative_path"; then
        agent_copy_warn "$relative_path" "Skipping $label file with symlinked destination"
        return 0
    fi

    case "$max_bytes" in
        ''|*[!0-9]*)
            max_bytes=10485760
            ;;
    esac
    file_bytes="$(wc -c < "$source_path" 2>/dev/null)" || {
        agent_copy_warn "$relative_path" "Failed to inspect $label file"
        return 0
    }
    # BSD wc pads its count with leading spaces; GNU wc does not.
    file_bytes="${file_bytes##*[[:space:]]}"
    if [ "$file_bytes" -gt "$max_bytes" ]; then
        agent_copy_warn "$relative_path" "Skipping oversized $label file"
        return 0
    fi

    if [ -d "$destination_path" ]; then
        agent_copy_warn "$relative_path" "Failed to copy $label file" "(destination is a directory)"
        return 0
    fi
    destination_parent="$(dirname "$destination_path")"
    if ! mkdir -p "$destination_parent" 2>/dev/null; then
        agent_copy_warn "$relative_path" "Failed to create destination for $label file"
        return 0
    fi
    # Recheck after mkdir, then copy to a fresh regular file and rename it into
    # place. In particular, cp never receives the allowlisted destination leaf,
    # so it cannot follow an auth.json/config.toml link if one is present.
    if agent_destination_path_has_symlink "$destination_root" "$relative_path"; then
        agent_copy_warn "$relative_path" "Skipping $label file with symlinked destination"
        return 0
    fi
    temporary_path="$(mktemp "$destination_parent/.agent-copy.XXXXXX" 2>/dev/null)" || {
        agent_copy_warn "$relative_path" "Failed to create destination for $label file"
        return 0
    }
    if ! cp "$source_path" "$temporary_path" 2>/dev/null ||
        ! mv -f "$temporary_path" "$destination_path" 2>/dev/null; then
        rm -f "$temporary_path" 2>/dev/null || true
        agent_copy_warn "$relative_path" "Failed to copy $label file"
    else
        AGENT_FILE_PUBLISHED=true
        # Copy helpers record what they imported only after a successful
        # copy, so the per-entry walker keeps its successes without claiming a
        # refused sibling. This is what `find -printf '%y%p\0'` lists for a
        # regular file, without starting a find.
        if [ -n "${AGENT_INPUT_COPIED_PATHS:-}" ]; then
            printf 'f%s\0' "$relative_path" >> "$AGENT_INPUT_COPIED_PATHS" 2>/dev/null ||
                agent_copy_warn "$relative_path" "Failed to record copied input; will retry"
        fi
    fi
}

# Walks one directory below the current directory for copy_agent_directory:
# prints "<entries> <links> <blocks>", a newline, then "<walk>:<count>" exit
# statuses. Each entry is one line holding its type and its allocated
# 512-byte blocks, which is what `du -sk` sums, so a name holding a newline
# cannot be miscounted; a walk that listed nothing counts -1 entries. The
# count stops reading after `limit` entries below the directory, which closes the pipe, so find stops walking a pathological
# tree instead of scanning and buffering it in full. With a listing path, the
# same walk writes the input stamp's `%y%p\0` listing there.
agent_input_directory_walk() {
    local relative_path="$1" limit="$2" listing="$3"
    local record=() status
    if [ "${AGENT_COPY_PORTABLE_WALK:-}" != 1 ]; then
        [ -z "$listing" ] || record=(-fprintf "$listing" '%y%p\0')
        find -P "$relative_path" "${record[@]}" -printf '%y %b\n' 2>/dev/null |
            awk -v limit="$limit" '
                { if ($1 == "l") links = 1; blocks += $2; if (NR - 1 >= limit) exit }
                END { printf "%d %d %.0f", NR - 1, links, blocks }'
        status=("${PIPESTATUS[@]}")
        printf '\n%s:%s' "${status[0]}" "${status[1]:-1}"
        return 0
    fi
    # Without GNU find's -printf (BSD find, as on macOS): find lists NUL-ended
    # names and builtin tests classify each one, so counting, the link check
    # and the listing are still one walk. The blocks come from one du -sk,
    # run only for a tree within its bounds and free of links.
    [ -z "$listing" ] || : > "$listing" 2>/dev/null || { printf '\n1:0'; return 0; }
    find -P "$relative_path" -print0 2>/dev/null | {
        entries=-1 links=0 kib=0
        while IFS= read -r -d '' entry; do
            entries=$((entries + 1))
            if [ -L "$entry" ]; then type=l links=1
            elif [ -d "$entry" ]; then type=d
            elif [ -f "$entry" ]; then type=f
            elif [ -p "$entry" ]; then type=p
            elif [ -S "$entry" ]; then type=s
            elif [ -c "$entry" ]; then type=c
            elif [ -b "$entry" ]; then type=b
            else type=U
            fi
            if [ -n "$listing" ]; then
                printf '%s%s\0' "$type" "$entry" >> "$listing" 2>/dev/null || exit 1
            fi
            [ "$entries" -lt "$limit" ] || break
        done
        if [ "$entries" -ge 0 ] && [ "$entries" -lt "$limit" ] && [ "$links" = 0 ]; then
            kib="$(du -sk -- "$relative_path" 2>/dev/null)" || exit 1
            kib="${kib%%[[:space:]]*}"
        fi
        case "$kib" in ''|*[!0-9]*) exit 1 ;; esac
        printf '%d %d %d' "$entries" "$links" "$((kib * 2))"
    }
    status=("${PIPESTATUS[@]}")
    printf '\n%s:%s' "${status[0]}" "${status[1]:-1}"
}

copy_agent_directory() {
    local source_root="$1"
    # A relayed copy of a staged mount stands in for it (staged_input_path).
    case "$source_root" in
        /*) if [ -e "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ]; then
                source_root="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root"
            fi ;;
    esac
    local destination_root="$2"
    local relative_path="$3"
    # Display name of the calling agent, used only in warnings.
    local label="${4:-Agent}"
    # What warnings and the consolidated summary call this directory. A caller
    # that copies a whole mount passes "." as the relative path, and a summary
    # reading "NOT copied into this container: ." names nothing the user can act
    # on. Such callers pass the agent-relative name here instead.
    local display_path="${5:-$relative_path}"
    local source_path="$source_root/$relative_path"
    local destination_path="$destination_root/$relative_path"
    local max_entries="${AGENT_COPY_MAX_DIRECTORY_ENTRIES:-5000}"
    local max_kib="${AGENT_COPY_MAX_DIRECTORY_KIB:-262144}"
    local walk
    local walk_status
    local walk_summary
    local walk_listing=""
    local walk_attempt
    local find_status
    local awk_status
    local entry_count
    local found_links
    local directory_blocks
    local directory_kib
    local destination_existed=false
    local found_symlink

    # Do not dereference an allowlist link, at any depth. In particular, a host
    # can otherwise make "skills" or the "plugins" parent of "plugins/cache"
    # point at excluded runtime state.
    if agent_source_path_has_symlink "$source_root" "$relative_path"; then
        agent_copy_warn "$display_path" "Skipping symlinked $label directory"
        return 0
    fi

    if [ ! -d "$source_path" ]; then
        return 0
    fi

    if agent_destination_path_has_symlink "$destination_root" "$relative_path"; then
        agent_copy_warn "$display_path" "Skipping $label directory with symlinked destination"
        return 0
    fi

    case "$max_entries" in
        ''|*[!0-9]*)
            max_entries=5000
            ;;
    esac
    case "$max_kib" in
        ''|*[!0-9]*)
            max_kib=262144
            ;;
    esac
    # One walk answers the entry bound, the link check and the size bound, and
    # lists the directory for the input stamp when one is recording. Starting a
    # dozen processes per directory was most of a many-skill first start
    # (to-do 6740 task 3). find's failure is expected once the cap is exceeded,
    # but otherwise fails closed.
    if [ -n "${AGENT_INPUT_COPIED_PATHS:-}" ]; then
        walk_listing="$AGENT_INPUT_COPIED_PATHS.unit"
    fi
    for walk_attempt in 1 2; do
        walk="$(
            set +e
            cd "$source_root" 2>/dev/null || { printf '\n1:0'; exit 0; }
            agent_input_directory_walk "$relative_path" "$((max_entries + 1))" "$walk_listing"
        )"
        walk_status="${walk##*$'\n'}"
        walk_summary="${walk%$'\n'*}"
        find_status="${walk_status%%:*}"
        awk_status="${walk_status#*:}"
        entry_count="" found_links="" directory_blocks=""
        read -r entry_count found_links directory_blocks <<< "$walk_summary" || true
        # find lists at least the directory itself, so a walk that listed
        # nothing never started: this find has no -printf. The rest of this
        # boot uses the portable walk.
        if [ "$entry_count" = -1 ] && [ "${AGENT_COPY_PORTABLE_WALK:-}" != 1 ]; then
            AGENT_COPY_PORTABLE_WALK=1
            continue
        fi
        break
    done
    case "${entry_count:-x}${found_links:-x}${directory_blocks:-x}" in
        *[!0-9]*) awk_status=1 ;;
    esac
    if [ "$awk_status" != 0 ]; then
        agent_copy_warn "$display_path" "Failed to inspect $label directory"
        return 0
    fi
    if [ "$entry_count" -gt "$max_entries" ]; then
        agent_copy_warn "$display_path" "Skipping oversized $label directory"
        return 0
    fi
    if [ "$find_status" != 0 ]; then
        agent_copy_warn "$display_path" "Failed to inspect $label directory"
        return 0
    fi
    if [ "$found_links" != 0 ]; then
        agent_copy_warn "$display_path" "Skipping $label directory containing symlink"
        return 0
    fi
    directory_kib=$(((directory_blocks + 1) / 2))
    if [ "$directory_kib" -gt "$max_kib" ]; then
        agent_copy_warn "$display_path" "Skipping oversized $label directory"
        return 0
    fi

    if [ -e "$destination_path" ] && [ ! -d "$destination_path" ]; then
        agent_copy_warn "$display_path" "Failed to copy $label directory" "(destination is not a directory)"
        return 0
    fi
    if [ -e "$destination_path" ] || [ -L "$destination_path" ]; then
        destination_existed=true
    elif ! mkdir -p "$destination_path" 2>/dev/null; then
        agent_copy_warn "$display_path" "Failed to create destination for $label directory"
        return 0
    fi
    if agent_destination_path_has_symlink "$destination_root" "$relative_path"; then
        agent_copy_warn "$display_path" "Skipping $label directory with symlinked destination"
        return 0
    fi
    # A directory this call just created holds nothing, so only one that was
    # already there (an earlier boot's copy, or the workload's) is searched.
    if [ "$destination_existed" = true ]; then
        found_symlink="$(find -P "$destination_path" -type l -print -quit 2>/dev/null)" || {
            agent_copy_warn "$display_path" "Failed to inspect $label directory destination"
            return 0
        }
        if [ -n "$found_symlink" ]; then
            agent_copy_warn "$display_path" "Skipping $label directory containing destination symlink"
            return 0
        fi
    fi
    if ! cp -R "$source_path/." "$destination_path/" 2>/dev/null; then
        agent_copy_warn "$display_path" "Failed to copy $label directory"
    elif [ -n "$walk_listing" ]; then
        # Recorded only after the copy succeeded (see copy_agent_file). The
        # walk above listed exactly what cp copied: the mount is read-only.
        cat -- "$walk_listing" >> "$AGENT_INPUT_COPIED_PATHS" 2>/dev/null ||
            agent_copy_warn "$relative_path" "Failed to record copied input; will retry"
    fi
}

# User-authored extension directories (Claude's commands/skills/agents/ide/plugins,
# Grok's hooks/skills/commands) copy per-entry rather than all-or-nothing.
# A dotfiles manager symlinking one file into ~/.claude/commands is ordinary;
# the strict directory helper above would reject the whole directory over that
# single link and silently drop every custom command. This walker copies each
# regular file and subdirectory independently through the bounded helpers, so
# one symlinked or oversized entry is skipped on its own and the rest still
# lands. The directory itself must still not be a link, and the destination
# must stay link-free, exactly as with copy_agent_directory.
copy_agent_directory_entries() {
    local source_root="$1"
    # A relayed copy of a staged mount stands in for it (staged_input_path).
    case "$source_root" in
        /*) if [ -e "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ]; then
                source_root="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root"
            fi ;;
    esac
    local destination_root="$2"
    local relative_path="$3"
    # Display name of the calling agent, used only in warnings.
    local label="${4:-Agent}"
    # Optional exact top-level entry to omit (for example OpenCode's
    # host-platform node_modules directory).
    local excluded_entry="${5:-}"
    local source_path="$source_root/$relative_path"
    local destination_path="$destination_root/$relative_path"
    local max_entries="${AGENT_COPY_MAX_DIRECTORY_ENTRIES:-5000}"
    local entry_count=0
    local entry
    local entry_name

    if agent_source_path_has_symlink "$source_root" "$relative_path"; then
        agent_copy_warn "$relative_path" "Skipping symlinked $label directory"
        return 0
    fi

    if [ ! -d "$source_path" ]; then
        return 0
    fi

    if agent_destination_path_has_symlink "$destination_root" "$relative_path"; then
        agent_copy_warn "$relative_path" "Skipping $label directory with symlinked destination"
        return 0
    fi

    case "$max_entries" in
        ''|*[!0-9]*)
            max_entries=5000
            ;;
    esac

    # `-print0` keeps filenames with spaces or newlines intact. `-P` (the
    # default) never dereferences the source tree, so a symlinked entry is
    # reported as a link and skipped rather than followed out of the mount.
    # Entries are delegated with the full agent-relative path so the warnings
    # and the consolidated summary name them the same way as every other skip.
    while IFS= read -r -d '' entry || [ -n "$entry" ]; do
        entry_count=$((entry_count + 1))
        if [ "$entry_count" -gt "$max_entries" ]; then
            agent_copy_warn "$relative_path" "Skipping remainder of oversized $label directory"
            break
        fi
        entry_name="${entry#$source_path/}"
        if [ -n "$excluded_entry" ] && [ "$entry_name" = "$excluded_entry" ]; then
            continue
        fi
        if [ -L "$entry" ]; then
            agent_copy_warn "$relative_path/$entry_name" "Skipping symlinked $label entry"
            continue
        fi
        if [ -f "$entry" ]; then
            copy_agent_file "$source_root" "$destination_root" "$relative_path/$entry_name" "$label"
        elif [ -d "$entry" ]; then
            copy_agent_directory "$source_root" "$destination_root" "$relative_path/$entry_name" "$label"
        fi
    done < <(find -P "$source_path" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
}

# Copying an unchanged input again costs a few processes per skill and rewrites
# the container's layer on every start, so each non-login input is stamped.
#
# The stamp is not what makes skipping safe. The backend rewrites a revision in
# place (the logins before every start, a revocation's scrub, a refreshed MCP
# default), so neither the revision label nor a file's time says what changed,
# and the relay's tar drops sub-second times. An input is left alone only when its
# current content hashes the same as the stamp AND the home still holds exactly
# those bytes at real, unlinked paths: the one case where the copy would change
# nothing. Anything else, including a missing, damaged or forged stamp, runs the
# unchanged copy helpers with their link and size rules. A copy that warned is
# not stamped as complete, so it runs again and warns again.
#
# What the stamp adds is memory: the paths an earlier boot imported, so that one
# that has left the mounts leaves the home too. Paths the container made itself
# are never listed. The home is the workload's to write, so a stamp is not a
# security boundary, and it holds names and digests rather than contents. It
# lives in the container layer, so a new runtime starts with a full copy.
#
# Logins never come through here (forget_unchanged_agent_login).
agent_input_stamp() {
    local destination_root="$1"
    local relative_path="$2"
    local directory="$HOME/.orkestrator-inputs"
    local key="$destination_root/$relative_path"

    if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
        rm -f "$directory" 2>/dev/null || return 1
    fi
    if [ ! -d "$directory" ]; then
        mkdir -m 700 "$directory" 2>/dev/null || return 1
    fi
    key="${key//%/%25}"
    AGENT_INPUT_STAMP="$directory/${key//\//%2F}"
    if [ -L "$AGENT_INPUT_STAMP" ]; then
        rm -f "$AGENT_INPUT_STAMP" 2>/dev/null || return 1
    fi
}

# An input that cannot be seen because node cannot open its mount (a relay that
# failed) is not an input that was removed. Walks up to the nearest path that
# exists; node's own relayed copy of it always counts as readable.
agent_input_source_readable() {
    local path="$1"
    local relayed

    while [ -n "$path" ]; do
        relayed="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$path"
        if [ -e "$relayed" ] && [ ! -L "$relayed" ]; then
            return 0
        fi
        if [ -e "$path" ]; then
            [ -r "$path" ] && [ -x "$path" ]
            return
        fi
        path="${path%/*}"
    done
    return 0
}

# Writes one input's listing to `paths` (NUL-separated, one type letter then the
# path) and content digests to `sums` (sha256sum's own format, so a name holding
# a newline survives). Fails on anything it could not read.
agent_input_manifest() {
    local source_root="$1"
    local relative_path="$2"
    local excluded_entry="$3"
    local output="$4"

    (
        set -o pipefail
        export LC_ALL=C
        cd "$source_root" || exit 1
        find -P "$relative_path" -path "$relative_path/$excluded_entry" -prune \
            -o -printf '%y%p\0' | sort -z > "$output/paths" || exit 1
        find -P "$relative_path" -path "$relative_path/$excluded_entry" -prune \
            -o -type f -print0 | sort -z | xargs -0 -r sha256sum -- > "$output/sums"
    ) 2>/dev/null
}

# Whether the home holds this listing's bytes at real paths. Every directory on
# the way is listed, so a linked parent fails here too. Other entries beside
# them (a CLI's own state, OpenCode's node_modules) are not the input's business.
agent_input_home_matches() {
    local destination_root="$1"
    local relative_path="$2"
    local manifest="$3"
    local entry
    local path

    if agent_destination_path_has_symlink "$destination_root" "$relative_path"; then
        return 1
    fi
    while IFS= read -r -d '' entry; do
        path="$destination_root/${entry:1}"
        case "$entry" in
            d*) { [ -d "$path" ] && [ ! -L "$path" ]; } || return 1 ;;
            f*) { [ -f "$path" ] && [ ! -L "$path" ]; } || return 1 ;;
            *) return 1 ;;
        esac
    done < "$manifest/paths"
    [ -s "$manifest/sums" ] || return 0
    (
        cd "$destination_root" && LC_ALL=C sha256sum --check --status "$manifest/sums"
    ) 2>/dev/null
}

# Removes what the previous listing imported and the current one no longer has:
# files first, then each directory if that left it empty, deepest first. The
# listing is workload-writable, so a path through a link or `..` is refused.
agent_input_forget_removed() {
    local previous="$1"
    local current="$2"
    local destination_root="$3"
    local entry
    local path
    local failed=0

    while IFS= read -r -d '' entry; do
        path="${entry:1}"
        case "$entry" in
            f*)
                if agent_destination_path_has_symlink "$destination_root" "$path"; then
                    continue
                fi
                if [ ! -d "$destination_root/$path" ] || [ -L "$destination_root/$path" ]; then
                    if ! rm -f -- "$destination_root/$path" 2>/dev/null; then
                        failed=1
                        agent_copy_warn "$path" "Failed to remove imported input; will retry"
                    fi
                fi
                ;;
        esac
    done < <(LC_ALL=C comm -z -23 --nocheck-order "$previous" "$current" 2>/dev/null || true)
    while IFS= read -r -d '' entry; do
        path="${entry:1}"
        case "$entry" in
            d*)
                if ! agent_destination_path_has_symlink "$destination_root" "$path"; then
                    rmdir -- "$destination_root/$path" 2>/dev/null || true
                fi
                ;;
        esac
    done < <(LC_ALL=C comm -z -23 --nocheck-order "$previous" "$current" 2>/dev/null | LC_ALL=C sort -rz || true)
    return "$failed"
}

# Runs one copy helper for one input, unless that would change nothing:
#   import_agent_input <copy helper> <mount> <destination root> <relative path> <helper's other arguments>
import_agent_input() {
    local helper="$1"
    local mount="$2"
    local destination_root="$3"
    local relative_path="$4"
    shift 4
    # A relayed copy of a staged mount stands in for it (staged_input_path).
    local source_root="$mount"
    case "$source_root" in
        /*) if [ -e "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ]; then
                source_root="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root"
            fi ;;
    esac
    local source_path="$source_root/$relative_path"
    local destination_path="$destination_root/$relative_path"
    local excluded_entry=""
    local skipped_before="${AGENT_COPY_SKIPPED:-}"
    local fresh

    if ! agent_input_stamp "$destination_root" "$relative_path"; then
        "$helper" "$mount" "$destination_root" "$relative_path" "$@"
        return 0
    fi
    local stamp="$AGENT_INPUT_STAMP"

    # Gone from the mounts. The helper still runs, for its warning on a link.
    if [ ! -e "$source_path" ] && [ ! -L "$source_path" ]; then
        if agent_input_source_readable "$mount" && [ -e "$stamp" ]; then
            if [ -f "$stamp" ]; then
                if ! agent_destination_path_has_symlink "$destination_root" "$relative_path" &&
                    [ ! -d "$destination_path" ]; then
                    if ! rm -f -- "$destination_path" 2>/dev/null; then
                        agent_copy_warn "$relative_path" "Failed to remove imported input; will retry"
                        return 0
                    fi
                fi
            elif [ -f "$stamp/paths" ]; then
                agent_input_forget_removed "$stamp/paths" /dev/null "$destination_root" || return 0
            fi
            rm -rf -- "$stamp" 2>/dev/null || true
        fi
        "$helper" "$mount" "$destination_root" "$relative_path" "$@"
        return 0
    fi

    # A single file costs less to compare than to list and hash, and its stamp
    # only needs to say that it was imported.
    if [ "$helper" = copy_agent_file ]; then
        if [ -f "$source_path" ] && [ -f "$destination_path" ] && [ ! -L "$destination_path" ] &&
            ! agent_source_path_has_symlink "$source_root" "$relative_path" &&
            ! agent_destination_path_has_symlink "$destination_root" "$relative_path" &&
            cmp -s -- "$source_path" "$destination_path"; then
            AGENT_INPUTS_UNCHANGED=$((${AGENT_INPUTS_UNCHANGED:-0} + 1))
        else
            "$helper" "$mount" "$destination_root" "$relative_path" "$@"
            AGENT_INPUTS_COPIED=$((${AGENT_INPUTS_COPIED:-0} + 1))
        fi
        if [ "${AGENT_COPY_SKIPPED:-}" = "$skipped_before" ]; then
            { : > "$stamp"; } 2>/dev/null || true
        fi
        return 0
    fi

    if [ "$helper" = copy_agent_directory_entries ]; then
        excluded_entry="${2:-}"
    fi
    fresh="$stamp.fresh"
    rm -rf -- "$fresh" 2>/dev/null || true
    # In doubt: copy, and keep what the old stamp remembers for the next boot.
    if ! mkdir -m 700 "$fresh" 2>/dev/null ||
        ! agent_input_manifest "$source_root" "$relative_path" "$excluded_entry" "$fresh"; then
        rm -rf -- "$fresh" 2>/dev/null || true
        "$helper" "$mount" "$destination_root" "$relative_path" "$@"
        AGENT_INPUTS_COPIED=$((${AGENT_INPUTS_COPIED:-0} + 1))
        return 0
    fi
    if [ -f "$stamp/sums" ] && [ ! -L "$stamp/sums" ] && [ ! -L "$stamp/paths" ] &&
        cmp -s -- "$fresh/paths" "$stamp/paths" && cmp -s -- "$fresh/sums" "$stamp/sums" &&
        agent_input_home_matches "$destination_root" "$relative_path" "$fresh"; then
        rm -rf -- "$fresh" 2>/dev/null || true
        AGENT_INPUTS_UNCHANGED=$((${AGENT_INPUTS_UNCHANGED:-0} + 1))
        return 0
    fi
    if [ -d "$stamp" ] && [ -f "$stamp/paths" ] && [ ! -L "$stamp/paths" ]; then
        if ! agent_input_forget_removed "$stamp/paths" "$fresh/paths" "$destination_root"; then
            # Keep unresolved removals in the ownership union, and force a retry.
            if ! cp "$stamp/paths" "$fresh/pending" 2>/dev/null; then
                rm -rf -- "$fresh" 2>/dev/null || true
                "$helper" "$mount" "$destination_root" "$relative_path" "$@"
                return 0
            fi
        fi
    fi
    local AGENT_INPUT_COPIED_PATHS="$fresh/copied"
    if ! { : > "$AGENT_INPUT_COPIED_PATHS"; } 2>/dev/null; then
        rm -rf -- "$fresh" 2>/dev/null || true
        AGENT_INPUT_COPIED_PATHS=""
        "$helper" "$mount" "$destination_root" "$relative_path" "$@"
        return 0
    fi
    "$helper" "$mount" "$destination_root" "$relative_path" "$@"
    AGENT_INPUTS_COPIED=$((${AGENT_INPUTS_COPIED:-0} + 1))
    if ! (
        # Persistent metadata is optional. Never follow linked stamp leaves.
        if [ -s "$fresh/copied" ]; then
            printf 'd%s\0' "$relative_path" >> "$fresh/copied" || exit 1
        fi
        if [ -f "$stamp/paths" ] && [ ! -L "$stamp/paths" ]; then
            LC_ALL=C comm -z -12 --nocheck-order "$stamp/paths" "$fresh/paths" > "$fresh/retained" || exit 1
        fi
        : >> "$fresh/retained" &&
        : >> "$fresh/pending" &&
        LC_ALL=C sort -zu "$fresh/copied" "$fresh/retained" "$fresh/pending" > "$fresh/owned" &&
        mv "$fresh/owned" "$fresh/paths" &&
        rm -f "$fresh/copied" "$fresh/copied.unit" "$fresh/retained" "$fresh/pending" || exit 1
        if [ "${AGENT_COPY_SKIPPED:-}" != "$skipped_before" ]; then
            rm -f -- "$fresh/sums" || exit 1
        fi
    ) 2>/dev/null; then
        agent_copy_warn "$relative_path" "Failed to record input ownership; will retry"
        rm -rf -- "$fresh" 2>/dev/null || true
        return 0
    fi
    rm -rf -- "$stamp" 2>/dev/null || true
    mv -- "$fresh" "$stamp" 2>/dev/null || rm -rf -- "$fresh" 2>/dev/null || true
}

# Logins are imported on every start and never skipped: the entrypoint and the
# backend's pushes both rewrite the home's copy, so it rarely matches the mount,
# and a login must never outlive its source on a stamp's say-so.
#
# A login gone from the mount (a host sign-out, a revocation) must still leave
# the home, but only the copy this script put there. The digest recorded after
# the last import tells that copy from one the backend pushed since, or one the
# user signed in to here, and those stay with their owners: the backend's push,
# merge and sign-out paths, which race this script and must keep winning.
forget_unchanged_agent_login() {
    local destination_root="$1"
    local relative_path="$2"
    local destination_path="$destination_root/$relative_path"

    agent_input_stamp "$destination_root" "$relative_path" || return 0
    local stamp="$AGENT_INPUT_STAMP"
    [ -f "$stamp" ] || return 0
    # An empty stamp names no digest: nothing can match it.
    if [ -s "$stamp" ] && ! agent_destination_path_has_symlink "$destination_root" "$relative_path" &&
        [ -f "$destination_path" ] && [ ! -L "$destination_path" ] &&
        [ "$(sha256sum < "$destination_path" 2>/dev/null)" = "$(cat "$stamp" 2>/dev/null)" ]; then
        rm -f -- "$destination_path" 2>/dev/null || true
    fi
    rm -f -- "$stamp" 2>/dev/null || true
}

# Call once the login is restricted, so the digest is of what the home now holds.
remember_agent_login() {
    [ "${4:-false}" = true ] || return 0
    local source_root="$1"
    local destination_root="$2"
    local relative_path="$3"
    local destination_path="$destination_root/$relative_path"
    # A relayed copy of a staged mount stands in for it (staged_input_path).
    case "$source_root" in
        /*) if [ -e "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root" ]; then
                source_root="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$source_root"
            fi ;;
    esac

    [ -f "$source_root/$relative_path" ] || return 0
    [ -f "$destination_path" ] && [ ! -L "$destination_path" ] || return 0
    agent_destination_path_has_symlink "$destination_root" "$relative_path" && return 0
    agent_input_stamp "$destination_root" "$relative_path" || return 0
    { sha256sum < "$destination_path" > "$AGENT_INPUT_STAMP"; } 2>/dev/null || rm -f -- "$AGENT_INPUT_STAMP" 2>/dev/null || true
}

log_progress "=== Claude Code Environment Initializing ==="

# The root entrypoint (network-policy-entrypoint.sh) ran the firewall step
# before privileges dropped and recorded its outcome root-owned; node has no
# sudo grant for the firewall. In restricted mode a missing, failed or
# unverified firewall is fatal: the container must never report ready with an
# open network. With an egress gateway the firewall runs outside this
# container, and the root entrypoint only verified that it is enforced here.
network_mode=""
IFS= read -r network_mode < /etc/orkestrator/network-mode 2>/dev/null || true
firewall_boot=""
IFS= read -r firewall_boot < /run/orkestrator-network/firewall-boot 2>/dev/null || true
log_progress "Initializing network firewall..."
case "$firewall_boot" in
    applied|full) ;;
    gateway)
        log_progress "Network firewall enforced by the environment's egress gateway"
        ;;
    full-failed)
        log_progress "Warning: Firewall initialization failed in full-network mode"
        ;;
    gateway-unverified)
        BOOT_FAILURE_CODE=egress-unverified
        log_progress "ERROR: The egress gateway's firewall is not enforced in this container"
        exit 1
        ;;
    gateway-unavailable)
        BOOT_FAILURE_CODE=egress-gateway-unavailable
        log_progress "ERROR: The environment's egress gateway is not running"
        exit 1
        ;;
    missing)
        BOOT_FAILURE_CODE=firewall-missing
        log_progress "ERROR: Restricted network requested but the firewall is not installed"
        exit 1
        ;;
    *)
        if [ "${network_mode:-}" != "full" ]; then
            BOOT_FAILURE_CODE=firewall-failed
            log_progress "ERROR: Restricted-network firewall initialization failed"
            exit 1
        fi
        log_progress "Warning: Firewall initialization failed in full-network mode"
        ;;
esac
write_boot_status network-ready

# Set up Claude Code configuration
# The host's ~/.claude is mounted read-only at /claude-config
# We need to copy all config files to the writable ~/.claude directory
log_progress "Setting up Claude Code configuration..."
mkdir -p "$HOME/.claude"

if [ -d /claude-config ]; then
    # A Claude home is dominated by state a container must not inherit: jobs,
    # projects, file-history and transcripts routinely reach several GB. The
    # directory allowlist below already excluded those, but the top-level file
    # copy was an unbounded `find -maxdepth 1 -type f`, which swept up
    # history.jsonl — the host's rolling prompt history, including pasted
    # content, for every project — along with daemon.log and stats-cache.json.
    # Allowlist the portable inputs instead.
    #
    # settings.json is deliberately absent: this script overwrites it below with
    # the container's own bypass-permissions settings, and merges in only the
    # host's plugin enablement (staged filtered to `enabledPlugins`).
    # .credentials.json is handled by the dedicated credential block that
    # follows, which also chmods it.
    log_progress "  Copying essential config files..."

    for file in \
        CLAUDE.md \
        settings.local.json
    do
        import_agent_input copy_agent_file /claude-config "$HOME/.claude" "$file" Claude
    done

    # User-authored extensions. Routed through the shared helpers so a symlinked
    # entry cannot resolve into excluded runtime state, and so a destination link
    # planted by an earlier workload in a reused container is not written through.
    # These copy per-entry: a dotfiles manager symlinking one command file is
    # ordinary, and the rest of the directory must still land in the container.
    for dir in \
        commands \
        skills \
        agents \
        ide \
        plugins
    do
        import_agent_input copy_agent_directory_entries /claude-config "$HOME/.claude" "$dir" Claude
    done

    log_progress "  Config files copied"
    report_agent_copy_skips Claude
fi

# Create credentials.json from the host's Claude Code credential.
#
# On macOS that credential lives in the login Keychain, which no mount can
# expose, so the backend pipes it in over `docker exec` immediately after
# `docker start` (see syncContainerClaudeCredential in commands.ts). That sync
# races this block and normally wins before any agent runs, so "not found" here
# is not conclusive.
#
# This MUST happen AFTER copying host files so a real credential always beats
# whatever `/claude-config` happened to contain.
(
# Shared with backend credential publication. Keep cleanup, import and digest
# attribution in one transaction; descriptor closes even on an early failure.
flock -x 9
forget_unchanged_agent_login "$HOME/.claude" .credentials.json
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ] && [ "$CLAUDE_OAUTH_CREDENTIALS" != "{}" ]; then
    if publish_claude_credentials "" "$CLAUDE_OAUTH_CREDENTIALS"; then
        log_progress "Injected credentials from CLAUDE_OAUTH_CREDENTIALS"
    else
        echo "Failed to inject CLAUDE_OAUTH_CREDENTIALS" >&2
    fi
# Nothing orders this block against the backend's sync: it runs concurrently
# with the entrypoint, and the `/claude-config` copy above can take long enough
# for the sync to land first. The mounted copy is the weaker source — on macOS
# the backend prefers the Keychain, so a stale on-disk `.credentials.json` here
# would replace the fresh token with the expired one and reproduce the exact
# "Not logged in" symptom this whole path exists to fix. Whoever wrote a
# non-empty regular credential first wins, and the sync re-runs on every start
# anyway. A destination symlink is not a credential: treat it as absent.
# forget_unchanged_agent_login above leaves such a credential alone unless it is
# byte for byte what this script imported on an earlier boot.
elif [ -f "$HOME/.claude/.credentials.json" ] && [ ! -L "$HOME/.claude/.credentials.json" ] && [ -s "$HOME/.claude/.credentials.json" ]; then
    chmod 600 "$HOME/.claude/.credentials.json"
    echo "Credential already present (backend sync); leaving it in place"
else
    # Linux hosts keep the credential on disk, so the mount can carry it.
    mounted_credentials=/claude-config/.credentials.json
    if [ -f "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$mounted_credentials" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$mounted_credentials" ]; then
        mounted_credentials="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$mounted_credentials"
    fi
    if [ -f "$mounted_credentials" ] && [ ! -L "$mounted_credentials" ]; then
        if publish_claude_credentials "$mounted_credentials"; then
            remember_agent_login /claude-config "$HOME/.claude" .credentials.json true
            echo "Copied credentials from host"
        else
            echo "No credential on the mount; awaiting the backend credential sync"
        fi
    else
        echo "No credential on the mount; awaiting the backend credential sync"
    fi
fi

) 9> "$HOME/.claude/.credentials.json.orkestrator-lock"

# Ensure directories Claude Code needs to write to exist
mkdir -p "$HOME/.claude/debug"
mkdir -p "$HOME/.claude/cache"
mkdir -p "$HOME/.claude/todos"
mkdir -p "$HOME/.claude/projects"
mkdir -p "$HOME/.claude/chrome"

# Create cache directories for Claude CLI
mkdir -p "$HOME/.cache/claude-cli-nodejs"

# Set proper permissions on the .claude directory
chmod 700 "$HOME/.claude"

# Create settings.json with bypass permissions mode and activity hooks
# This is the primary settings file that Claude Code reads
# Hooks write state to /tmp/.claude-state for the host to read, then ring the
# backend (orkestrator-state-signal) so it reads on change instead of polling
# every second; the backend keeps a slow safety read for a missed signal
# - UserPromptSubmit: fires when user sends a prompt (better than PreToolUse which fires on startup)
# - Stop: fires when Claude finishes responding
# - StopFailure: fires instead of Stop when the turn ends on an API error
# These describe terminal Claude only. The native claude-bridge sets
# ORKESTRATOR_NATIVE_AGENT_BRIDGE for every CLI it spawns; those processes
# load these user settings too, and a zero-turn probe fires UserPromptSubmit
# without a matching Stop, so they must not write the state file.
# env section sets BASH_MAX_OUTPUT_LENGTH to increase output limit for code reviews
# skipDangerousModePermissionPrompt records the bypass-mode consent where
# current Claude Code reads it (2.1.309 ignores ~/.claude.json's legacy
# bypassPermissionsModeAccepted); without it terminal Claude stops at the
# consent dialog on every container start, because this file is rewritten.
cat > "$HOME/.claude/settings.json" << 'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "allow": [],
    "deny": [],
    "defaultMode": "bypassPermissions"
  },
  "env": {
    "BASH_MAX_OUTPUT_LENGTH": "200000"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "[ -n \"$ORKESTRATOR_NATIVE_AGENT_BRIDGE\" ] || { /usr/local/bin/orkestrator-state-signal working 2>/dev/null || true; }" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "[ -n \"$ORKESTRATOR_NATIVE_AGENT_BRIDGE\" ] || { /usr/local/bin/orkestrator-state-signal waiting 2>/dev/null || true; }" }]
      }
    ],
    "StopFailure": [
      {
        "hooks": [{ "type": "command", "command": "[ -n \"$ORKESTRATOR_NATIVE_AGENT_BRIDGE\" ] || { /usr/local/bin/orkestrator-state-signal failed 2>/dev/null || true; }" }]
      }
    ]
  }
}
EOF
chmod 600 "$HOME/.claude/settings.json"
log_progress "Created ~/.claude/settings.json with bypass permissions"

# Claude Code's plugin enablement from the host's user settings. The backend
# stages nothing else of that file (`claudeContainerPluginSettings`), and only
# boolean `enabledPlugins` entries are taken here. The Claude bridge passes an
# installed plugin only when these enable its `<name>@<marketplace>` id, and
# the CLI reads the same keys, so a plugin turned off in Claude Code on the
# host stays off in this container.
CLAUDE_SETTINGS_INPUT="$(staged_input_path /claude-config/settings.json)"
if [ -f "$CLAUDE_SETTINGS_INPUT" ] && [ ! -L "$CLAUDE_SETTINGS_INPUT" ]; then
    CLAUDE_SETTINGS_MERGED="$(mktemp)"
    if jq --slurpfile host "$CLAUDE_SETTINGS_INPUT" \
        '($host[0].enabledPlugins // null) as $plugins
         | if ($plugins | type) == "object"
           then .enabledPlugins = ($plugins | with_entries(select(.value | type == "boolean")))
           else . end' \
        "$HOME/.claude/settings.json" > "$CLAUDE_SETTINGS_MERGED" 2>/dev/null; then
        cat "$CLAUDE_SETTINGS_MERGED" > "$HOME/.claude/settings.json"
        log_progress "Copied Claude plugin enablement from host settings"
    else
        echo "Host Claude plugin enablement could not be read; installed plugins stay off" >&2
    fi
    rm -f "$CLAUDE_SETTINGS_MERGED"
fi

# Copy and filter ~/.claude.json if mounted
# The backend stages only an allowlist of the host file (claudeContainerConfig
# in apps/backend/src/core/claude-container-config.ts): the login's identity,
# onboarding flags and container-safe MCP servers. The same top-level allowlist
# is applied again here, so host project paths, history, caches and keys never
# reach the container's own copy even from an older staged revision. Keep
# CLAUDE_JSON_ALLOWED_KEYS in step with CLAUDE_CONTAINER_CONFIG_KEYS.
# Add bypass permissions settings for automated operation
#
# IMPORTANT: This uses a retry mechanism to handle race conditions where the host's
# ~/.claude.json may be modified by Claude CLI running on the host (e.g., during
# background environment naming). We write to a temp file first, validate it's
# valid JSON, then move it to the final location.
CLAUDE_JSON_ALLOWED_KEYS='["oauthAccount","hasCompletedOnboarding","hasAcknowledgedCostThreshold","hasSeenTasksHint","hasUsedBackslashReturn","hasIdeOnboardingBeenShown","bypassPermissionsModeAccepted","hasSeenAutoDefaultNudge","lastOnboardingVersion","lastReleaseNotesSeen","mcpServers"]'
CLAUDE_JSON_INPUT=/claude-config.json
if [ -f "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$CLAUDE_JSON_INPUT" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$CLAUDE_JSON_INPUT" ]; then
    CLAUDE_JSON_INPUT="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$CLAUDE_JSON_INPUT"
fi
# An emptied mount (revoked credentials) is treated as no host config.
if [ -f "$CLAUDE_JSON_INPUT" ] && [ -s "$CLAUDE_JSON_INPUT" ]; then
    if [ -n "$DEBUG" ]; then
        echo "=== Processing .claude.json ==="
        echo "Size: $(wc -c < "$CLAUDE_JSON_INPUT") bytes"
        echo "Key count: $(jq 'keys | length' "$CLAUDE_JSON_INPUT" 2>/dev/null || echo 'failed to parse')"
    fi

    # Use jq to:
    # 1. Keep only the allowlisted keys (drops projects, githubRepoPaths, keys)
    # 2. Add bypassPermissionsModeAccepted for --dangerously-skip-permissions,
    #    and hasSeenAutoDefaultNudge: this file is rebuilt on every start, so
    #    without it terminal Claude offers "Make auto mode your default
    #    permission mode?" in every new Claude CLI tab after each start
    # 3. Add hasCompletedOnboarding to skip first-run theme selection
    # 4. Add /workspace project settings with trust accepted
    #
    # We retry up to 3 times with validation to handle race conditions
    TEMP_CLAUDE_JSON="$HOME/.claude.json.tmp"
    CLAUDE_JSON_SUCCESS=false

    for attempt in 1 2 3; do
        # Important: Don't redirect stderr to stdout (2>&1) as it corrupts the JSON output
        if jq --argjson keep "$CLAUDE_JSON_ALLOWED_KEYS" \
              'if type == "object" then . else error("not an object") end |
              with_entries(select(.key as $k | any($keep[]; . == $k))) |
              .bypassPermissionsModeAccepted = true |
              .hasSeenAutoDefaultNudge = true |
              .hasCompletedOnboarding = true |
              .theme = "dark" |
              .projects = {"/workspace": {"hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true}}' \
              "$CLAUDE_JSON_INPUT" > "$TEMP_CLAUDE_JSON" 2>/dev/null; then

            # Validate the output is valid JSON before using it
            if jq empty "$TEMP_CLAUDE_JSON" 2>/dev/null; then
                mv "$TEMP_CLAUDE_JSON" "$HOME/.claude.json"
                chmod 600 "$HOME/.claude.json"
                CLAUDE_JSON_SUCCESS=true
                if [ -n "$DEBUG" ]; then
                    echo "Filtered .claude.json (kept: allowlisted keys; added: bypass permissions, workspace trust)"
                    echo "Output size: $(wc -c < "$HOME/.claude.json") bytes"
                    [ "$attempt" -gt 1 ] && echo "Succeeded on attempt $attempt"
                fi
                break
            else
                [ -n "$DEBUG" ] && echo "Attempt $attempt: jq output validation failed, retrying..."
            fi
        else
            [ -n "$DEBUG" ] && echo "Attempt $attempt: jq processing failed, retrying..."
        fi

        # Small delay before retry to allow host file writes to complete
        sleep 0.3
    done

    # Cleanup temp file if it exists
    rm -f "$TEMP_CLAUDE_JSON" 2>/dev/null

    # Fallback: create minimal config if all attempts failed
    if [ "$CLAUDE_JSON_SUCCESS" != "true" ]; then
        echo "Warning: Failed to process host .claude.json after 3 attempts, creating minimal config"
        cat > "$HOME/.claude.json" << 'FALLBACK_EOF'
{
  "bypassPermissionsModeAccepted": true,
  "hasSeenAutoDefaultNudge": true,
  "hasCompletedOnboarding": true,
  "theme": "dark",
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
FALLBACK_EOF
        chmod 600 "$HOME/.claude.json"
    fi
else
    # No host config - create minimal config with bypass permissions
    echo "Creating minimal .claude.json with bypass permissions..."
    cat > "$HOME/.claude.json" << 'EOF'
{
  "bypassPermissionsModeAccepted": true,
  "hasSeenAutoDefaultNudge": true,
  "hasCompletedOnboarding": true,
  "theme": "dark",
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
EOF
    chmod 600 "$HOME/.claude.json"
    if [ -n "$DEBUG" ]; then
        echo "Created minimal .claude.json"
    fi
fi

# Sync filesystem to ensure config is written before any process reads it
sync

log_progress "Claude Code configuration ready"

# Set up OpenCode configuration
# The host's ~/.config/opencode is mounted read-only at /opencode-config
# The host's ~/.local/share/opencode is mounted read-only at /opencode-data
# Only the host's ~/.local/state/opencode/model.json preference file is mounted
# read-only at /opencode-state/model.json.
log_progress "Setting up OpenCode configuration..."
mkdir -p "$HOME/.config/opencode"
mkdir -p "$HOME/.local/share/opencode"
mkdir -p "$HOME/.local/state/opencode"

if [ -d /opencode-config ]; then
    # The config directory is user-authored, so its entries are copied rather than
    # allowlisted — an allowlist would silently drop a plugin or config a user
    # added. node_modules is the one deliberate exclusion: OpenCode manages it
    # with bun to resolve plugin dependencies, so it routinely holds packages
    # built for the host platform. Mach-O binaries from a macOS host cannot run
    # in this Linux container, exactly as with Codex's plugins/.plugin-appserver.
    # OpenCode reinstalls what it needs for Linux on first use.
    import_agent_input copy_agent_directory_entries \
        /opencode-config "$HOME/.config/opencode" "." OpenCode node_modules
    report_agent_copy_skips OpenCode
    if [ -n "$DEBUG" ]; then
        echo "Copied OpenCode config files:"
        ls -la "$HOME/.config/opencode/"
    fi
fi

if [ -d /opencode-data ]; then
    # Only the login is portable. The host's opencode.db (its session database,
    # often several GB) is never copied; nor are snapshot/, storage/ or
    # account.json. OpenCode 1.19.4 kept console accounts and the selected
    # organization in SQLite (preserved via OPENCODE_DB), not account.json; the
    # live check that showed it left with 1.x
    # (`git show 5f4e27b1c:scripts/qualify-opencode-seeded-data.sh`).
    # Snapshots are keyed by the worktree path; of storage/ only the legacy
    # migration index is needed, and an empty storage/ recreates it. Copying
    # the host seed cost bytes on every start and offered nothing a container uses.
    forget_unchanged_agent_login "$HOME/.local/share/opencode" auth.json
    copy_agent_file /opencode-data "$HOME/.local/share/opencode" auth.json OpenCode
    login_published="$AGENT_FILE_PUBLISHED"

    chmod 600 "$HOME/.local/share/opencode/auth.json" 2>/dev/null || true
    restrict_imported_login "$HOME/.local/share/opencode/auth.json" opencode OpenCode /opencode-data auth.json
    remember_agent_login /opencode-data "$HOME/.local/share/opencode" auth.json "$login_published"
    report_agent_copy_skips OpenCode
    if [ -n "$DEBUG" ]; then
        echo "Copied OpenCode data files:"
        ls -la "$HOME/.local/share/opencode/"
    fi
fi

# Explicitly inject model.json if available
# Prompt history, frecency, locks, and arbitrary state are not portable inputs.
# model.json is the one preference file a fresh container needs.
import_agent_input copy_agent_file /opencode-state "$HOME/.local/state/opencode" "model.json" OpenCode
chmod 600 "$HOME/.local/state/opencode/model.json" 2>/dev/null || true
report_agent_copy_skips OpenCode

log_progress "OpenCode configuration ready"

# Set up Codex configuration
# The host's ~/.codex is mounted read-only at /codex-home
log_progress "Setting up Codex configuration..."
mkdir -p "$HOME/.codex"

# Invalidate before importing: a backend restart or a later boot failure must
# never leave a previous account marker certifying the newly imported login.
# Only idle bridge reconciliation can acknowledge the account actually copied.
(umask 077; printf '%s' unstaged > /tmp/orkestrator-codex-account)

if [ -d /codex-home ]; then
    # A Codex home contains far more than configuration. Session rollouts, logs,
    # worktrees, generated images and caches routinely grow to multiple GB. A
    # recursive copy made every container startup wait on all of that state and
    # could outlive workspace-setup.sh's initialization timeout. Copy only the
    # portable inputs a fresh Codex environment needs.
    forget_unchanged_agent_login "$HOME/.codex" auth.json
    copy_agent_file /codex-home "$HOME/.codex" auth.json Codex
    login_published="$AGENT_FILE_PUBLISHED"

    for file in \
        config.toml \
        AGENTS.md \
        hooks.json \
        models_cache.json \
        .codex-global-state.json \
        cloud-config-bundle-cache.json \
        cloud-requirements-cache.json
    do
        import_agent_input copy_agent_file /codex-home "$HOME/.codex" "$file" Codex
    done

    # Preserve user-authored extensions and the platform-neutral plugin cache.
    # Do not copy plugins/.plugin-appserver: it contains host-platform binaries
    # (Mach-O on macOS) that cannot run inside the Linux container.
    for dir in \
        rules \
        prompts \
        vendor_imports \
        plugins/cache
    do
        import_agent_input copy_agent_directory /codex-home "$HOME/.codex" "$dir" Codex
    done

    import_agent_input copy_agent_directory_entries /codex-home "$HOME/.codex" skills Codex

    chmod 600 "$HOME/.codex/auth.json" 2>/dev/null || true
    restrict_imported_login "$HOME/.codex/auth.json" codex Codex
    remember_agent_login /codex-home "$HOME/.codex" auth.json "$login_published"
    report_agent_copy_skips Codex
    if [ -n "$DEBUG" ]; then
        echo "Copied Codex files:"
        ls -la "$HOME/.codex/" | head -40
    fi
fi

log_progress "Codex configuration ready"

# Set up Grok configuration. Grok writes active_sessions.json, SQLite state and
# logs below ~/.grok as soon as ACP starts, so the host mount cannot live there.
log_progress "Setting up Grok configuration..."
mkdir -p "$HOME/.grok" "$HOME/.config/grok"

if [ -d /grok-home ]; then
    forget_unchanged_agent_login "$HOME/.grok" auth.json
    copy_agent_file /grok-home "$HOME/.grok" auth.json Grok
    login_published="$AGENT_FILE_PUBLISHED"

    for file in \
        xai-api-key \
        config.toml \
        trusted_folders.toml \
        agent_id \
        models_cache.json
    do
        import_agent_input copy_agent_file /grok-home "$HOME/.grok" "$file" Grok
    done

    for dir in \
        hooks \
        skills \
        commands
    do
        import_agent_input copy_agent_directory_entries /grok-home "$HOME/.grok" "$dir" Grok
    done

    chmod 600 "$HOME/.grok/xai-api-key" 2>/dev/null || true
    chmod 600 "$HOME/.grok/auth.json" 2>/dev/null || true
    restrict_imported_login "$HOME/.grok/auth.json" grok Grok
    remember_agent_login /grok-home "$HOME/.grok" auth.json "$login_published"
fi

if [ -d /grok-config ]; then
    # ~/.config/grok is user-authored and normally small. Copy each entry through
    # the bounded helper so an unexpected cache or symlink cannot escape the
    # same limits applied to the primary agent homes. The mount is copied whole,
    # so pass the agent-relative name explicitly: a skip reported as "." would
    # tell the user nothing about what their container is missing.
    import_agent_input copy_agent_directory /grok-config "$HOME/.config/grok" "." Grok ".config/grok"
fi

report_agent_copy_skips Grok
log_progress "Grok configuration ready"

# Set up Pi configuration. Pi keeps its credentials, model cache, settings and
# session transcripts all under ~/.pi/agent, and the bridge writes sessions
# there while it runs — so the host mount cannot live at that path either.
log_progress "Setting up Pi configuration..."
mkdir -p "$HOME/.pi/agent"

# Under rootless Docker node cannot traverse the /pi-config mount itself, so
# its relayed copy is checked too; the copy helpers read from that copy. The
# test is on the mount, not its `agent` directory: a revocation empties the
# mount, and what was imported from it still has to leave the home.
if [ -d /pi-config ] || [ -d "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}/pi-config" ]; then
    forget_unchanged_agent_login "$HOME/.pi/agent" auth.json
    copy_agent_file /pi-config/agent "$HOME/.pi/agent" auth.json Pi
    login_published="$AGENT_FILE_PUBLISHED"

    for file in \
        models.json \
        settings.json \
        mcp.json \
        SYSTEM.md \
        APPEND_SYSTEM.md
    do
        import_agent_input copy_agent_file /pi-config/agent "$HOME/.pi/agent" "$file" Pi
    done

    # User-authored resources only. Sessions are deliberately not imported: they
    # are the host's own conversation history, and a container that adopted them
    # would offer to resume work that never happened in this workspace.
    for dir in \
        skills \
        prompts \
        extensions \
        themes
    do
        import_agent_input copy_agent_directory_entries /pi-config/agent "$HOME/.pi/agent" "$dir" Pi
    done

    chmod 600 "$HOME/.pi/agent/auth.json" 2>/dev/null || true
    restrict_imported_login "$HOME/.pi/agent/auth.json" pi Pi /pi-config/agent auth.json
    remember_agent_login /pi-config/agent "$HOME/.pi/agent" auth.json "$login_published"
    # The bridge's MCP client reads user servers from here; definitions can
    # carry literal header or environment values, so keep it owner-only.
    if [ -f "$HOME/.pi/agent/mcp.json" ] && [ ! -L "$HOME/.pi/agent/mcp.json" ]; then
        chmod 600 "$HOME/.pi/agent/mcp.json" 2>/dev/null || true
    fi
fi

report_agent_copy_skips Pi
log_progress "Pi configuration ready"

# Set up Cursor configuration. Only the user's MCP servers (~/.cursor/mcp.json,
# Cursor's user setting source) are imported; the bridge reads them from here.
# Cursor's account, IDE state, hooks, plugins and SDK state stay on the host,
# and its login arrives through the backend's key sync instead.
log_progress "Setting up Cursor configuration..."
mkdir -p "$HOME/.cursor"

if [ -d /cursor-config ]; then
    import_agent_input copy_agent_file /cursor-config "$HOME/.cursor" mcp.json Cursor
    # Definitions can carry literal header or environment values, so keep the
    # copy owner-only.
    if [ -f "$HOME/.cursor/mcp.json" ] && [ ! -L "$HOME/.cursor/mcp.json" ]; then
        chmod 600 "$HOME/.cursor/mcp.json" 2>/dev/null || true
    fi
fi

report_agent_copy_skips Cursor
log_progress "Cursor configuration ready"

# Shared user skills (~/.agents/skills), which Codex, Cursor, Grok, OpenCode and
# Pi all read (staged-inputs=4). The backend stages the mount only when one of
# them is enabled, one unit per skill; a skill the host linked in from another
# skill root arrives as a real directory. Each entry copies on its own, so a
# link or oversized skill is skipped without dropping the rest.
if [ -d /agents-skills ] || [ -d "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}/agents-skills" ]; then
    log_progress "Setting up shared skills..."
    mkdir -p "$HOME/.agents/skills"
    import_agent_input copy_agent_directory_entries /agents-skills "$HOME/.agents/skills" "." "Shared skills"
    report_agent_copy_skips "Shared skills"
    log_progress "Shared skills ready"
fi

# Counts only: input names are the user's and stay out of the logs.
log_progress "Agent inputs: ${AGENT_INPUTS_UNCHANGED:-0} unchanged, ${AGENT_INPUTS_COPIED:-0} copied"

# Verify the config file exists and is valid
if [ -f "$HOME/.claude.json" ]; then
    if jq -e '.hasCompletedOnboarding' "$HOME/.claude.json" > /dev/null 2>&1; then
        echo "  ~/.claude.json verified: hasCompletedOnboarding=true"
    else
        echo "  WARNING: ~/.claude.json missing hasCompletedOnboarding"
    fi
else
    echo "  WARNING: ~/.claude.json not found!"
fi

# Set up git configuration from host if mounted
GITCONFIG_INPUT=/tmp/gitconfig
if [ -f "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$GITCONFIG_INPUT" ] && [ ! -L "${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$GITCONFIG_INPUT" ]; then
    GITCONFIG_INPUT="${STAGED_INPUT_RELAY_DIR:-/run/orkestrator-inputs}$GITCONFIG_INPUT"
fi
if [ -f "$GITCONFIG_INPUT" ]; then
    log_progress "Setting up Git configuration from host..."
    cp "$GITCONFIG_INPUT" "$HOME/.gitconfig"
    # Host git credential helpers often contain absolute macOS paths such as
    # /opt/homebrew/bin/gh. Those helpers do not exist inside Linux containers
    # and cause git clone to prompt for credentials. Keep identity/remotes from
    # the host config, but reset helper lookup inside the container.
    git config --global --replace-all credential.helper "" 2>/dev/null || true
    log_progress "Git config copied from host"
else
    # Configure Git user with fallback values if not set
    if [ -z "$(git config --global user.email 2>/dev/null)" ]; then
        git config --global user.email "orkestrator-ai@local"
        git config --global user.name "Orkestrator AI"
        echo "Using default git config"
    fi
fi

# Print environment info
echo ""
echo "=== Environment Info ==="
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"
echo "Git: $(git --version)"
echo "gh: $(gh --version 2>/dev/null | head -1)"
echo "Claude Code: $(claude --version 2>/dev/null || echo 'installed')"
echo "OpenCode: $(opencode --version 2>/dev/null || echo 'installed')"
echo ""

write_boot_status inputs-ready

# Legacy markers for older backends. Current readers use the boot status.
touch /tmp/.environment-ready
touch /tmp/.entrypoint-complete

log_progress "=== Container Ready ==="
log_progress "Waiting for terminal connection..."
echo ""

# The keepalive is recorded so a drain signals every workload process but not
# the process holding the container open (`exec` keeps this PID).
echo "$$" > "$BOOT_STATUS_DIR/keepalive.pid"
write_boot_status ready
trap - EXIT

# Keep container alive - workspace setup happens when terminal connects via docker exec
# This ensures the user sees the clone and setup output in their terminal
exec sleep infinity
