#!/bin/bash
# Shared host/final-image regression checks. All fixtures are private to this run.
set -euo pipefail
writer="${1:?usage: log-writer-test.sh <writer>}"
work="$(mktemp -d)"
pid=""
cleanup() {
    if [ -n "$pid" ]; then
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    chmod -R u+rwX "$work"
    rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
wait_content() {
    local i
    for ((i = 0; i < 200; i++)); do
        if [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; then return; fi
        sleep 0.01
    done
    fail "expected content in $1: $2"
}
finish_writer() {
    exec 3>&-
    wait "$pid" || fail 'writer exited unsuccessfully'
    pid=""
}
start_writer() {
    rm -f "$work/input"
    mkfifo "$work/input"
    bash "$writer" "$1" 100 "${2:-3}" <"$work/input" &
    pid=$!
    exec 3>"$work/input"
}

# Explicitly prove that the final runtime can load every module used by the
# writer; a missing Perl must not silently pass through the cat fallback.
perl -Mstrict -Mwarnings -MErrno=EINTR -MFcntl=O_WRONLY,O_APPEND,O_CREAT -e 1

# Block the active rename with a directory; both existing and newly buffered
# bytes must remain covered by the bound. Removing the obstacle permits retry.
file="$work/rename.log"
mkdir "$file.1"
start_writer "$file" 2
printf '%090d\n' 0 >&3
wait_content "$file" "$(printf '%090d' 0)"
for ((i = 0; i < 20000; i++)); do printf 'dropped line\n'; done >&3
# This exceeds a pipe buffer, so the writer must drain despite repeated failure.
finish_writer
[ "$(wc -c <"$file")" -eq 91 ] || fail 'rename failure changed the active file'
rmdir "$file.1"
printf 'recovered\n' | bash "$writer" "$file" 100 2
[ "$(wc -c <"$file")" -le 100 ] || fail 'rename failure exceeded the bound'
[ "$(wc -c <"$file.1")" -le 100 ] || fail 'rename failure overflowed the archive'
grep -q recovered "$file" || fail 'rename recovery lost later output'

# Force keep=1 truncate to fail while append remains permitted. This exposes
# accounting errors regardless of the test user or host permission behavior.
file="$work/truncate.log"
printf '%090d\n' 0 >"$file"
# Override only truncate: open/append remains successful, which exposes the old
# accounting bug even when this test runs as root or on a read-only-file host.
mkdir "$work/modules"
cat >"$work/modules/FailTruncate.pm" <<'PERL'
package FailTruncate;
BEGIN { *CORE::GLOBAL::truncate = sub { $! = 13; return 0; }; }
1;
PERL
for ((i = 0; i < 1000; i++)); do printf 'dropped line\n'; done |
    PERL5OPT=-MFailTruncate PERL5LIB="$work/modules" bash "$writer" "$file" 100 1
[ "$(wc -c <"$file")" -eq 91 ] || fail 'truncate failure changed the active file'
printf 'recovered\n' | bash "$writer" "$file" 100 1
wait_content "$file" recovered

# Open failure must drain an input larger than a pipe, then a fresh run works.
for ((i = 0; i < 20000; i++)); do printf 'dropped line\n'; done |
    bash "$writer" "$work/missing/open.log" 100 1

# Live-pipe open recovery: the producer keeps its pipe open while the destination
# becomes available. Allow the first read to finish before repairing the path.
start_writer "$work/missing/open.log"
printf 'before\n' >&3
sleep 0.2
mkdir "$work/missing"
printf 'after\n' >&3
wait_content "$work/missing/open.log" after
finish_writer

# /dev/full opens successfully and fails at syswrite. Large input proves that
# this error path consumes through EOF, rather than exiting with SIGPIPE.
if [ -c /dev/full ]; then
    for ((i = 0; i < 20000; i++)); do printf 'failed write\n'; done |
        bash "$writer" /dev/full 1048576 1
fi

# Recover after a successful open followed by a failed syswrite, while stdin
# remains open. Removing /dev/full from the private path must cause a reopen.
if [ -c /dev/full ]; then
    ln -s /dev/full "$work/write-recovery.log"
    start_writer "$work/write-recovery.log"
    printf 'before\n' >&3
    sleep 0.2
    rm "$work/write-recovery.log"
    printf 'after\n' >&3
    wait_content "$work/write-recovery.log" after
    finish_writer
fi

# Signal the exact process spawned here only, after its first persisted line
# proves the shell has execed Perl and installed the ignored dispositions.
start_writer "$work/signals.log"
printf 'before\n' >&3
wait_content "$work/signals.log" before
kill -HUP "$pid"
printf 'after HUP\n' >&3
wait_content "$work/signals.log" $'before\nafter HUP'
kill -TERM "$pid"
printf 'after TERM\n' >&3
wait_content "$work/signals.log" $'before\nafter HUP\nafter TERM'
finish_writer

# Limit PATH to cat, forcing the no-Perl branch. Test success, open failure,
# and write failure with enough input to expose premature pipe closure.
mkdir "$work/bin"
ln -s "$(command -v cat)" "$work/bin/cat"
printf 'fallback\n' | PATH="$work/bin" /bin/bash "$writer" "$work/fallback.log"
wait_content "$work/fallback.log" fallback
for ((i = 0; i < 20000; i++)); do printf 'fallback drop\n'; done |
    PATH="$work/bin" /bin/bash "$writer" "$work/absent/log" 2>/dev/null
if [ -c /dev/full ]; then
    for ((i = 0; i < 20000; i++)); do printf 'fallback drop\n'; done |
        PATH="$work/bin" /bin/bash "$writer" /dev/full 2>/dev/null
fi

echo 'log writer regression checks: passed'
