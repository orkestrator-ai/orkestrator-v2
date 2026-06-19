#!/bin/bash
# Entrypoint script for Claude Code environments
# Handles minimal setup, then starts shell where workspace-setup.sh runs visibly

set -e

# Progress file for workspace-setup.sh to read
PROGRESS_FILE="/tmp/.entrypoint-progress"
echo "" > "$PROGRESS_FILE"

# Function to log progress both to stdout and progress file
log_progress() {
    echo "$1"
    echo "$1" >> "$PROGRESS_FILE"
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
    if ! cp -r /codex-home/. "$HOME/.codex/" 2>&1; then
        echo "Warning: Some Codex files could not be copied from /codex-home"
    fi
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
