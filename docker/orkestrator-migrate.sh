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
# per-file path, mode, numeric owner, size and SHA-256 (hard links as the file
# they name), symlink targets, the directory count of a whole-tree copy, and
# `git fsck` when the destination holds a repository. The archive is extracted
# by GNU tar inside this container, which strips absolute paths, refuses `..`
# members and never follows symlinks already in the destination; the only
# host resource reachable from here is the candidate volume.
#
# Metadata policy: bytes, modes, numeric ownership (uid/gid), link targets and
# hard links are preserved and verified. FIFOs are recreated. Device nodes are
# refused (status=unsupported kind=device): they are never workspace data.
# Sockets are skipped (runtime artifacts). Extended attributes in the `user.`
# namespace and file capabilities are preserved (not verified); host labels
# such as `security.selinux` belong to the host's policy and are not copied.
# Sparse files are copied densely.
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
    printf '%s\n' "--strip-components=$strip" "--numeric-owner" "--xattrs" \
        "--xattrs-include=user.*" "--xattrs-include=security.capability"
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
            --to-command='printf "%s\t%s\t%s:%s\t%s\t%s\n" "$TAR_FILENAME" "$TAR_MODE" "$TAR_UID" "$TAR_GID" "$TAR_SIZE" "$(sha256sum | cut -d" " -f1)"' \
            > "$WORK/source.files" 2>/dev/null
    # Process substitutions finish asynchronously; wait for their outputs.
    for _ in $(seq 1 600); do
        [ -s "$WORK/extract.status" ] && break
        sleep 0.1
    done
    sleep 0.2
    # Device nodes are refused whatever extraction made of them (the
    # candidate is discarded on any failure).
    if awk '$1 ~ /^[bc]/ { found = 1 } END { exit !found }' "$WORK/raw-listing"; then
        result status=unsupported kind=device
        return 3
    fi
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
    # Apply the same component stripping to the listing as to extraction, to
    # a hard link's target as well as its name.
    awk -v strip="$strip" '
        function stripped(path,    i) {
            for (i = 0; i < strip; i++) { if (!sub(/^[^\/]*\/?/, "", path)) break }
            return path
        }
        {
            line = $0; prefix = line; sub(/^([^ ]+ +){5}/, "", line); head = substr(prefix, 1, length(prefix) - length(line));
            if ($1 ~ /^h/ && index(line, " link to ") > 0) {
                split(line, parts, " link to ");
                name = stripped(parts[1]); target = stripped(parts[2]);
                if (name == "") next;
                print head name " link to " target;
                next
            }
            line = stripped(line);
            if (line == "" || line ~ /^ -> /) next;
            print head line
        }' "$WORK/raw-listing" > "$WORK/listing"
    SELECTED=$([ "${#select[@]}" -gt 0 ] && echo 1 || echo 0)
    verify "$dst"
}

verify() {
    local dst="$1"
    # Hash in batches (one sha256sum per few hundred files, not a shell per
    # file) and join the digests to each file's path, mode and size.
    (
        cd "$dst" || exit 1
        find . -type f ! -path './.orkestrator/storage-marker.json' -printf '%P\t%#m\t%U:%G\t%s\n' | LC_ALL=C sort > "$WORK/dest.meta"
        find . -type f ! -path './.orkestrator/storage-marker.json' -print0 \
            | xargs -0 -r -n 256 sha256sum \
            | sed -E 's#^([0-9a-f]{64})  \./#\1\t#' \
            | awk -F'\t' '{ print $2 "\t" $1 }' | LC_ALL=C sort > "$WORK/dest.sums"
        LC_ALL=C join -t "$(printf '\t')" "$WORK/dest.meta" "$WORK/dest.sums"
    ) | sort > "$WORK/dest.files"
    # A hard link member carries no content of its own; it names a file the
    # stream already hashed, so it is expected with that file's entry.
    awk '$1 ~ /^h/ { line = $0; sub(/^([^ ]+ +){5}/, "", line); split(line, parts, " link to "); sub(/^\.\//, "", parts[1]); sub(/^\.\//, "", parts[2]); print parts[2] "\t" parts[1] }' "$WORK/listing" > "$WORK/hardlinks"
    sed 's#^\./##' "$WORK/source.files" > "$WORK/source.base"
    awk -F'\t' -v OFS='\t' 'FILENAME == ARGV[1] { links[$1] = links[$1] "\n" $2; next }
        { print; if ($1 in links) { n = split(substr(links[$1], 2), names, "\n"); for (i = 1; i <= n; i++) { $1 = names[i]; print } } }' \
        "$WORK/hardlinks" "$WORK/source.base" > "$WORK/source.all"
    # The storage marker is written by init, not copied.
    grep -v -P '^\.orkestrator/storage-marker\.json\t' "$WORK/source.all" | sort > "$WORK/source.sorted"
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
    source_dirs="$(awk '$1 ~ /^d/ { line = $0; sub(/^([^ ]+ +){5}/, "", line); sub(/^\.\//, "", line); if (line !~ /^\.orkestrator\/?$/) n++ } END { print n + 0 }' "$WORK/listing")"
    dest_dirs="$(cd "$dst" && find . -mindepth 1 -type d ! -path ./.orkestrator | wc -l)"
    # A selective copy creates parent directories the stream never named; a
    # whole-tree copy must reproduce exactly the directories it listed.
    if [ "${SELECTED:-0}" = 0 ] && [ "$source_dirs" != "$dest_dirs" ]; then
        result status=mismatch kind=dirs differing="$(( source_dirs > dest_dirs ? source_dirs - dest_dirs : dest_dirs - source_dirs ))"
        return 4
    fi
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
    bytes="$(awk -F'\t' '{ total += $4 } END { print total + 0 }' "$WORK/dest.files")"
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
        # Filesystems with dynamic inodes (btrfs, some overlay setups) report
        # a total of 0: that is "not limited", never "full", so it is omitted.
        inode_line="$(df --output=itotal,iavail "$2" 2>/dev/null | tail -n 1)"
        inode_total="$(echo "$inode_line" | awk '{ print $1 }')"
        inodes_available=""
        case "$inode_total" in ''|0|*[!0-9]*) ;; *) inodes_available="$(echo "$inode_line" | awk '{ print $2 }')" ;; esac
        echo "ORKESTRATOR_MEASURE bytes=$(du -sb "$2" 2>/dev/null | cut -f1) available=$(df -B1 --output=avail "$2" 2>/dev/null | tail -n 1 | tr -d ' ') inodes=$(du -s --inodes "$2" 2>/dev/null | cut -f1) inodes_available=${inodes_available}"
        ;;
    *)
        result status=usage
        exit 2
        ;;
esac
