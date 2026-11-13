#!/bin/bash
# Workspace setup script - runs in the terminal so user can see progress
# This script handles: repo cloning, .env files, orkestrator-ai.json setup

set -e

# Capability declaration. The backend greps for this exact line before it invokes
# --prepare-only, because an older image's copy of this script has no argument
# handling at all: it would ignore the flag and run the *entire* setup, including
# the repository-controlled orkestrator-ai.json commands, before the backend ever
# reads HEAD. Refusing up front is what stops a polluted creation commit being
# recorded on an image that predates this contract. Keep the literal text in sync
# with CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER in apps/backend/src/core/commands.ts.
ORKESTRATOR_SETUP_CAPABILITIES=prepare-only
export ORKESTRATOR_SETUP_CAPABILITIES
# Image manifest contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY workspace-prepare=1
# ORKESTRATOR_CAPABILITY git-mirror=1

PREPARE_ONLY=false
if [ "${1:-}" = "--prepare-only" ]; then
    PREPARE_ONLY=true
elif [ "$#" -gt 0 ]; then
    echo "Unknown workspace setup argument: $1" >&2
    exit 2
fi

# Color output helpers - use $'...' syntax for proper escape sequence handling
GREEN=$'\033[0;32m'
BLUE=$'\033[0;34m'
YELLOW=$'\033[1;33m'
RED=$'\033[0;31m'
NC=$'\033[0m' # No Color

# Load the shared git branch helpers. They are only needed when this script
# clones a repository, so a missing helper file is reported at that point rather
# than aborting a setup run that never touches a branch.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "/usr/local/bin/git-branch-helpers.sh" ]; then
    # shellcheck source=/dev/null
    . "/usr/local/bin/git-branch-helpers.sh"
elif [ -f "$SCRIPT_DIR/git-branch-helpers.sh" ]; then
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/git-branch-helpers.sh"
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

# Wait for this boot's initialization (config files, firewall) to finish.
# This prevents race conditions where Claude is launched before config is ready.
# A boot status record counts only when it names the current PID 1 start time:
# a record or marker left by an earlier start of this container must never
# release setup. On timeout or failure setup stops with a retryable error; it
# never proceeds on an unfinished container.
PROGRESS_FILE="/tmp/.entrypoint-progress"
BOOT_STATUS_FILE=/run/orkestrator/boot-status.json
BOOT_WAIT_SECONDS="${ORKESTRATOR_BOOT_WAIT_SECONDS:-120}"
LAST_LINE_COUNT=0

show_new_progress() {
    if [ -f "$PROGRESS_FILE" ]; then
        CURRENT_LINE_COUNT=$(wc -l < "$PROGRESS_FILE" 2>/dev/null || echo "0")
        if [ "$CURRENT_LINE_COUNT" -gt "$LAST_LINE_COUNT" ]; then
            tail -n +$((LAST_LINE_COUNT + 1)) "$PROGRESS_FILE" | while IFS= read -r line; do
                if [ -n "$line" ]; then
                    echo -e "  $line"
                fi
            done
            LAST_LINE_COUNT=$CURRENT_LINE_COUNT
        fi
    fi
}

# Prints the current boot's phase, or nothing when no current record exists.
current_boot_phase() {
    [ -f "$BOOT_STATUS_FILE" ] || return 0
    local pid1_start
    pid1_start="$(awk '{print $22}' /proc/1/stat 2>/dev/null)"
    jq -r --arg start "$pid1_start" 'select(.pid1Start == $start) | .phase' "$BOOT_STATUS_FILE" 2>/dev/null || true
}

echo -e "${BLUE}=== Container Initialization ===${NC}"
echo ""

BOOT_READY=false
BOOT_FAILED=false
DEADLINE=$(( $(date +%s) + BOOT_WAIT_SECONDS ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    show_new_progress
    if [ -d /run/orkestrator ]; then
        phase="$(current_boot_phase)"
        if [ "$phase" = "ready" ]; then BOOT_READY=true; break; fi
        if [ "$phase" = "failed" ]; then BOOT_FAILED=true; break; fi
    elif [ -f /tmp/.entrypoint-complete ]; then
        # An image that predates boot status records.
        BOOT_READY=true
        break
    fi
    sleep 0.2
done
show_new_progress

echo ""
if [ "$BOOT_FAILED" = true ]; then
    echo -e "${RED}Container initialization failed. Check the container logs, then retry setup.${NC}"
    exit 1
fi
if [ "$BOOT_READY" != true ]; then
    echo -e "${RED}Container initialization did not complete within ${BOOT_WAIT_SECONDS}s. Retry setup once the container is ready.${NC}"
    exit 1
fi
echo -e "${GREEN}Container initialization complete${NC}"

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

validate_prepared_workspace() {
    local workspace="${1:-/workspace}"
    git -C "$workspace" rev-parse --verify 'HEAD^{commit}' >/dev/null 2>&1
}

# Terminates the --prepare-only run. The sentinel is what the backend matches on
# to confirm this phase actually ran to completion; a script that merely exits 0
# is not enough, because the pre-contract script also exits 0.
emit_prepare_only_checkpoint() {
    local workspace="${1:-/workspace}"
    if ! validate_prepared_workspace "$workspace"; then
        echo -e "${RED}Workspace preparation failed - no valid Git HEAD${NC}" >&2
        return 1
    fi
    printf '\036ORKESTRATOR_PREPARE_OK\037'
    echo -e "${GREEN}Workspace preparation complete${NC}"
    return 0
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

# Turn on git's own scan caches for the container workspace.
#
# Diff and status reads walk and stat the whole tree; the untracked cache lets
# git skip directories it has already seen to be clean. Unlike the host side
# this is a throwaway clone inside a container, so it is written to the ordinary
# repository config with no need for per-worktree scoping.
#
# fsmonitor is deliberately not enabled here: it would start a background daemon
# in a container whose lifetime is not this script's to manage, and container
# reads go through a single docker exec where the walk is not the bottleneck.
enable_git_scan_caches() {
    local workspace="${WORKSPACE_DIR:-/workspace}"
    if git -C "$workspace" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git -C "$workspace" config core.untrackedCache true 2>/dev/null || true
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
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
# Host git configs can contain absolute credential helper paths copied from
# macOS, such as /opt/homebrew/bin/gh, which do not exist in containers.
git config --global --replace-all credential.helper "" 2>/dev/null || true
export GIT_TERMINAL_PROMPT=0

# Agent-test fixtures bind-mount a host bare repository at one fixed path. It
# keeps its host owner, so Git refuses to clone it as dubiously owned. Trust
# only that path, and only when the backend says it mounted the fixture.
AGENT_TEST_GIT_REMOTE_PATH="/orkestrator-agent-test-origin.git"
trust_agent_test_git_remote() {
    if [ "${ORKESTRATOR_AGENT_TEST_GIT_REMOTE:-}" != "$AGENT_TEST_GIT_REMOTE_PATH" ]; then
        return 0
    fi
    if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$AGENT_TEST_GIT_REMOTE_PATH"; then
        git config --global --add safe.directory "$AGENT_TEST_GIT_REMOTE_PATH"
    fi
}
trust_agent_test_git_remote
# Sync may have installed this already; clearing credential.helper above can
# have appended an empty value after it, which would switch it off. Install it
# again at the end of the file. The helper reads the token file per request, so
# the token never enters this config. `""` drops any helper a copied host config
# names for GitHub. No token leaves SSH remotes on SSH.
# Copied configs and earlier images may still carry a token in a URL rewrite.
# Remove it before any clone, including when credentials are withheld.
git config --global --name-only --get-regexp '^url\.https://x-access-token:' 2>/dev/null |
    sed 's/\.[^.]*$//' |
    sort -u |
    while IFS= read -r section; do
        git config --global --remove-section "$section" 2>/dev/null || true
    done

git config --global --remove-section credential.https://github.com 2>/dev/null || true
git config --global --unset-all url.https://github.com/.insteadOf '^git@github\.com:$' 2>/dev/null || true
if [ -n "$TOKEN" ]; then
    echo -e "${BLUE}>>> Configuring GitHub credential for HTTPS <<<${NC}"
    git config --global --add credential.https://github.com.helper ""
    git config --global --add credential.https://github.com.helper /usr/local/bin/orkestrator-git-credential
    git config --global --add url.https://github.com/.insteadOf "git@github.com:"
fi

print_workspace_disk_status() {
    echo "Disk availability:"
    df -h /workspace /tmp 2>/dev/null | awk 'NR==1 || $6=="/workspace" || $6=="/tmp" {print "  " $0}'
}

# Prints why the project's Git mirror cannot serve a clone, or nothing when it
# can. `--git-dir` because the mirror's owner is the host's user, which Git would
# otherwise refuse to read as dubiously owned. The tip's tree proves the refs
# reach real objects: a clone given refs without them would quietly download
# everything instead of failing.
git_mirror_problem() {
    local mirror="$1"
    local tip
    if [ ! -d "$mirror/objects" ] || [ ! -f "$mirror/HEAD" ]; then
        echo missing
        return 0
    fi
    if ! tip="$(git --git-dir="$mirror" for-each-ref --count=1 --format='%(objectname)' refs/heads/ 2>/dev/null)"; then
        echo corrupt
        return 0
    fi
    if [ -z "$tip" ]; then
        echo empty
    elif ! git --git-dir="$mirror" cat-file -e "$tip^{tree}" 2>/dev/null; then
        echo corrupt
    fi
    return 0
}

# The backend reads this line; the reason is one fixed word.
report_git_mirror_outcome() {
    printf '\036ORKESTRATOR_GIT_MIRROR:%s\037\n' "$1"
}

# Clones from the project's read-only mirror when it can. Returns non-zero, with
# the destination clear and the reason logged, for the ordinary clone to run.
#
# No --filter: --dissociate then drops whatever the mirror held, and a mirror
# behind the remote leaves a partial clone that fetches from the remote again.
# --reference-if-able, so a mirror removed between the check and the clone
# still leaves a working clone. That clone took its history from the remote, so
# the mirror is checked again afterwards and the outcome says so (vanished).
clone_from_git_mirror() {
    local clone_url="$1"
    local clone_dest="$2"
    local mirror="${ORKESTRATOR_GIT_MIRROR:-}"
    local problem
    if [ -z "$mirror" ]; then
        return 1
    fi
    # One attempt: the caller's own retry goes straight to the remote.
    ORKESTRATOR_GIT_MIRROR=""

    problem="$(git_mirror_problem "$mirror")"
    if [ -z "$problem" ]; then
        echo "Cloning from the project's Git mirror..."
        if git clone --no-tags --reference-if-able "$mirror" --dissociate "$clone_url" "$clone_dest"; then
            if [ ! -e "$clone_dest/.git/objects/info/alternates" ]; then
                if [ -n "$(git_mirror_problem "$mirror")" ]; then
                    echo -e "${YELLOW}Git mirror went away during the clone; its history came from the remote.${NC}"
                    report_git_mirror_outcome vanished
                    return 0
                fi
                report_git_mirror_outcome used
                return 0
            fi
            problem=not-self-contained
        else
            problem=clone-failed
        fi
        rm -rf "$clone_dest"/* "$clone_dest"/.[!.]* 2>/dev/null || true
    fi
    echo -e "${YELLOW}Git mirror not used (${problem}); cloning from the remote.${NC}"
    report_git_mirror_outcome "$problem"
    return 1
}

clone_repository() {
    local clone_url="$1"
    local clone_dest="$2"

    if clone_from_git_mirror "$clone_url" "$clone_dest"; then
        return 0
    fi

    # Try partial clone first to reduce disk usage for large repositories.
    if git clone --filter=blob:none --no-tags "$clone_url" "$clone_dest"; then
        return 0
    fi

    echo -e "${YELLOW}Partial clone failed, retrying full clone...${NC}"
    rm -rf "$clone_dest"/* "$clone_dest"/.[!.]* 2>/dev/null || true
    git clone "$clone_url" "$clone_dest"
}

# Moves a finished clone from its staging folder into the workspace. Both are
# on the workspace volume, so each top-level entry is a rename rather than a
# byte copy. The workspace holds only `.orkestrator` and `lost+found` at this
# point. Only repository-owned `.orkestrator` is skipped, since restore replaces
# it. Repository-owned lost+found is moved normally; a collision fails explicitly.
# An entry that could not be moved fails the step; the caller's in-progress marker
# makes the next start clean up and clone again.
move_clone_into_workspace() {
    local clone_dest="$1"
    local workspace="$2"
    find "$clone_dest" -mindepth 1 -maxdepth 1 ! -name .orkestrator \
        -exec mv -n -- {} "$workspace"/ \; || return 1
    if [ -n "$(find "$clone_dest" -mindepth 1 -maxdepth 1 ! -name .orkestrator -print -quit)" ]; then
        echo -e "${RED}Could not move the clone into the workspace.${NC}"
        return 1
    fi
    rm -rf "$clone_dest"
}

# Check if setup already completed
if [ -f /tmp/.workspace-setup-complete ]; then
    add_workspace_artifacts_to_git_exclude
    echo -e "${GREEN}Workspace already set up.${NC}"
    exit 0
fi

# A clone interrupted while copying may already have a partial .git directory.
if [ -n "$GIT_URL" ] && { [ ! -d "/workspace/.git" ] || \
   { [ "${ORKESTRATOR_WORKSPACE_STORAGE:-legacy-layer}" = "volume-v1" ] && \
     [ -f /workspace/.orkestrator/.clone-copy-in-progress ]; }; }; then
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

    # A persistent workspace volume is cloned into only when it is verifiably
    # this environment's freshly initialized volume. A volume that failed to
    # mount must not be replaced by a clone into the container layer that
    # would later be reported as persistent, and unknown content in a
    # persistent volume is refused rather than erased.
    if [ "${ORKESTRATOR_WORKSPACE_STORAGE:-legacy-layer}" = "volume-v1" ]; then
        if ! mountpoint -q /workspace; then
            echo -e "${RED}The persistent workspace volume is not mounted; refusing to clone into the container layer.${NC}"
            exit 1
        fi
        STORAGE_MARKER=/workspace/.orkestrator/storage-marker.json
        if [ -L /workspace/.orkestrator ] || [ ! -f "$STORAGE_MARKER" ] || [ -L "$STORAGE_MARKER" ] || \
           [ "$(jq -r '.environmentId // empty' "$STORAGE_MARKER" 2>/dev/null)" != "${ORKESTRATOR_ENVIRONMENT_ID:-}" ]; then
            echo -e "${RED}The workspace volume has no valid storage marker for this environment; refusing to initialize it.${NC}"
            exit 1
        fi
        if [ -n "$(find /workspace -mindepth 1 -maxdepth 1 ! -name .orkestrator ! -name lost+found -print -quit 2>/dev/null)" ] && \
           [ ! -f /workspace/.orkestrator/.clone-copy-in-progress ]; then
            echo -e "${RED}The workspace volume holds files but no repository; refusing to overwrite them.${NC}"
            exit 1
        fi
    fi

    # Clean /workspace
    echo "Preparing workspace..."
    if [ "${ORKESTRATOR_WORKSPACE_STORAGE:-legacy-layer}" = "volume-v1" ]; then
        rm -rf /workspace/.orkestrator/.clone-in-progress
    fi
    preserve_orkestrator_workspace_state
    if [ "${ORKESTRATOR_WORKSPACE_STORAGE:-legacy-layer}" = "volume-v1" ]; then
        find /workspace -mindepth 1 -maxdepth 1 ! -name .orkestrator ! -name lost+found -exec rm -rf -- {} +
    else
        rm -rf /workspace/* 2>/dev/null || true
        rm -rf /workspace/.* 2>/dev/null || true
        find /workspace -mindepth 1 -delete 2>/dev/null || true
    fi
    print_workspace_disk_status

    # The credential helper authenticates this. A token in the URL would stay
    # in origin for as long as the workspace lasts.
    CLONE_URL="$GIT_URL"

    # Keep the volume's storage marker in place throughout the clone. A
    # partial clone is discarded on the next start without losing the marker.
    CLONE_DEST=/workspace
    if [ "${ORKESTRATOR_WORKSPACE_STORAGE:-legacy-layer}" = "volume-v1" ]; then
        CLONE_DEST=/workspace/.orkestrator/.clone-in-progress
    fi
    echo "Cloning..."
    if clone_repository "$CLONE_URL" "$CLONE_DEST"; then
        if [ "$CLONE_DEST" != /workspace ]; then
            touch /workspace/.orkestrator/.clone-copy-in-progress || exit 1
            move_clone_into_workspace "$CLONE_DEST" /workspace || exit 1
        fi
        echo -e "${GREEN}Clone successful!${NC}"
        cd /workspace

        # Checkout requested branch if different from current
        CURRENT=$(git branch --show-current)
        if [ "$CURRENT" != "$BRANCH" ]; then
            echo "Checking out branch: $BRANCH"
            if ! declare -F checkout_environment_branch >/dev/null; then
                echo -e "${RED}Missing git-branch-helpers.sh; refusing to check out $BRANCH${NC}"
                exit 1
            fi
            checkout_environment_branch "$BRANCH" "$BASE_BRANCH" "$CURRENT" || exit 1
        fi

        # Add Orkestrator workspace artifacts to .git/info/exclude so they're ignored locally
        add_workspace_artifacts_to_git_exclude

        echo ""
        echo -e "${GREEN}Repository ready:${NC}"
        echo "  Branch: $(git branch --show-current)"
        echo "  Remote: $(git config --get remote.origin.url 2>/dev/null | sed -E 's#(https?://)[^/@]*@#\1[REDACTED]@#g' || echo 'none')"
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
if [ "${ORKESTRATOR_WORKSPACE_STORAGE:-legacy-layer}" = "volume-v1" ] && [ ! -L /workspace/.orkestrator ]; then
    rm -f /workspace/.orkestrator/.clone-copy-in-progress
fi
add_workspace_artifacts_to_git_exclude
enable_git_scan_caches

# The backend invokes this phase separately and durably stores HEAD before it
# allows copied files or repository-controlled setup commands to run.
if [ "$PREPARE_ONLY" = true ]; then
    emit_prepare_only_checkpoint /workspace || exit 1
    exit 0
fi

# Number of root commands orkestrator-ai.json's "root" field names: a
# non-empty string is one, an array counts its non-empty entries. An absent or
# empty field (including "root": []) names none, so it needs no root phase and
# no network check.
project_root_step_count() {
    jq -r '.root
        | if type == "array" then map(select(. != null and . != "")) | length
          elif type == "string" then (if . == "" then 0 else 1 end)
          elif . == null or . == false then 0
          else 1 end' "$1" 2>/dev/null || echo 0
}

# One root step, through the root-owned wrapper. Restricted containers never
# grant the agent a reusable root shell: the wrapper consults PID 1's
# immutable Docker environment and permits project root setup only in full mode.
run_root_step() {
    local step="$1"
    echo -e "Root command: ${GREEN}$step${NC}"
    sudo /usr/local/bin/run-root-setup.sh "$step"
}

# Runs the "root" steps of orkestrator-ai.json ($1). $2 is the file holding the
# container's recorded network mode. Returns 0 when there are no root steps or
# all of them succeeded, and the failing status otherwise.
run_project_root_setup() {
    local config="$1"
    local network_mode_file="$2"
    local count
    count=$(project_root_step_count "$config")
    case "$count" in ''|*[!0-9]*) count=0 ;; esac
    if [ "$count" -eq 0 ]; then
        echo "  No root setup defined (root field is empty)"
        return 0
    fi

    echo ""
    echo -e "${BLUE}=== Running Root Setup ===${NC}"
    echo ""

    # Root steps run only with full network access (run-root-setup.sh refuses
    # them otherwise). Say so plainly before trying, and print the reason
    # marker the backend turns into the environment's error message
    # (SETUP_FAILURE_REASONS in apps/backend/src/core/container-scripts.ts).
    # Without a recorded mode, the wrapper decides.
    local network_mode=""
    IFS= read -r network_mode 2>/dev/null < "$network_mode_file" || true
    if [ -n "$network_mode" ] && [ "$network_mode" != "full" ]; then
        echo -e "${RED}Root setup steps cannot run in this environment${NC}"
        echo ""
        echo "  orkestrator-ai.json has a \"root\" field. Root steps run as the root user,"
        echo "  and a command running as root could get round the network restriction"
        echo "  or the container's other protections, whatever addresses it uses. So"
        echo "  they only run in containers with full network access, and this"
        echo "  environment's network is ${network_mode}."
        echo ""
        echo "  To fix it, either:"
        echo "    - create the environment again with network access set to Full, or"
        echo "    - remove the \"root\" field from orkestrator-ai.json. The image already"
        echo "      has git, mise, bun and node, so many root steps are not needed."
        printf '\033]9999;setup_failure_reason=root-steps-need-full-network\007'
        return 1
    fi

    local root_exit=0
    local step
    if [ "$(jq -r '.root | type' "$config" 2>/dev/null)" = "array" ]; then
        # Array steps run in order; the first failure stops the rest.
        while IFS= read -r step; do
            if [ -z "$step" ]; then
                continue
            fi
            run_root_step "$step" || { root_exit=$?; break; }
        done < <(jq -r '.root[] | select(. != null)' "$config" 2>/dev/null)
    else
        run_root_step "$(jq -r '.root' "$config" 2>/dev/null)" || root_exit=$?
    fi

    echo ""
    if [ "$root_exit" -eq 0 ]; then
        echo -e "${GREEN}Root setup completed successfully!${NC}"
        return 0
    fi
    echo -e "${RED}Root setup failed with code $root_exit${NC}"
    echo "A root step in orkestrator-ai.json exited with an error; its output is above."
    return "$root_exit"
}

# Debian packages orkestrator-ai.json's "aptPackages" field declares (to-do
# 7770), one per line: the non-empty strings of an array. Prints nothing for an
# absent or null field, and returns 1 when the field is not an array of
# strings, or when a string holds a control character. The names travel one
# per line, so a newline inside one ("hello\nffmpeg") would otherwise reach the
# installer as two valid names instead of one it refuses.
project_apt_packages() {
    local kind
    kind=$(jq -r '.aptPackages | type' "$1" 2>/dev/null || echo null)
    case "$kind" in
        null) return 0 ;;
        array) ;;
        *) return 1 ;;
    esac
    jq -e '.aptPackages | all(type == "string" and (explode | all(. >= 32 and . != 127)))' \
        "$1" >/dev/null 2>&1 || return 1
    jq -r '.aptPackages[] | select(. != "")' "$1" 2>/dev/null
}

# The package install, through the root-owned installer. It is the authority on
# what may be installed (names, count, denylist, dependencies) and where (a
# restricted container needs its egress gateway); this only reports.
run_apt_install() {
    if [ ! -x /usr/local/bin/orkestrator-apt-install ]; then
        echo "  This image has no package installer. Rebuild the environment on a current image."
        return 6
    fi
    sudo -n /usr/local/bin/orkestrator-apt-install "$@"
}

# Installs the "aptPackages" of orkestrator-ai.json ($1) before any other
# setup step. Returns 0 when none are declared or all are installed, and
# prints the setup failure reason marker (SETUP_FAILURE_REASONS in
# apps/backend/src/core/container-scripts.ts) otherwise.
run_project_apt_packages() {
    local config="$1"
    local listing
    if ! listing=$(project_apt_packages "$config"); then
        echo ""
        echo -e "${RED}System packages cannot be installed${NC}"
        echo "  orkestrator-ai.json's \"aptPackages\" must be a list of Debian package"
        echo "  names, such as [\"libvips-dev\", \"ffmpeg\"], with no control characters."
        printf '\033]9999;setup_failure_reason=apt-packages-refused\007'
        return 1
    fi
    local -a packages=()
    local name
    while IFS= read -r name; do
        if [ -n "$name" ]; then packages+=("$name"); fi
    done <<< "$listing"
    if [ "${#packages[@]}" -eq 0 ]; then
        echo "  No system packages declared"
        return 0
    fi

    echo ""
    echo -e "${BLUE}=== Installing System Packages ===${NC}"
    echo ""
    echo "  From Debian's archive (deb.debian.org): ${packages[*]}"
    echo ""

    local apt_exit=0
    run_apt_install "${packages[@]}" || apt_exit=$?
    echo ""
    if [ "$apt_exit" -eq 0 ]; then
        echo -e "${GREEN}System packages installed${NC}"
        return 0
    fi
    echo -e "${RED}System packages were not installed (code $apt_exit)${NC}"
    case "$apt_exit" in
        3)
            echo "  A package in \"aptPackages\" was refused; the reason is above. Packages that"
            echo "  could change the container's protections (sudo, firewalls, SSH servers)"
            echo "  are never installed, nor is anything an install would bring in from them."
            printf '\033]9999;setup_failure_reason=apt-packages-refused\007'
            ;;
        4)
            echo "  This container's firewall runs inside it, so a package's install scripts,"
            echo "  which run as root, could change it. Rebuild the environment on a current"
            echo "  image, which puts the firewall in a separate egress gateway, or set its"
            echo "  network access to Full."
            printf '\033]9999;setup_failure_reason=apt-packages-unsupported-runtime\007'
            ;;
        5)
            echo "  Debian's archive (deb.debian.org) could not be reached. Orkestrator opens it"
            echo "  for environments whose project declared packages when the container was"
            echo "  created; add deb.debian.org to this environment's allowed domains, or"
            echo "  rebuild it, then retry setup."
            printf '\033]9999;setup_failure_reason=apt-packages-archive-unreachable\007'
            ;;
        *)
            echo "  apt-get failed; its output is above."
            printf '\033]9999;setup_failure_reason=apt-packages-install-failed\007'
            ;;
    esac
    return "$apt_exit"
}

# Project seed files bound read-only. Under rootless Docker node cannot open an
# owner-only one; the root entrypoint then relayed it into node's own
# /run/orkestrator-inputs (network-policy-entrypoint.sh, relay_staged_inputs).
project_input() {
    if [ -e "/run/orkestrator-inputs/$1" ] && [ ! -L "/run/orkestrator-inputs/$1" ]; then
        printf '%s\n' "/run/orkestrator-inputs/$1"
    else
        printf '/%s\n' "$1"
    fi
}
PROJECT_ENV_INPUT="$(project_input project-env)"
OPENCODE_PROJECT_JSON_INPUT="$(project_input opencode-project-json)"

# Copy .env files to workspace
echo ""
echo -e "${BLUE}>>> Setting up environment files <<<${NC}"

if [ -d "$PROJECT_ENV_INPUT" ]; then
    if [ -f "$PROJECT_ENV_INPUT/.env" ]; then
        cp "$PROJECT_ENV_INPUT/.env" /workspace/.env
        echo -e "  ${GREEN}Copied .env from project folder${NC}"
    fi
    if [ -f "$PROJECT_ENV_INPUT/.env.local" ]; then
        cp "$PROJECT_ENV_INPUT/.env.local" /workspace/.env.local
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
if [ -f "$OPENCODE_PROJECT_JSON_INPUT" ]; then
    echo ""
    echo -e "${BLUE}>>> Setting up OpenCode configuration <<<${NC}"

    # Copy to workspace root
    cp "$OPENCODE_PROJECT_JSON_INPUT" /workspace/opencode.json

    # Add default model attribute if missing (use OPENCODE_MODEL env var or fallback to default)
    if ! jq -e '.model' /workspace/opencode.json > /dev/null 2>&1; then
        DEFAULT_MODEL="${OPENCODE_MODEL:-opencode/claude-sonnet-5}"
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

    # Declared packages first, then root steps, both before the regular
    # setup steps.
    cd /workspace
    run_project_apt_packages /workspace/orkestrator-ai.json || exit $?
    run_project_root_setup /workspace/orkestrator-ai.json /etc/orkestrator/network-mode || exit $?

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
