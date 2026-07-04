#!/bin/bash
# Workspace setup script - runs in the terminal so user can see progress
# This script handles: repo cloning, .env files, orkestrator-ai.json setup

set -e

# Color output helpers - use $'...' syntax for proper escape sequence handling
GREEN=$'\033[0;32m'
BLUE=$'\033[0;34m'
YELLOW=$'\033[1;33m'
RED=$'\033[0;31m'
NC=$'\033[0m' # No Color

# Load shared git branch helpers when available.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "/usr/local/bin/git-branch-helpers.sh" ]; then
    # shellcheck source=/dev/null
    . "/usr/local/bin/git-branch-helpers.sh"
elif [ -f "$SCRIPT_DIR/git-branch-helpers.sh" ]; then
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/git-branch-helpers.sh"
fi

if ! declare -F create_branch_from_preferred_bases >/dev/null; then
    create_branch_from_preferred_bases() {
        local branch="$1"
        local configured_base="$2"
        local remote_default="$3"
        local candidate=""
        local tried_branches=""

        for candidate in "$configured_base" "$remote_default" "main" "master"; do
            if [ -z "$candidate" ]; then
                continue
            fi

            if [[ " $tried_branches " == *" $candidate "* ]]; then
                continue
            fi

            tried_branches="$tried_branches $candidate"

            if git checkout -b "$branch" "origin/$candidate" >/dev/null 2>&1; then
                printf "%s" "$candidate"
                return 0
            fi
        done

        return 1
    }
fi

# Load runtime PATH helpers. These source a post-setup PATH snapshot when one
# exists and add common per-user tool install directories as a fallback.
if [ -f "/usr/local/bin/orkestrator-runtime-env.sh" ]; then
    # shellcheck source=/dev/null
    . "/usr/local/bin/orkestrator-runtime-env.sh"
    orkestrator_source_runtime_env 2>/dev/null || true
fi

capture_runtime_env_snapshot() {
    if [ ! -f "/usr/local/bin/orkestrator-runtime-env.sh" ]; then
        return 0
    fi

    # Native agent servers run as the node user. Root terminals should not
    # overwrite the node user's captured setup environment.
    if [ "$(whoami)" != "node" ]; then
        return 0
    fi

    mkdir -p /tmp/orkestrator-ai
    if /bin/zsh -lic 'source /usr/local/bin/orkestrator-runtime-env.sh; orkestrator_source_runtime_env 2>/dev/null || true; orkestrator_capture_runtime_env' > /tmp/orkestrator-ai/runtime-env-capture.log 2>&1; then
        echo -e "${GREEN}Runtime environment captured for agent sessions.${NC}"
    else
        echo -e "${YELLOW}Warning: Failed to capture runtime environment for agent sessions${NC}"
        cat /tmp/orkestrator-ai/runtime-env-capture.log 2>/dev/null || true
    fi
}

# Wait for entrypoint to complete (config files to be set up)
# This prevents race conditions where Claude is launched before config is ready
WAIT_COUNT=0
PROGRESS_FILE="/tmp/.entrypoint-progress"
LAST_LINE_COUNT=0

# Show what the entrypoint is doing in real-time
echo -e "${BLUE}=== Container Initialization ===${NC}"
echo ""

while [ ! -f /tmp/.entrypoint-complete ] && [ $WAIT_COUNT -lt 100 ]; do
    # Check for new progress lines and display them
    if [ -f "$PROGRESS_FILE" ]; then
        CURRENT_LINE_COUNT=$(wc -l < "$PROGRESS_FILE" 2>/dev/null || echo "0")
        if [ "$CURRENT_LINE_COUNT" -gt "$LAST_LINE_COUNT" ]; then
            # Show new lines (skip empty lines)
            tail -n +$((LAST_LINE_COUNT + 1)) "$PROGRESS_FILE" | while IFS= read -r line; do
                if [ -n "$line" ]; then
                    echo -e "  $line"
                fi
            done
            LAST_LINE_COUNT=$CURRENT_LINE_COUNT
        fi
    fi

    sleep 0.2
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

# Show any remaining progress lines
if [ -f "$PROGRESS_FILE" ]; then
    CURRENT_LINE_COUNT=$(wc -l < "$PROGRESS_FILE" 2>/dev/null || echo "0")
    if [ "$CURRENT_LINE_COUNT" -gt "$LAST_LINE_COUNT" ]; then
        tail -n +$((LAST_LINE_COUNT + 1)) "$PROGRESS_FILE" | while IFS= read -r line; do
            if [ -n "$line" ]; then
                echo -e "  $line"
            fi
        done
    fi
fi

echo ""
if [ ! -f /tmp/.entrypoint-complete ]; then
    echo -e "${YELLOW}Container initialization timed out, proceeding anyway${NC}"
else
    echo -e "${GREEN}Container initialization complete${NC}"
fi

# Display network access mode for user awareness
if [ "${NETWORK_MODE:-restricted}" = "full" ]; then
    echo -e "${GREEN}Network: Full internet access (unrestricted)${NC}"
else
    echo -e "${BLUE}Network: Restricted (whitelist-based firewall)${NC}"
fi

# Wait for Claude config to be ready (skip for root terminals)
# The entrypoint creates ~/.claude.json, but we need to ensure it's fully written
# before launching Claude (which happens after workspace-setup.sh completes)
# Root terminals (orkroot user) don't need Claude config, so skip the wait
if [ "$(whoami)" = "orkroot" ]; then
    echo -e "${BLUE}Root terminal - skipping Claude config wait${NC}"
else
    CLAUDE_CONFIG_WAIT=0
    SPINNER_FRAMES=('|' '/' '-' '\')
    if [ ! -f "$HOME/.claude.json" ]; then
        printf "Waiting for Claude config "
        while [ ! -f "$HOME/.claude.json" ] && [ $CLAUDE_CONFIG_WAIT -lt 50 ]; do
            SPINNER_IDX=$((CLAUDE_CONFIG_WAIT % 4))
            SPINNER_CHAR="${SPINNER_FRAMES[$SPINNER_IDX]}"
            printf "\r%sWaiting for Claude config %s%s " "$BLUE" "$SPINNER_CHAR" "$NC"
            sleep 0.2
            CLAUDE_CONFIG_WAIT=$((CLAUDE_CONFIG_WAIT + 1))
        done
        printf "\r"
    fi

    if [ -f "$HOME/.claude.json" ]; then
        echo -e "${GREEN}Claude config ready${NC}                         "
    else
        echo -e "${YELLOW}Warning: ~/.claude.json not found after waiting${NC}"
    fi
fi

echo -e "${BLUE}=== Workspace Setup ===${NC}"

ensure_git_exclude_trailing_newline() {
    local exclude_file="$1"
    if [ -s "$exclude_file" ] && [ "$(tail -c 1 "$exclude_file" 2>/dev/null)" != "" ]; then
        printf '\n' >> "$exclude_file"
    fi
}

append_git_exclude_pattern() {
    local exclude_file="$1"
    local pattern="$2"
    ensure_git_exclude_trailing_newline "$exclude_file"
    printf '%s\n' "$pattern" >> "$exclude_file"
}

# Function to add Orkestrator workspace artifacts to .git/info/exclude
add_workspace_artifacts_to_git_exclude() {
    local workspace="${WORKSPACE_DIR:-/workspace}"
    if git -C "$workspace" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        local exclude_path
        exclude_path="$(git -C "$workspace" rev-parse --git-path info/exclude 2>/dev/null || true)"
        if [ -z "$exclude_path" ]; then
            return 0
        fi
        local exclude_file
        case "$exclude_path" in
            /*) exclude_file="$exclude_path" ;;
            *) exclude_file="$workspace/$exclude_path" ;;
        esac
        mkdir -p "$(dirname "$exclude_file")"
        for pattern in ".orkestrator" ".claude/settings.local.json"; do
            if ! grep -qxF "$pattern" "$exclude_file" 2>/dev/null; then
                append_git_exclude_pattern "$exclude_file" "$pattern"
                echo -e "  ${GREEN}Added $pattern to git exclude${NC}"
            fi
        done
    fi
}

# Initial prompt attachments may be uploaded before this setup script runs.
# Preserve Orkestrator's private workspace state while clearing /workspace for clone.
ORKESTRATOR_WORKSPACE_STATE_BACKUP=""
ORKESTRATOR_WORKSPACE_STATE_WORKSPACE="/workspace"

cleanup_orkestrator_workspace_state_backup() {
    if [ -n "$ORKESTRATOR_WORKSPACE_STATE_BACKUP" ] && [ -d "$ORKESTRATOR_WORKSPACE_STATE_BACKUP" ]; then
        restore_orkestrator_workspace_state "$ORKESTRATOR_WORKSPACE_STATE_WORKSPACE" >/dev/null 2>&1 || rm -rf "$ORKESTRATOR_WORKSPACE_STATE_BACKUP"
    fi
    ORKESTRATOR_WORKSPACE_STATE_BACKUP=""
}
trap cleanup_orkestrator_workspace_state_backup EXIT

preserve_orkestrator_workspace_state() {
    local workspace="${1:-/workspace}"
    local state_path="$workspace/.orkestrator"
    ORKESTRATOR_WORKSPACE_STATE_WORKSPACE="$workspace"

    if [ -L "$state_path" ]; then
        echo -e "  ${YELLOW}Skipping symlinked .orkestrator workspace state${NC}"
        return 0
    fi

    if [ -d "$state_path" ]; then
        ORKESTRATOR_WORKSPACE_STATE_BACKUP="$(mktemp -d /tmp/orkestrator-workspace-state.XXXXXX)" || return 1
        if ! cp -a "$state_path/." "$ORKESTRATOR_WORKSPACE_STATE_BACKUP"/; then
            rm -rf "$ORKESTRATOR_WORKSPACE_STATE_BACKUP"
            ORKESTRATOR_WORKSPACE_STATE_BACKUP=""
            return 1
        fi
        echo -e "  ${GREEN}Preserved .orkestrator workspace state${NC}"
    fi
}

restore_orkestrator_workspace_state() {
    local workspace="${1:-/workspace}"
    local state_path="$workspace/.orkestrator"
    if [ -n "$ORKESTRATOR_WORKSPACE_STATE_BACKUP" ] && [ -d "$ORKESTRATOR_WORKSPACE_STATE_BACKUP" ]; then
        if [ -e "$state_path" ] || [ -L "$state_path" ]; then
            rm -rf "$state_path" || return 1
        fi
        mkdir -p "$state_path" || return 1
        cp -a "$ORKESTRATOR_WORKSPACE_STATE_BACKUP"/. "$state_path/" || return 1
        rm -rf "$ORKESTRATOR_WORKSPACE_STATE_BACKUP" || return 1
        ORKESTRATOR_WORKSPACE_STATE_BACKUP=""
        echo -e "  ${GREEN}Restored .orkestrator workspace state${NC}"
    fi
}

# Function to convert SSH URLs to HTTPS for token-based authentication
convert_ssh_to_https() {
    local url="$1"

    # Already HTTPS - return as-is
    if [[ "$url" == https://* ]] || [[ "$url" == http://* ]]; then
        echo "$url"
        return
    fi

    # git@host:user/repo.git -> https://host/user/repo.git
    if [[ "$url" == git@* ]]; then
        # Extract: git@github.com:user/repo.git -> github.com:user/repo.git -> github.com user/repo.git
        local after_at="${url#git@}"
        local host="${after_at%%:*}"
        local path="${after_at#*:}"
        echo "https://${host}/${path}"
        return
    fi

    # ssh://git@host/path -> https://host/path
    if [[ "$url" == ssh://* ]]; then
        local without_scheme="${url#ssh://}"
        local without_user="${without_scheme#git@}"
        echo "https://${without_user}"
        return
    fi

    # git://host/path -> https://host/path
    if [[ "$url" == git://* ]]; then
        local without_scheme="${url#git://}"
        echo "https://${without_scheme}"
        return
    fi

    # Unknown format - return as-is
    echo "$url"
}

# Convert GIT_URL from SSH to HTTPS if needed
if [ -n "$GIT_URL" ]; then
    ORIGINAL_URL="$GIT_URL"
    GIT_URL=$(convert_ssh_to_https "$GIT_URL")
    if [ "$ORIGINAL_URL" != "$GIT_URL" ]; then
        echo -e "${BLUE}>>> Converted SSH URL to HTTPS <<<${NC}"
        echo -e "  From: ${YELLOW}$ORIGINAL_URL${NC}"
        echo -e "  To:   ${GREEN}$GIT_URL${NC}"
    fi
fi

# Configure GitHub token if provided (avoid interactive prompts)
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
# Host git configs can contain absolute credential helper paths copied from
# macOS, such as /opt/homebrew/bin/gh, which do not exist in containers.
git config --global --replace-all credential.helper "" 2>/dev/null || true
export GIT_TERMINAL_PROMPT=0
if [ -n "$TOKEN" ]; then
    echo -e "${BLUE}>>> Configuring GitHub token for HTTPS <<<${NC}"
    git config --global url."https://x-access-token:${TOKEN}@github.com/".insteadOf "https://github.com/"
    git config --global url."https://x-access-token:${TOKEN}@github.com/".insteadOf "https://github.com"
    # Also rewrite SSH URLs to use token auth (belt and suspenders)
    git config --global url."https://x-access-token:${TOKEN}@github.com/".insteadOf "git@github.com:"
fi

print_workspace_disk_status() {
    echo "Disk availability:"
    df -h /workspace /tmp 2>/dev/null | awk 'NR==1 || $6=="/workspace" || $6=="/tmp" {print "  " $0}'
}

clone_repository() {
    local clone_url="$1"
    local clone_dest="$2"

    # Try partial clone first to reduce disk usage for large repositories.
    if git clone --filter=blob:none --no-tags "$clone_url" "$clone_dest"; then
        return 0
    fi

    echo -e "${YELLOW}Partial clone failed, retrying full clone...${NC}"
    rm -rf "$clone_dest"/* "$clone_dest"/.[!.]* 2>/dev/null || true
    git clone "$clone_url" "$clone_dest"
}

# Check if setup already completed
if [ -f /tmp/.workspace-setup-complete ]; then
    add_workspace_artifacts_to_git_exclude
    echo -e "${GREEN}Workspace already set up.${NC}"
    exit 0
fi

# Clone repository if GIT_URL is set and /workspace/.git doesn't exist
if [ -n "$GIT_URL" ] && [ ! -d "/workspace/.git" ]; then
    echo ""
    echo -e "${BLUE}>>> Cloning Repository <<<${NC}"
    echo -e "URL: ${GREEN}$GIT_URL${NC}"
    echo -e "Branch: ${GREEN}${GIT_BRANCH:-main}${NC}"
    if [ -n "${GIT_BASE_BRANCH:-}" ]; then
        echo -e "Base branch: ${GREEN}${GIT_BASE_BRANCH}${NC}"
    fi
    echo ""

    BRANCH="${GIT_BRANCH:-main}"
    BASE_BRANCH="${GIT_BASE_BRANCH:-}"

    # Clean /workspace
    echo "Preparing workspace..."
    preserve_orkestrator_workspace_state
    rm -rf /workspace/* 2>/dev/null || true
    rm -rf /workspace/.* 2>/dev/null || true
    find /workspace -mindepth 1 -delete 2>/dev/null || true
    print_workspace_disk_status

    # Prepare clone URL - inject token directly for more reliable auth
    # Note: We avoid logging the URL with token to prevent credential exposure
    CLONE_URL="$GIT_URL"
    if [ -n "$TOKEN" ] && [[ "$GIT_URL" == https://github.com/* ]]; then
        # Replace https://github.com/ with https://x-access-token:TOKEN@github.com/
        # Disable shell tracing temporarily to avoid token exposure in logs
        { set +x; } 2>/dev/null
        CLONE_URL="${GIT_URL/https:\/\/github.com\//https://x-access-token:${TOKEN}@github.com/}"
        echo -e "${BLUE}Using token-authenticated URL${NC}"
    fi

    # Clone directly into /workspace
    echo "Cloning..."
    if clone_repository "$CLONE_URL" /workspace; then
        echo -e "${GREEN}Clone successful!${NC}"
        cd /workspace

        # Checkout requested branch if different from current
        CURRENT=$(git branch --show-current)
        if [ "$CURRENT" != "$BRANCH" ]; then
            echo "Checking out branch: $BRANCH"
            if git checkout "$BRANCH" 2>/dev/null; then
                echo -e "${GREEN}Checked out: $BRANCH${NC}"
            elif git checkout -b "$BRANCH" "origin/$BRANCH" 2>/dev/null; then
                echo -e "${GREEN}Checked out remote: origin/$BRANCH${NC}"
            else
                # Branch doesn't exist remotely - create a new branch from configured/default base
                echo -e "${BLUE}Creating new branch: $BRANCH${NC}"

                REMOTE_HEAD_REF=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)
                REMOTE_DEFAULT_BRANCH="${REMOTE_HEAD_REF#origin/}"

                CREATED_FROM=$(create_branch_from_preferred_bases "$BRANCH" "$BASE_BRANCH" "$REMOTE_DEFAULT_BRANCH" || true)

                if [ -n "$CREATED_FROM" ]; then
                    echo -e "${GREEN}Created new branch: $BRANCH (from $CREATED_FROM)${NC}"
                else
                    # Create from current HEAD as last resort
                    if git checkout -b "$BRANCH" 2>/dev/null; then
                        echo -e "${GREEN}Created new branch: $BRANCH (from HEAD)${NC}"
                    else
                        echo -e "${RED}Failed to create branch: $BRANCH${NC}"
                        echo -e "${YELLOW}Staying on current branch: $CURRENT${NC}"
                    fi
                fi
            fi
        fi

        # Add Orkestrator workspace artifacts to .git/info/exclude so they're ignored locally
        add_workspace_artifacts_to_git_exclude

        echo ""
        echo -e "${GREEN}Repository ready:${NC}"
        echo "  Branch: $(git branch --show-current)"
        REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo 'none')
        if [ -n "$TOKEN" ]; then
            REMOTE_URL=$(echo "$REMOTE_URL" | sed -E 's#https://x-access-token:[^@]+@github.com#https://github.com#g')
        fi
        echo "  Remote: ${REMOTE_URL}"
    else
        echo -e "${RED}Clone failed! Trying fallback...${NC}"

        # Fallback: clone to temp then move
        TEMP_CLONE="/tmp/repo_clone"
        rm -rf "$TEMP_CLONE" 2>/dev/null

        if clone_repository "$CLONE_URL" "$TEMP_CLONE"; then
            echo "Moving files to workspace..."
            mv "$TEMP_CLONE"/* /workspace/ 2>/dev/null || true
            mv "$TEMP_CLONE"/.[!.]* /workspace/ 2>/dev/null || true
            rm -rf "$TEMP_CLONE"

            if [ -d "/workspace/.git" ]; then
                echo -e "${GREEN}Fallback succeeded!${NC}"
                cd /workspace
                # Add Orkestrator workspace artifacts to .git/info/exclude so they're ignored locally
                add_workspace_artifacts_to_git_exclude
            else
                echo -e "${RED}Fallback failed - no .git directory${NC}"
            fi
        else
            echo -e "${RED}Fallback clone also failed${NC}"
        fi
    fi
else
    if [ -z "$GIT_URL" ]; then
        echo -e "${YELLOW}No GIT_URL provided - skipping clone${NC}"
    elif [ -d "/workspace/.git" ]; then
        echo "Repository already exists in /workspace"
        cd /workspace
        add_workspace_artifacts_to_git_exclude
        echo "  Branch: $(git branch --show-current 2>/dev/null || echo 'unknown')"
    fi
fi

restore_orkestrator_workspace_state
add_workspace_artifacts_to_git_exclude

# Copy .env files to workspace
echo ""
echo -e "${BLUE}>>> Setting up environment files <<<${NC}"

if [ -d /project-env ]; then
    if [ -f /project-env/.env ]; then
        cp /project-env/.env /workspace/.env
        echo -e "  ${GREEN}Copied .env from project folder${NC}"
    fi
    if [ -f /project-env/.env.local ]; then
        cp /project-env/.env.local /workspace/.env.local
        echo -e "  ${GREEN}Copied .env.local from project folder${NC}"
    fi
elif [ -f /env/.env ]; then
    cp /env/.env /workspace/.env
    echo -e "  ${GREEN}Copied .env file${NC}"
elif [ -f /env/.env.local ]; then
    cp /env/.env.local /workspace/.env
    echo -e "  ${GREEN}Copied .env.local file${NC}"
else
    echo "  No .env files to copy"
fi

# Copy additional project files if mounted (preserving directory structure)
if [ -d /project-files ]; then
    echo ""
    echo -e "${BLUE}>>> Copying additional project files <<<${NC}"

    # Find all files in /project-files and copy them preserving relative paths
    cd /project-files
    FILE_COUNT=0
    # Use process substitution to avoid subshell, ensuring FILE_COUNT persists
    while read -r file; do
        # Remove leading ./ from path
        rel_path="${file#./}"
        dest="/workspace/$rel_path"
        dest_dir=$(dirname "$dest")

        # Create parent directories if needed
        if [ ! -d "$dest_dir" ]; then
            mkdir -p "$dest_dir"
        fi

        # Copy the file
        cp "/project-files/$rel_path" "$dest"
        echo -e "  ${GREEN}Copied $rel_path${NC}"
        FILE_COUNT=$((FILE_COUNT + 1))
    done < <(find . -type f)

    if [ "$FILE_COUNT" -eq 0 ]; then
        echo "  No additional files to copy"
    fi
fi

# Set up opencode.json if mounted from project
if [ -f /opencode-project-json ]; then
    echo ""
    echo -e "${BLUE}>>> Setting up OpenCode configuration <<<${NC}"

    # Copy to workspace root
    cp /opencode-project-json /workspace/opencode.json

    # Add default model attribute if missing (use OPENCODE_MODEL env var or fallback to default)
    if ! jq -e '.model' /workspace/opencode.json > /dev/null 2>&1; then
        DEFAULT_MODEL="${OPENCODE_MODEL:-opencode/grok-code}"
        echo -e "  ${YELLOW}No model specified, adding default: $DEFAULT_MODEL${NC}"
        jq --arg model "$DEFAULT_MODEL" '. + {"model": $model}' /workspace/opencode.json > /tmp/opencode.json.tmp
        mv /tmp/opencode.json.tmp /workspace/opencode.json
    else
        MODEL=$(jq -r '.model' /workspace/opencode.json)
        echo -e "  ${GREEN}Using configured model: $MODEL${NC}"
    fi

    echo -e "  ${GREEN}opencode.json ready${NC}"
fi

# Run orkestrator-ai.json setup script if present
echo ""
echo -e "${BLUE}>>> Checking for project setup script <<<${NC}"

if [ -f /workspace/orkestrator-ai.json ]; then
    echo -e "${GREEN}Found orkestrator-ai.json${NC}"
    cat /workspace/orkestrator-ai.json
    echo ""

    # Parse the root field (string or array) - runs as root user before regular scripts
    ROOT_SCRIPT=$(jq -r '.root // empty' /workspace/orkestrator-ai.json 2>/dev/null)
    ROOT_SCRIPT_TYPE=$(jq -r 'if .root==null then "empty" elif (.root|type)=="array" then "array" elif (.root|type)=="string" then "string" else "other" end' /workspace/orkestrator-ai.json 2>/dev/null)
    ROOT_ARRAY_LENGTH=$(jq -r '.root | if type=="array" then length else 0 end' /workspace/orkestrator-ai.json 2>/dev/null)

    if [ -n "$ROOT_SCRIPT" ] || { [ "$ROOT_SCRIPT_TYPE" = "array" ] && [ "$ROOT_ARRAY_LENGTH" -gt 0 ]; }; then
        echo ""
        echo -e "${BLUE}=== Running Root Setup ===${NC}"
        echo ""

        cd /workspace

        run_root_step() {
            local step="$1"
            echo -e "Root command: ${GREEN}$step${NC}"
            # Run as orkroot (UID 0, root-equivalent) using sudo
            sudo -u orkroot /bin/bash -c "$step"
        }

        ROOT_EXIT=0
        set +e
        if [ "$ROOT_SCRIPT_TYPE" = "array" ]; then
            # Iterate array steps in order
            while IFS= read -r step; do
                if [ -z "$step" ]; then
                    continue
                fi
                run_root_step "$step"
                ROOT_EXIT=$?
                if [ $ROOT_EXIT -ne 0 ]; then
                    break
                fi
            done < <(jq -r '.root[]' /workspace/orkestrator-ai.json 2>/dev/null)
        else
            # Single command string
            run_root_step "$ROOT_SCRIPT"
            ROOT_EXIT=$?
        fi
        set -e

        echo ""
        if [ $ROOT_EXIT -eq 0 ]; then
            echo -e "${GREEN}Root setup completed successfully!${NC}"
        else
            echo -e "${YELLOW}Root setup exited with code $ROOT_EXIT${NC}"
        fi
    else
        echo "  No root setup defined (root field is empty)"
    fi

    # Parse the setupContainer field (string or array) - runs for container environments
    SETUP_SCRIPT=$(jq -r '.setupContainer // empty' /workspace/orkestrator-ai.json 2>/dev/null)
    SETUP_SCRIPT_TYPE=$(jq -r 'if .setupContainer==null then "empty" elif (.setupContainer|type)=="array" then "array" elif (.setupContainer|type)=="string" then "string" else "other" end' /workspace/orkestrator-ai.json 2>/dev/null)

    if [ -n "$SETUP_SCRIPT" ] || [ "$SETUP_SCRIPT_TYPE" = "array" ]; then
        echo ""
        echo -e "${BLUE}=== Running Container Setup ===${NC}"
        echo ""

        cd /workspace

        run_setup_step() {
            local step="$1"
            echo -e "Command: ${GREEN}$step${NC}"
            # Run in login shell, explicitly sourcing .zshrc and the Orkestrator
            # runtime helper to pick up PATH changes from previous steps.
            /bin/zsh -lc "source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true; orkestrator_source_runtime_env 2>/dev/null || true; source ~/.zshrc 2>/dev/null || true; orkestrator_add_common_runtime_paths 2>/dev/null || true; $step"
            return $?
        }

        SCRIPT_EXIT=0
        set +e
        if [ "$SETUP_SCRIPT_TYPE" = "array" ]; then
            # Iterate array steps in order
            while IFS= read -r step; do
                if [ -z "$step" ]; then
                    continue
                fi
                run_setup_step "$step"
                SCRIPT_EXIT=$?
                if [ $SCRIPT_EXIT -ne 0 ]; then
                    break
                fi
            done < <(jq -r '.setupContainer[]' /workspace/orkestrator-ai.json 2>/dev/null)
        else
            # Single command string
            run_setup_step "$SETUP_SCRIPT"
            SCRIPT_EXIT=$?
        fi
        set -e

echo ""
if [ $SCRIPT_EXIT -eq 0 ]; then
    echo -e "${GREEN}Container setup completed successfully!${NC}"
    touch /tmp/.workspace-setup-complete
else
    echo -e "${YELLOW}Container setup exited with code $SCRIPT_EXIT${NC}"
    echo "=== Workspace Setup Failed ==="
fi
else
    echo "  No container setup defined (setupContainer field is empty)"
    touch /tmp/.workspace-setup-complete
fi
else
    echo "  No orkestrator-ai.json found"
    touch /tmp/.workspace-setup-complete
fi

capture_runtime_env_snapshot

echo ""
echo -e "${GREEN}=== Workspace Ready ===${NC}"
echo ""
