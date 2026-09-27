#!/bin/bash
# Verified copy of environment state into a candidate storage set.
#
# Migration contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY persistent-workspace=1
#
# Runs as root in a short-lived helper container (entrypoint overridden, no
# network, only the candidate volume and, for volume sources, the read-only
# source volume mounted). It never runs in a workload container.
#
#   orkestrator-migrate.sh copy-stream <dst-dir> <strip> [wildcard…]   (tar on stdin)
#   orkestrator-migrate.sh copy-volume <src-dir> <dst-dir>
#   orkestrator-migrate.sh measure <dir>
#
# copy-stream extracts the archive into <dst-dir> and, in the same pass, hashes
# every regular file of the source stream. It then verifies the destination:
# per-file path, mode, size and SHA-256, symlink targets, directory count, and
# `git fsck` when the destination holds a repository. The archive is extracted
# by GNU tar inside this container, which strips absolute paths, refuses `..`
# members and never follows symlinks already in the destination; the only
# host resource reachable from here is the candidate volume.
#
# Metadata policy: bytes, modes, ownership (uid/gid) and link targets are
# preserved and verified. Sockets are skipped (runtime artifacts). Extended
# attributes are not preserved. Sparse files are copied densely.
#
# Output (last line, never file names):
#   ORKESTRATOR_COPY status=<ok|mismatch|extract-failed|usage> files=<n> bytes=<n> links=<n> dirs=<n> git=<ok|failed|none>
set -uo pipefail

result() {
    echo "ORKESTRATOR_COPY $*"
}

WORK="$(mktemp -d /tmp/orkestrator-copy.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

tar_filter_args() {
    local strip="$1"
    shift
    printf '%s\n' "--strip-components=$strip"
    if [ "$#" -gt 0 ]; then
        printf '%s\n' "--wildcards" "--no-wildcards-match-slash" "$@"
    fi
}

copy_stream() {
    local dst="$1" strip="$2"
    shift 2
    case "$strip" in ''|*[!0-9]*) result status=usage; return 2 ;; esac
    mkdir -p "$dst"
    mapfile -t filter < <(tar_filter_args "$strip" "$@")
    local select=()
    [ "$#" -gt 0 ] && select=(--wildcards --no-wildcards-match-slash "$@")
    # One read of the source feeds three consumers: extraction, the regular
    # file manifest and the listing used for symlinks and directories.
    tee >(tar -x -C "$dst" -f - "${filter[@]}" 2>"$WORK/extract.err"; echo "$?" > "$WORK/extract.status") \
        >(tar -tv -f - "${select[@]}" > "$WORK/raw-listing" 2>/dev/null) \
        | tar -x -f - "${filter[@]}" \
            --to-command='printf "%s\t%s\t%s\t%s\n" "$TAR_FILENAME" "$TAR_MODE" "$TAR_SIZE" "$(sha256sum | cut -d" " -f1)"' \
            > "$WORK/source.files" 2>/dev/null
    # Process substitutions finish asynchronously; wait for their outputs.
    for _ in $(seq 1 600); do
        [ -s "$WORK/extract.status" ] && break
        sleep 0.1
    done
    sleep 0.2
    if [ "$(cat "$WORK/extract.status" 2>/dev/null)" != "0" ]; then
        # A selection wildcard that matched nothing (for example no `-shm`
        # file) is not a failure; any other complaint is.
        if [ "${#select[@]}" -eq 0 ] || grep -v -E 'Not found in archive|Exiting with failure status due to previous errors' "$WORK/extract.err" | grep -q .; then
            result status=extract-failed
            return 3
        fi
    fi
    # Docker does not follow a symlink at the copied path, so a source root
    # that is a link would arrive as nothing. Refuse it rather than report an
    # empty copy as complete.
    if awk -v strip="$strip" 'NR == 1 { name = $0; sub(/^([^ ]+ +){5}/, "", name); sub(/ -> .*$/, "", name); n = split(name, parts, "/"); if ($1 ~ /^l/ && n <= strip) exit 0; exit 1 }' "$WORK/raw-listing"; then
        result status=root-symlink
        return 3
    fi
    # Apply the same component stripping to the listing as to extraction.
    awk -v strip="$strip" '{
        line = $0; prefix = line; sub(/^([^ ]+ +){5}/, "", line); head = substr(prefix, 1, length(prefix) - length(line));
        for (i = 0; i < strip; i++) { if (!sub(/^[^\/]*\/?/, "", line)) break }
        if (line == "" || line ~ /^ -> /) next;
        print head line
    }' "$WORK/raw-listing" > "$WORK/listing"
    verify "$dst"
}

verify() {
    local dst="$1"
    (
        cd "$dst" || exit 1
        find . -type f ! -path './.orkestrator/storage-marker.json' -printf '%P\t%#m\t%s\t' -exec sh -c 'sha256sum "$1" | cut -d" " -f1' _ {} \;
    ) | sort > "$WORK/dest.files"
    # The storage marker is written by init, not copied.
    grep -v -P '^\.orkestrator/storage-marker\.json\t' "$WORK/source.files" | sed 's#^\./##' | sort > "$WORK/source.sorted"
    if ! cmp -s "$WORK/source.sorted" "$WORK/dest.files"; then
        result status=mismatch kind=files differing="$(comm -3 "$WORK/source.sorted" "$WORK/dest.files" | wc -l)"
        return 4
    fi
    awk '$1 ~ /^l/ { sub(/^([^ ]+ +){5}/, ""); sub(/^\.\//, ""); print }' "$WORK/listing" | sort > "$WORK/source.links"
    (cd "$dst" && find . -type l -printf '%P -> %l\n') | sort > "$WORK/dest.links"
    if ! cmp -s "$WORK/source.links" "$WORK/dest.links"; then
        result status=mismatch kind=links differing="$(comm -3 "$WORK/source.links" "$WORK/dest.links" | wc -l)"
        return 4
    fi
    local source_dirs dest_dirs
    source_dirs="$(awk '$1 ~ /^d/ { n++ } END { print n + 0 }' "$WORK/listing")"
    dest_dirs="$(cd "$dst" && find . -mindepth 1 -type d ! -path ./.orkestrator | wc -l)"
    local git_state=none
    if [ -d "$dst/.git" ]; then
        if git -c safe.directory='*' -C "$dst" fsck --connectivity-only --no-progress >/dev/null 2>&1; then
            git_state=ok
        else
            git_state=failed
        fi
    fi
    local files bytes links
    files="$(wc -l < "$WORK/dest.files")"
    bytes="$(awk -F'\t' '{ total += $3 } END { print total + 0 }' "$WORK/dest.files")"
    links="$(wc -l < "$WORK/dest.links")"
    if [ "$git_state" = failed ]; then
        result status=mismatch kind=git files="$files" bytes="$bytes" links="$links" dirs="$dest_dirs" git=failed
        return 4
    fi
    result status=ok files="$files" bytes="$bytes" links="$links" dirs="$dest_dirs" source_dirs="$source_dirs" git="$git_state"
}

command="${1:-}"
case "$command" in
    copy-stream)
        [ "$#" -ge 3 ] || { result status=usage; exit 2; }
        shift
        copy_stream "$@"
        ;;
    copy-volume)
        [ "$#" -eq 3 ] || { result status=usage; exit 2; }
        tar -C "$2" --exclude=./.orkestrator/storage-marker.json -cf - . | copy_stream "$3" 1
        ;;
    measure)
        [ "$#" -eq 2 ] || { result status=usage; exit 2; }
        echo "ORKESTRATOR_MEASURE bytes=$(du -sb "$2" 2>/dev/null | cut -f1) available=$(df -B1 --output=avail "$2" 2>/dev/null | tail -n 1 | tr -d ' ')"
        ;;
    *)
        result status=usage
        exit 2
        ;;
esac
