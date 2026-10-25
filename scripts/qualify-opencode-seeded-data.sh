#!/bin/bash
# Live check that OpenCode in a container never needs the host data the
# entrypoint used to seed it with (`snapshot/`, `storage/`, `account.json` from
# ~/.local/share/opencode). Each variant runs scripts/opencode-seeded-data/
# probe.sh in a disposable, network-less container of <image> with the
# entrypoint overridden: a real `opencode serve` and one turn against a local
# mock model (a file write, the session diff, revert and unrevert) while
# inotify records every open under OpenCode's data directory. No credentials
# and no external provider are involved. Active-account variants use a synthetic
# SQLite console account and require its authenticated remote configuration.
#
#   scripts/qualify-opencode-seeded-data.sh <image>
#
# Variants: volume and legacy database paths, each with nothing seeded (what a
# container gets now) and with a current host's seed; plus an old host's seed
# without storage/migration. Both database paths also run with an active console
# account, with and without a host seed. Passes when every turn, diff, revert and unrevert
# works, no seeded snapshot directory or account.json is ever opened, a
# migrated seed is read only for storage/migration, and no host session is
# listed. Exits 0 on pass, 1 on a failed check, 2 on setup errors.
set -euo pipefail

IMAGE="${1:?usage: qualify-opencode-seeded-data.sh <image>}"
case "$IMAGE" in
    orkestrator-v2:latest | orkestrator-v2)
        echo "setup: use an isolated development image, never orkestrator-v2:latest" >&2
        exit 2
        ;;
esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker image inspect "$IMAGE" > /dev/null 2>&1 || { echo "setup: no image $IMAGE" >&2; exit 2; }

failures=0
check() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        echo "  ok   $label=$actual"
    else
        echo "  FAIL $label=$actual (expected $expected)"
        failures=$((failures + 1))
    fi
}

for variant in "volume none inactive" "legacy none inactive" "volume migrated inactive" "legacy migrated inactive" "volume unmigrated inactive" \
    "volume none active" "legacy none active" "volume migrated active" "legacy migrated active"; do
    read -r mode seed account <<< "$variant"
    output="$(docker run --rm --network none --entrypoint bash \
        --label orkestrator-qualification=opencode-seeded-data \
        -v "$ROOT/scripts/opencode-seeded-data:/probe:ro" \
        "$IMAGE" /probe/probe.sh "$mode" "$seed" "$account" 2>&1)" || {
        echo "$output" | tail -20 >&2
        echo "setup: probe failed for $variant" >&2
        exit 2
    }
    echo "$output" | grep -v '^RESULT '
    result() { echo "$output" | sed -n "s/^RESULT $1=//p"; }
    check turn "$(result turn)" stop
    check tools "$(result tools)" write:completed
    check diff "$(result diff)" written.txt
    check written "$(result written)" yes,no,yes
    check host_session_listed "$(result host_session_listed)" false
    if [ "$account" = active ]; then
        check console_authenticated "$(result console_authenticated)" yes
    fi
    check opened_account "$(result opened_account)" 0
    check opened_snapshot "$(result opened_snapshot)" 0
    case "$seed" in
        none) check opened_storage_migration "$(result opened_storage_migration)" 0 ;;
        # The active-account setup initializes SQLite before watching starts,
        # so its legacy-migration index has already been consumed.
        migrated) [ "$account" = active ] || check opened_storage_migration "$(result opened_storage_migration)" 1 ;;
    esac
    # An old host's seed has no migration index, so OpenCode runs its legacy
    # storage migrations over it; that is reported, not a failure.
    [ "$seed" = unmigrated ] || check opened_storage_other "$(result opened_storage_other)" 0
done

if [ "$failures" -gt 0 ]; then
    echo "FAIL: $failures check(s) failed"
    exit 1
fi
echo "PASS: OpenCode used none of the seeded host data"
