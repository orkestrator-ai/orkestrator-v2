#!/bin/bash
# Entrypoint script for Claude Code environments
# Handles minimal setup, then starts shell where workspace-setup.sh runs visibly

set -e

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

copy_agent_file() {
    local source_root="$1"
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
    fi
}

copy_agent_directory() {
    local source_root="$1"
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
    local entry_scan
    local entry_marks
    local entry_count
    local entry_scan_limit
    local entry_scan_status
    local find_status
    local head_status
    local directory_kib
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
    # Read at most max_entries + 1 one-byte marks. head closes the pipe at that
    # point, so find stops walking a pathological tree instead of scanning and
    # buffering it in full. PIPESTATUS is appended after a newline because the
    # marks themselves never contain one. A producer failure is expected once
    # the cap is exceeded, but otherwise still fails closed.
    entry_scan_limit=$((max_entries + 1))
    entry_scan="$(
        set +e
        find -P "$source_path" -mindepth 1 -exec printf '%.0s.' {} + 2>/dev/null |
            head -c "$entry_scan_limit"
        entry_pipeline_status=("${PIPESTATUS[@]}")
        printf '\n%s:%s' "${entry_pipeline_status[0]}" "${entry_pipeline_status[1]}"
    )"
    entry_scan_status="${entry_scan##*$'\n'}"
    entry_marks="${entry_scan%$'\n'*}"
    find_status="${entry_scan_status%%:*}"
    head_status="${entry_scan_status#*:}"
    case "$head_status" in
        0) ;;
        *)
            agent_copy_warn "$display_path" "Failed to inspect $label directory"
            return 0
            ;;
    esac
    entry_count="${#entry_marks}"
    if [ "$entry_count" -gt "$max_entries" ]; then
        agent_copy_warn "$display_path" "Skipping oversized $label directory"
        return 0
    fi
    if [ "$find_status" -ne 0 ]; then
        agent_copy_warn "$display_path" "Failed to inspect $label directory"
        return 0
    fi
    found_symlink="$(find -P "$source_path" -type l -exec printf x \; -quit 2>/dev/null)" || {
        agent_copy_warn "$display_path" "Failed to inspect $label directory"
        return 0
    }
    if [ -n "$found_symlink" ]; then
        agent_copy_warn "$display_path" "Skipping $label directory containing symlink"
        return 0
    fi
    # Same reason as above: a partial du failure still prints an undercounted
    # total, so du's status has to be read before the total is parsed.
    directory_kib="$(du -sk "$source_path" 2>/dev/null)" || {
        agent_copy_warn "$display_path" "Failed to inspect $label directory"
        return 0
    }
    directory_kib="${directory_kib%%[!0-9]*}"
    case "$directory_kib" in
        ''|*[!0-9]*)
            agent_copy_warn "$display_path" "Failed to inspect $label directory"
            return 0
            ;;
    esac
    if [ "$directory_kib" -gt "$max_kib" ]; then
        agent_copy_warn "$display_path" "Skipping oversized $label directory"
        return 0
    fi

    if [ -e "$destination_path" ] && [ ! -d "$destination_path" ]; then
        agent_copy_warn "$display_path" "Failed to copy $label directory" "(destination is not a directory)"
        return 0
    fi
    if ! mkdir -p "$destination_path" 2>/dev/null; then
        agent_copy_warn "$display_path" "Failed to create destination for $label directory"
        return 0
    fi
    if agent_destination_path_has_symlink "$destination_root" "$relative_path"; then
        agent_copy_warn "$display_path" "Skipping $label directory with symlinked destination"
        return 0
    fi
    found_symlink="$(find -P "$destination_path" -type l -exec printf x \; -quit 2>/dev/null)" || {
        agent_copy_warn "$display_path" "Failed to inspect $label directory destination"
        return 0
    }
    if [ -n "$found_symlink" ]; then
        agent_copy_warn "$display_path" "Skipping $label directory containing destination symlink"
        return 0
    fi
    if ! cp -R "$source_path/." "$destination_path/" 2>/dev/null; then
        agent_copy_warn "$display_path" "Failed to copy $label directory"
    fi
}

# User-authored extension directories (Claude's commands/agents/ide/plugins,
# OpenCode's storage/snapshot) copy per-entry rather than all-or-nothing.
# A dotfiles manager symlinking one file into ~/.claude/commands is ordinary;
# the strict directory helper above would reject the whole directory over that
# single link and silently drop every custom command. This walker copies each
# regular file and subdirectory independently through the bounded helpers, so
# one symlinked or oversized entry is skipped on its own and the rest still
# lands. The directory itself must still not be a link, and the destination
# must stay link-free, exactly as with copy_agent_directory.
copy_agent_directory_entries() {
    local source_root="$1"
    local destination_root="$2"
    local relative_path="$3"
    # Display name of the calling agent, used only in warnings.
    local label="${4:-Agent}"
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

log_progress "=== Claude Code Environment Initializing ==="

# Initialize firewall if running with NET_ADMIN capability
# Use sudo -E to preserve environment variables (NETWORK_MODE, ALLOWED_DOMAINS)
if [ -x /usr/local/bin/init-firewall.sh ]; then
    log_progress "Initializing network firewall..."
    sudo -E /usr/local/bin/init-firewall.sh || log_progress "Warning: Firewall initialization failed (may need NET_ADMIN capability)"
fi

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
    # the container's own bypass-permissions settings, so copying it was work
    # that was immediately discarded. .credentials.json is handled by the
    # dedicated credential block that follows, which also chmods it.
    log_progress "  Copying essential config files..."

    for file in \
        CLAUDE.md \
        settings.local.json
    do
        copy_agent_file /claude-config "$HOME/.claude" "$file" Claude
    done

    # User-authored extensions. Routed through the shared helpers so a symlinked
    # entry cannot resolve into excluded runtime state, and so a destination link
    # planted by an earlier workload in a reused container is not written through.
    # These copy per-entry: a dotfiles manager symlinking one command file is
    # ordinary, and the rest of the directory must still land in the container.
    for dir in \
        commands \
        agents \
        ide \
        plugins
    do
        copy_agent_directory_entries /claude-config "$HOME/.claude" "$dir" Claude
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
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ] && [ "$CLAUDE_OAUTH_CREDENTIALS" != "{}" ]; then
    echo "$CLAUDE_OAUTH_CREDENTIALS" > "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
    log_progress "Injected credentials from CLAUDE_OAUTH_CREDENTIALS"
# Nothing orders this block against the backend's sync: it runs concurrently
# with the entrypoint, and the `/claude-config` copy above can take long enough
# for the sync to land first. The mounted copy is the weaker source — on macOS
# the backend prefers the Keychain, so a stale on-disk `.credentials.json` here
# would replace the fresh token with the expired one and reproduce the exact
# "Not logged in" symptom this whole path exists to fix. Whoever wrote a
# non-empty credential first wins, and the sync re-runs on every start anyway.
elif [ -s "$HOME/.claude/.credentials.json" ]; then
    chmod 600 "$HOME/.claude/.credentials.json"
    echo "Credential already present (backend sync); leaving it in place"
else
    # Linux hosts keep the credential on disk, so the mount can carry it.
    if [ -f /claude-config/.credentials.json ]; then
        cp /claude-config/.credentials.json "$HOME/.claude/"
        chmod 600 "$HOME/.claude/.credentials.json"
        echo "Copied credentials from host"
    else
        echo "No credential on the mount; awaiting the backend credential sync"
    fi
fi

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
# Hooks write state to /tmp/.claude-state for the host to poll
# - UserPromptSubmit: fires when user sends a prompt (better than PreToolUse which fires on startup)
# - Stop: fires when Claude finishes responding
# env section sets BASH_MAX_OUTPUT_LENGTH to increase output limit for code reviews
cat > "$HOME/.claude/settings.json" << 'EOF'
{
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
        "hooks": [{ "type": "command", "command": "echo working > /tmp/.claude-state" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "echo waiting > /tmp/.claude-state" }]
      }
    ]
  }
}
EOF
chmod 600 "$HOME/.claude/settings.json"
log_progress "Created ~/.claude/settings.json with bypass permissions"

# Copy and filter ~/.claude.json if mounted
# Remove githubRepoPaths and projects as they contain host-specific paths
# Add bypass permissions settings for automated operation
#
# IMPORTANT: This uses a retry mechanism to handle race conditions where the host's
# ~/.claude.json may be modified by Claude CLI running on the host (e.g., during
# background environment naming). We write to a temp file first, validate it's
# valid JSON, then move it to the final location.
if [ -f /claude-config.json ]; then
    if [ -n "$DEBUG" ]; then
        echo "=== Processing .claude.json ==="
        echo "Size: $(wc -c < /claude-config.json) bytes"
        echo "Key count: $(jq 'keys | length' /claude-config.json 2>/dev/null || echo 'failed to parse')"
    fi

    # Use jq to:
    # 1. Remove host-specific attributes (githubRepoPaths, projects)
    # 2. Add bypassPermissionsModeAccepted for --dangerously-skip-permissions
    # 3. Add hasCompletedOnboarding to skip first-run theme selection
    # 4. Add /workspace project settings with trust accepted
    #
    # We retry up to 3 times with validation to handle race conditions
    TEMP_CLAUDE_JSON="$HOME/.claude.json.tmp"
    CLAUDE_JSON_SUCCESS=false

    for attempt in 1 2 3; do
        # Important: Don't redirect stderr to stdout (2>&1) as it corrupts the JSON output
        if jq 'del(.githubRepoPaths, .projects) |
              .bypassPermissionsModeAccepted = true |
              .hasCompletedOnboarding = true |
              .theme = "dark" |
              .projects = {"/workspace": {"hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true}}' \
              /claude-config.json > "$TEMP_CLAUDE_JSON" 2>/dev/null; then

            # Validate the output is valid JSON before using it
            if jq empty "$TEMP_CLAUDE_JSON" 2>/dev/null; then
                mv "$TEMP_CLAUDE_JSON" "$HOME/.claude.json"
                chmod 600 "$HOME/.claude.json"
                CLAUDE_JSON_SUCCESS=true
                if [ -n "$DEBUG" ]; then
                    echo "Filtered .claude.json (removed: githubRepoPaths, old projects; added: bypass permissions, workspace trust)"
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
# The host's ~/.local/state/opencode is mounted read-only at /opencode-state
# The host's ~/.local/state/opencode/model.json is mounted read-only at /opencode-model.json
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
    # find reports a non-zero status when any -exec fails, and `set -e` is active,
    # so the guard is required. Individual cp errors stay on stderr rather than
    # being discarded — a partially copied config is worth being able to debug.
    find /opencode-config -maxdepth 1 -mindepth 1 ! -name node_modules \
        -exec cp -R {} "$HOME/.config/opencode/" \; ||
        echo "Warning: Some config files could not be copied from /opencode-config"
    if [ -n "$DEBUG" ]; then
        echo "Copied OpenCode config files:"
        ls -la "$HOME/.config/opencode/"
    fi
fi

if [ -d /opencode-data ]; then
    # This directory is dominated by opencode.db — the host's session database,
    # which reaches multiple GB and is not portable state a fresh container needs.
    # The previous `find -maxdepth 1 -type f` copied every top-level file, so that
    # database (and its -wal/-shm siblings) was copied on every single start.
    # Allowlist the portable inputs instead, and route them through the shared
    # copy helpers so OpenCode gets the same symlink, size and entry-count
    # bounds. The data directories copy per-entry so a symlinked or oversized
    # record in one cannot drop the whole storage tree.
    for file in \
        auth.json \
        account.json
    do
        copy_agent_file /opencode-data "$HOME/.local/share/opencode" "$file" OpenCode
    done

    for dir in \
        storage \
        snapshot
    do
        copy_agent_directory_entries /opencode-data "$HOME/.local/share/opencode" "$dir" OpenCode
    done

    chmod 600 "$HOME/.local/share/opencode/auth.json" 2>/dev/null || true
    report_agent_copy_skips OpenCode
    if [ -n "$DEBUG" ]; then
        echo "Copied OpenCode data files:"
        ls -la "$HOME/.local/share/opencode/"
    fi
fi

if [ -d /opencode-state ]; then
    if ! cp -r /opencode-state/. "$HOME/.local/state/opencode/" 2>&1; then
        echo "Warning: Some state files could not be copied from /opencode-state"
    fi
    if [ -n "$DEBUG" ]; then
        echo "Copied OpenCode state files:"
        ls -la "$HOME/.local/state/opencode/"
    fi
fi

# Explicitly inject model.json if available
# This ensures model selection is present even if the broader state copy is partial
if [ -f /opencode-model.json ]; then
    if ! cp /opencode-model.json "$HOME/.local/state/opencode/model.json" 2>/dev/null; then
        echo "Warning: Failed to copy OpenCode model.json from /opencode-model.json"
    else
        chmod 600 "$HOME/.local/state/opencode/model.json" 2>/dev/null || true
        if [ -n "$DEBUG" ]; then
            echo "Injected OpenCode model.json"
        fi
    fi
fi

log_progress "OpenCode configuration ready"

# Set up Codex configuration
# The host's ~/.codex is mounted read-only at /codex-home
log_progress "Setting up Codex configuration..."
mkdir -p "$HOME/.codex"

if [ -d /codex-home ]; then
    # A Codex home contains far more than configuration. Session rollouts, logs,
    # worktrees, generated images and caches routinely grow to multiple GB. A
    # recursive copy made every container startup wait on all of that state and
    # could outlive workspace-setup.sh's initialization timeout. Copy only the
    # portable inputs a fresh Codex environment needs.
    for file in \
        auth.json \
        config.toml \
        AGENTS.md \
        hooks.json \
        models_cache.json \
        .codex-global-state.json \
        cloud-config-bundle-cache.json \
        cloud-requirements-cache.json
    do
        copy_agent_file /codex-home "$HOME/.codex" "$file" Codex
    done

    # Preserve user-authored extensions and the platform-neutral plugin cache.
    # Do not copy plugins/.plugin-appserver: it contains host-platform binaries
    # (Mach-O on macOS) that cannot run inside the Linux container.
    for dir in \
        rules \
        skills \
        prompts \
        vendor_imports \
        plugins/cache
    do
        copy_agent_directory /codex-home "$HOME/.codex" "$dir" Codex
    done

    chmod 600 "$HOME/.codex/auth.json" 2>/dev/null || true
    report_agent_copy_skips Codex
    if [ -n "$DEBUG" ]; then
        echo "Copied Codex files:"
        ls -la "$HOME/.codex/" | head -40
    fi
fi

log_progress "Codex configuration ready"

# Set up Cursor Agent configuration. The host directory is mounted read-only at
# /cursor-config, while ~/.cursor stays writable for ACP sessions and per-project
# runtime state.
log_progress "Setting up Cursor Agent configuration..."
mkdir -p "$HOME/.cursor"

if [ -d /cursor-config ]; then
    for file in \
        cli-config.json \
        agent-cli-state.json \
        mcp.json \
        argv.json
    do
        copy_agent_file /cursor-config "$HOME/.cursor" "$file" Cursor
    done

    # Preserve user-authored extensions without importing host sessions,
    # project state, caches, downloads, or platform-specific binaries.
    for dir in \
        skills-cursor
    do
        copy_agent_directory_entries /cursor-config "$HOME/.cursor" "$dir" Cursor
    done

    report_agent_copy_skips Cursor
fi

log_progress "Cursor Agent configuration ready"

# Set up Grok configuration. Grok writes active_sessions.json, SQLite state and
# logs below ~/.grok as soon as ACP starts, so the host mount cannot live there.
log_progress "Setting up Grok configuration..."
mkdir -p "$HOME/.grok" "$HOME/.config/grok"

if [ -d /grok-home ]; then
    for file in \
        auth.json \
        config.toml \
        trusted_folders.toml \
        agent_id
    do
        copy_agent_file /grok-home "$HOME/.grok" "$file" Grok
    done

    for dir in \
        hooks \
        skills
    do
        copy_agent_directory_entries /grok-home "$HOME/.grok" "$dir" Grok
    done

    chmod 600 "$HOME/.grok/auth.json" 2>/dev/null || true
fi

if [ -d /grok-config ]; then
    # ~/.config/grok is user-authored and normally small. Copy each entry through
    # the bounded helper so an unexpected cache or symlink cannot escape the
    # same limits applied to the primary agent homes. The mount is copied whole,
    # so pass the agent-relative name explicitly: a skip reported as "." would
    # tell the user nothing about what their container is missing.
    copy_agent_directory /grok-config "$HOME/.config/grok" "." Grok ".config/grok"
fi

report_agent_copy_skips Grok
log_progress "Grok configuration ready"

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
if [ -f "/tmp/gitconfig" ]; then
    log_progress "Setting up Git configuration from host..."
    cp /tmp/gitconfig "$HOME/.gitconfig"
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

# Write a ready marker file that can be checked by the frontend
touch /tmp/.environment-ready

# Write a ready marker that workspace-setup.sh can check
touch /tmp/.entrypoint-complete

log_progress "=== Container Ready ==="
log_progress "Waiting for terminal connection..."
echo ""

# Keep container alive - workspace setup happens when terminal connects via docker exec
# This ensures the user sees the clone and setup output in their terminal
exec sleep infinity
