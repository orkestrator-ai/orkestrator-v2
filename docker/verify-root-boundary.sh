#!/bin/bash
# Build-time check that node cannot get code run as root through the files
# root uses (security report finding H2). Run as root by the image build, after
# every file is installed.
#
# Root processes in a container are the backend's `docker exec --user root`
# calls (drain on stop, firewall edits, host repairs), the helper containers it
# runs as root, the sudo entrypoint, and uid-0 `orkroot` terminals. The backend
# gives each one a fixed root PATH, the root scripts reset PATH themselves,
# and root shells source no node-owned file (runtime-env.sh). That holds only
# while the directories involved stay root-owned, which is what this checks:
#
#   1. node can write only the trees listed in NODE_WRITABLE below. A new one
#      fails the build until it is added here with its reason.
#   2. Every command on a root PATH, followed through symlinks, is root-owned
#      and sits in root-owned directories outside those trees.
#   3. Root zsh's completion directories (fpath) are outside those trees.
#   4. sudo resets PATH (secure_path) to root-owned directories.
#   5. What `orkestrator-bridge-launch` runs as node, and the directory it
#      gives OpenCode for configuration, are root-owned all the way up: the
#      agent's uid must not be able to change the code a bridge or OpenCode
#      server loads before it starts.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Trees node owns or can write, by design:
#   /home/node, /workspace, /commandhistory   node's home, checkout and history
#   /usr/local/share/npm-global               `npm install -g` as node
#   /ms-playwright                            Playwright browsers; a project
#                                             pinning another version adds one
#   /run/orkestrator                          node's boot status and records
#   /tmp, /var/tmp, /run/lock                 sticky world-writable
NODE_WRITABLE=(
    /home/node /workspace /commandhistory
    /usr/local/share/npm-global /ms-playwright
    /run/orkestrator /tmp /var/tmp /run/lock
)
# Directories on a root PATH: the backend's fixed PATH for root execs, the
# root terminal's (runtime-env.sh ORKESTRATOR_ROOT_PATH) and sudo's
# secure_path. /usr/local/bin and /usr/local/sbin are on the last two.
ROOT_PATH_DIRS=(/usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin)

fail() {
    echo "verify-root-boundary: $*" >&2
    exit 1
}

node_gids=$(id -G node)
group_test=()
for gid in $node_gids; do
    group_test+=(-o \( -group "$gid" -perm -g+w \))
done

# True when node can write the path itself (not following a final symlink).
node_can_write() {
    [ -n "$(find "$1" -maxdepth 0 \( -user node -o \( ! -type l \( -perm -o+w "${group_test[@]}" \) \) \) -print -quit)" ]
}

inside_node_tree() {
    local path="$1" tree
    for tree in "${NODE_WRITABLE[@]}"; do
        case "$path/" in "$tree"/*) return 0 ;; esac
    done
    return 1
}

# The path and each directory above it is root-owned and not writable by node.
declare -A verified=()
root_owned_chain() {
    local path="$1"
    while :; do
        [ -n "${verified[$path]:-}" ] && return 0
        inside_node_tree "$path" && return 1
        node_can_write "$path" && return 1
        [ "$(stat -c %u "$path")" = 0 ] || return 1
        [ -d "$path" ] && verified[$path]=1
        [ "$path" = / ] && return 0
        path=$(dirname "$path")
    done
}

# 1. Nothing outside the listed trees is node-writable.
prune=(-path /proc -o -path /sys -o -path /dev)
for tree in "${NODE_WRITABLE[@]}"; do
    prune+=(-o -path "$tree")
done
stray=$(find / -xdev \( "${prune[@]}" \) -prune -o \
    \( -user node -o \( ! -type l \( -perm -o+w "${group_test[@]}" \) \) \) -print 2>/dev/null | head -n 20)
[ -z "$stray" ] || fail "node can write outside its listed trees:
$stray"

# 2. Every command on a root PATH resolves to a root-owned file in root-owned
# directories.
for dir in "${ROOT_PATH_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    root_owned_chain "$(readlink -f "$dir")" || fail "$dir is not root-owned all the way up"
    for entry in "$dir"/* "$dir"/.[!.]*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        target=$(readlink -f "$entry") || fail "$entry does not resolve"
        [ -e "$target" ] || continue
        root_owned_chain "$target" || fail "$entry resolves to $target, which node can change"
    done
done

# 3. Root zsh autoloads compinit and completion functions from fpath.
while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    root_owned_chain "$(readlink -f "$dir")" || fail "root's zsh fpath entry $dir is node-writable"
done < <(zsh -fc 'print -rl -- $fpath')

# 4. The sudo entrypoint inherits sudo's PATH.
secure_path=$(sed -n 's/^Defaults[[:space:]]\{1,\}secure_path="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/sudoers)
[ -n "$secure_path" ] || fail "sudo has no secure_path"
IFS=: read -r -a secure_dirs <<<"$secure_path"
for dir in "${secure_dirs[@]}"; do
    [ -d "$dir" ] || continue
    root_owned_chain "$(readlink -f "$dir")" || fail "sudo secure_path entry $dir is node-writable"
done

# 5. The launcher's programs and OpenCode's root configuration directories.
for path in /usr/local/bin/bun /opt/opencode/bin/opencode /opt/opencode/bin/opencode2 /run/orkestrator-opencode /run/orkestrator-opencode2; do
    [ -e "$path" ] || fail "$path is missing"
    root_owned_chain "$(readlink -f "$path")" || fail "$path is node-writable"
done

echo "verify-root-boundary: ok"
