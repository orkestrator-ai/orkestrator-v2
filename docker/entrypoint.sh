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

# Allowlist entries can be nested ("plugins/cache"), so testing only the final
# component leaves every parent free to be a link: a symlinked "plugins" holding
# a real "cache" passed that test and let find/cp resolve straight into excluded
# runtime state. Walk every component below the source root instead, and treat
# ".." as unsafe so a future allowlist entry cannot escape the root either.
codex_path_has_symlink() {
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

copy_codex_file() {
    local source_root="$1"
    local destination_root="$2"
    local relative_path="$3"
    local source_path="$source_root/$relative_path"
    local destination_path="$destination_root/$relative_path"
    local max_bytes="${CODEX_COPY_MAX_FILE_BYTES:-10485760}"
    local file_bytes

    # An allowlisted name must be a real file in the mounted Codex home. Following
    # a link anywhere along the path could turn an allowlisted name into an
    # arbitrary rollout, log, credential, or other host file.
    if codex_path_has_symlink "$source_root" "$relative_path"; then
        log_progress "Warning: Skipping symlinked Codex file: $relative_path"
        return 0
    fi

    if [ ! -f "$source_path" ]; then
        return 0
    fi

    case "$max_bytes" in
        ''|*[!0-9]*)
            max_bytes=10485760
            ;;
    esac
    file_bytes="$(wc -c < "$source_path" 2>/dev/null)" || {
        log_progress "Warning: Failed to inspect Codex file: $relative_path"
        return 0
    }
    # BSD wc pads its count with leading spaces; GNU wc does not.
    file_bytes="${file_bytes##*[[:space:]]}"
    if [ "$file_bytes" -gt "$max_bytes" ]; then
        log_progress "Warning: Skipping oversized Codex file: $relative_path"
        return 0
    fi

    if [ -d "$destination_path" ]; then
        log_progress "Warning: Failed to copy Codex file: $relative_path (destination is a directory)"
        return 0
    fi
    if ! mkdir -p "$(dirname "$destination_path")" 2>/dev/null; then
        log_progress "Warning: Failed to create destination for Codex file: $relative_path"
        return 0
    fi
    if ! cp "$source_path" "$destination_path" 2>/dev/null; then
        log_progress "Warning: Failed to copy Codex file: $relative_path"
    fi
}

copy_codex_directory() {
    local source_root="$1"
    local destination_root="$2"
    local relative_path="$3"
    local source_path="$source_root/$relative_path"
    local destination_path="$destination_root/$relative_path"
    local max_entries="${CODEX_COPY_MAX_DIRECTORY_ENTRIES:-5000}"
    local max_kib="${CODEX_COPY_MAX_DIRECTORY_KIB:-262144}"
    local entry_marks
    local entry_count
    local directory_kib
    local nested_symlinks

    # Do not dereference an allowlist link, at any depth. In particular, a host
    # can otherwise make "skills" or the "plugins" parent of "plugins/cache"
    # point at excluded runtime state.
    if codex_path_has_symlink "$source_root" "$relative_path"; then
        log_progress "Warning: Skipping symlinked Codex directory: $relative_path"
        return 0
    fi

    if [ ! -d "$source_path" ]; then
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
    # One mark per entry rather than one line per entry: a filename containing a
    # newline would otherwise inflate the count and skip a legitimate directory.
    # Capturing find directly (not through a pipe) also keeps find's own exit
    # status, so a partially unreadable tree fails closed instead of being
    # measured from a truncated listing.
    entry_marks="$(find -P "$source_path" -exec printf '%.0s.' {} + 2>/dev/null)" || {
        log_progress "Warning: Failed to inspect Codex directory: $relative_path"
        return 0
    }
    entry_count="${#entry_marks}"
    # The first find result is the source directory itself.
    if [ "$entry_count" -gt 0 ]; then
        entry_count=$((entry_count - 1))
    fi
    if [ "$entry_count" -gt "$max_entries" ]; then
        log_progress "Warning: Skipping oversized Codex directory: $relative_path"
        return 0
    fi
    nested_symlinks="$(find -P "$source_path" -type l -print 2>/dev/null)" || {
        log_progress "Warning: Failed to inspect Codex directory: $relative_path"
        return 0
    }
    if [ -n "$nested_symlinks" ]; then
        log_progress "Warning: Skipping Codex directory containing symlink: $relative_path"
        return 0
    fi
    # Same reason as above: a partial du failure still prints an undercounted
    # total, so du's status has to be read before the total is parsed.
    directory_kib="$(du -sk "$source_path" 2>/dev/null)" || {
        log_progress "Warning: Failed to inspect Codex directory: $relative_path"
        return 0
    }
    directory_kib="${directory_kib%%[!0-9]*}"
    case "$directory_kib" in
        ''|*[!0-9]*)
            log_progress "Warning: Failed to inspect Codex directory: $relative_path"
            return 0
            ;;
    esac
    if [ "$directory_kib" -gt "$max_kib" ]; then
        log_progress "Warning: Skipping oversized Codex directory: $relative_path"
        return 0
    fi

    if [ -e "$destination_path" ] && [ ! -d "$destination_path" ]; then
        log_progress "Warning: Failed to copy Codex directory: $relative_path (destination is not a directory)"
        return 0
    fi
    if ! mkdir -p "$destination_path" 2>/dev/null; then
        log_progress "Warning: Failed to create destination for Codex directory: $relative_path"
        return 0
    fi
    if ! cp -R "$source_path/." "$destination_path/" 2>/dev/null; then
        log_progress "Warning: Failed to copy Codex directory: $relative_path"
    fi
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
    # Selectively copy only essential config files, skipping large data directories
    # This avoids copying hundreds of MB of debug logs, projects, shell-snapshots, etc.
    log_progress "  Copying essential config files..."

    # Copy top-level files (settings, CLAUDE.md, etc.)
    find /claude-config -maxdepth 1 -type f -exec cp {} "$HOME/.claude/" \; 2>/dev/null || true

    # Copy specific directories that are needed
    for dir in commands agents ide plugins; do
        if [ -d "/claude-config/$dir" ]; then
            cp -r "/claude-config/$dir" "$HOME/.claude/" 2>/dev/null || true
        fi
    done

    log_progress "  Config files copied"
fi

# Create credentials.json from OAuth token environment variable
# This is how we pass macOS Keychain credentials to Linux containers
# This MUST happen AFTER copying host files to ensure keychain creds take priority
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ] && [ "$CLAUDE_OAUTH_CREDENTIALS" != "{}" ]; then
    echo "$CLAUDE_OAUTH_CREDENTIALS" > "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
    log_progress "Injected credentials from macOS Keychain"
else
    # Fallback: copy credentials from host if they exist and no keychain creds
    if [ -f /claude-config/.credentials.json ]; then
        cp /claude-config/.credentials.json "$HOME/.claude/"
        chmod 600 "$HOME/.claude/.credentials.json"
        echo "Copied credentials from host (no keychain creds available)"
    else
        echo "WARNING: No credentials available - you may need to run 'claude login'"
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
    if ! cp -r /opencode-config/. "$HOME/.config/opencode/" 2>&1; then
        echo "Warning: Some config files could not be copied from /opencode-config"
    fi
    if [ -n "$DEBUG" ]; then
        echo "Copied OpenCode config files:"
        ls -la "$HOME/.config/opencode/"
    fi
fi

if [ -d /opencode-data ]; then
    # Selectively copy only essential files, skipping large directories like bin/, log/, project/
    # Copy top-level files (auth.json, etc.)
    find /opencode-data -maxdepth 1 -type f -exec cp {} "$HOME/.local/share/opencode/" \; 2>/dev/null || true

    # Copy specific directories that might be needed (storage, snapshot)
    for dir in storage snapshot; do
        if [ -d "/opencode-data/$dir" ]; then
            cp -r "/opencode-data/$dir" "$HOME/.local/share/opencode/" 2>/dev/null || true
        fi
    done

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
        copy_codex_file /codex-home "$HOME/.codex" "$file"
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
        copy_codex_directory /codex-home "$HOME/.codex" "$dir"
    done

    chmod 600 "$HOME/.codex/auth.json" 2>/dev/null || true
    if [ -n "$DEBUG" ]; then
        echo "Copied Codex files:"
        ls -la "$HOME/.codex/" | head -40
    fi
fi

log_progress "Codex configuration ready"

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
