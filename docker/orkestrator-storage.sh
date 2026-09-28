#!/bin/bash
# Storage-set helper for persistent environment volumes.
#
# Storage contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY persistent-workspace=1
#
# Runs as root in a short-lived helper container (entrypoint overridden, no
# network) with the storage set's volumes mounted under /storage/<role>. It
# never runs in the workload container and never deletes anything.
#
#   orkestrator-storage.sh init   <environment-id> <owner> <storage-set-id> <workspace-generation> <state-subdirs…>
#   orkestrator-storage.sh verify <environment-id> <owner> <storage-set-id>
#
# `init` initializes only an empty volume: it sets ownership once (no recursive
# chown of populated data on later starts), creates the provider state
# subdirectories, and writes a private marker. A volume that already carries a
# matching marker is left alone. A non-empty volume without a marker, or with a
# marker for another environment, is refused — never erased.
#
# Output (last line): ORKESTRATOR_STORAGE status=<code> [key=value…]
set -euo pipefail

FORMAT=1
NODE_UID=1000
NODE_GID=1000
MARKER_DIR=.orkestrator
MARKER_NAME=storage-marker.json

result() {
    echo "ORKESTRATOR_STORAGE $*"
}

marker_path() {
    echo "/storage/$1/$MARKER_DIR/$MARKER_NAME"
}

read_marker_field() {
    jq -r --arg key "$2" '.[$key] // empty' "$1" 2>/dev/null || true
}

is_empty_volume() {
    # lost+found appears on some block-backed volume drivers.
    [ -z "$(find "$1" -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit 2>/dev/null)" ]
}

check_marker() {
    local role="$1" environment="$2" owner="$3" set_id="$4"
    local marker
    marker="$(marker_path "$role")"
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
    [ "$(read_marker_field "$marker" format)" = "$FORMAT" ] || return 2
    [ "$(read_marker_field "$marker" environmentId)" = "$environment" ] || return 2
    [ "$(read_marker_field "$marker" owner)" = "$owner" ] || return 2
    [ "$(read_marker_field "$marker" storageSetId)" = "$set_id" ] || return 2
    [ "$(stat -c '%u' "/storage/$role")" = "$NODE_UID" ] || return 3
    return 0
}

roles() {
    find /storage -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
}

command="${1:-}"
case "$command" in
    init)
        [ "$#" -ge 5 ] || { result status=usage; exit 2; }
        environment="$2"; owner="$3"; set_id="$4"; generation="$5"; shift 5
        initialized=0
        for role in $(roles); do
            root="/storage/$role"
            if check_marker "$role" "$environment" "$owner" "$set_id"; then
                continue
            else
                code=$?
                if [ "$code" -eq 2 ]; then result status=foreign-marker role="$role"; exit 3; fi
                if [ "$code" -eq 3 ]; then result status=owner-mismatch role="$role"; exit 3; fi
            fi
            if ! is_empty_volume "$root"; then
                result status=unknown-content role="$role"
                exit 3
            fi
            chown "$NODE_UID:$NODE_GID" "$root"
            chmod 0755 "$root"
            if [ "$role" = "state" ]; then
                for subdir in "$@"; do
                    case "$subdir" in
                        ''|/*|*..*) result status=usage; exit 2 ;;
                    esac
                    install -d -o "$NODE_UID" -g "$NODE_GID" -m 0700 "$root/$subdir"
                done
            fi
            install -d -o "$NODE_UID" -g "$NODE_GID" -m 0700 "$root/$MARKER_DIR"
            tmp="$root/$MARKER_DIR/.$MARKER_NAME.tmp"
            jq -n --arg environment "$environment" --arg owner "$owner" --arg set "$set_id" \
                --arg role "$role" --argjson generation "$generation" --argjson format "$FORMAT" \
                '{format: $format, environmentId: $environment, owner: $owner, storageSetId: $set, role: $role, workspaceGeneration: $generation}' \
                > "$tmp"
            chown "$NODE_UID:$NODE_GID" "$tmp"
            chmod 0600 "$tmp"
            mv -f "$tmp" "$(marker_path "$role")"
            initialized=$((initialized + 1))
        done
        result status=ok initialized="$initialized"
        ;;
    verify)
        [ "$#" -eq 4 ] || { result status=usage; exit 2; }
        environment="$2"; owner="$3"; set_id="$4"
        for role in $(roles); do
            if check_marker "$role" "$environment" "$owner" "$set_id"; then
                continue
            else
                code=$?
                case "$code" in
                    1) result status=missing-marker role="$role" ;;
                    2) result status=foreign-marker role="$role" ;;
                    *) result status=owner-mismatch role="$role" ;;
                esac
                exit 3
            fi
        done
        result status=ok
        ;;
    *)
        result status=usage
        exit 2
        ;;
esac
