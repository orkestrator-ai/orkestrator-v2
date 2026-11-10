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
# The first write that succeeds says how many lines were lost before it.
wait_content "$work/missing/open.log" $'[orkestrator-log-writer] dropped 1 lines\nafter'
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
    wait_content "$work/write-recovery.log" $'[orkestrator-log-writer] dropped 1 lines\nafter'
    finish_writer
fi

# A failed rotation drops the line that needed it; a later line that fits
# goes to the file after a marker with the count, in the same run.
file="$work/rotate-marker.log"
mkdir -p "$file.1/occupied"
printf '%040d\n%080d\n%080d\n%020d\n' 1 2 3 4 | bash "$writer" "$file" 100 2
[ "$(cat "$file")" = "$(printf '%040d\n[orkestrator-log-writer] dropped 2 lines\n%020d' 1 4)" ] ||
    fail 'a failed rotation left no dropped-lines marker'

# A write cut short by the file size limit (a full disk behaves alike) loses
# the rest of that line and every line after it until a write succeeds:
# here, after rotation, into a new file. SIGXFSZ is ignored, as the limit
# would otherwise kill the writer instead of failing its write.
file="$work/fsize.log"
{ printf '%0599d\n' 1 2 3 4; } |
    bash -c 'trap "" XFSZ; ulimit -f 1; exec bash "$0" "$1" 2048 2' "$writer" "$file"
[ "$(wc -c <"$file.1")" -eq 1024 ] || fail 'the size limit did not cut the first file'
[ "$(cat "$file")" = "$(printf '[orkestrator-log-writer] dropped 2 lines\n%0599d' 4)" ] ||
    fail 'a failed write left no dropped-lines marker'

# Fail the initial write, then persist its marker and one complete data line
# plus a partial line before failing again. The next marker must count only
# the newly unwritten line, and both successful markers must affect rotation.
cat >"$work/modules/FailAfterMarker.pm" <<'PERL'
package FailAfterMarker;
my $calls = 0;
BEGIN {
    *CORE::GLOBAL::syswrite = sub {
        $calls++;
        if ($calls == 1) {
            open(my $ready, ">", $ENV{WRITER_FAILURE_READY}) or die $!;
            print $ready "ready\n";
            close $ready;
        }
        if ($calls == 1 || $calls == 3) { $! = 28; return undef; }
        my $length = $_[2];
        $length = index($_[1], "\n") + 1 + length("kept\npar") if $calls == 2;
        return CORE::syswrite($_[0], $_[1], $length, $_[3]);
    };
}
1;
PERL
file="$work/marker-data-failure.log"
rm -f "$work/input"
mkfifo "$work/input"
WRITER_FAILURE_READY="$work/failed" PERL5OPT=-MFailAfterMarker PERL5LIB="$work/modules" \
    bash "$writer" "$file" 100 2 <"$work/input" &
pid=$!
exec 3>"$work/input"
printf 'before\n' >&3
wait_content "$work/failed" ready
# One write(2), so the writer reads both lines at once: bash's printf flushes
# each line separately into a FIFO, and the injected failure counts writes.
perl -e 'syswrite(STDOUT, "kept\npartial\n") == 13 or exit 1' >&3
first=$'[orkestrator-log-writer] dropped 1 lines\nkept\npar'
wait_content "$file" "$first"
printf 'after\n' >&3
reported="$first"$'[orkestrator-log-writer] dropped 1 lines\nafter'
wait_content "$file" "$reported"
printf 'tail\n' >&3
wait_content "$file" tail
finish_writer
[ "$(cat "$file.1")" = "$reported" ] || fail 'successful markers were not accounted for in rotation'

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

# Limit PATH to cat, head and wc, forcing the no-Perl branch. Test success,
# the cap, open failure, and write failure with enough input to expose
# premature pipe closure.
mkdir "$work/bin"
for tool in cat head wc; do ln -s "$(command -v "$tool")" "$work/bin/$tool"; done
printf 'fallback\n' | PATH="$work/bin" /bin/bash "$writer" "$work/fallback.log"
wait_content "$work/fallback.log" fallback
# The cap counts what the file already holds, and the rest is drained.
for ((i = 0; i < 20000; i++)); do printf 'fallback line\n'; done |
    PATH="$work/bin" /bin/bash "$writer" "$work/fallback.log" 100
# A `head` that reads ahead would leave fewer bytes to count, hence the
# pattern for the count (GNU head reads no further than its limit).
expected="fallback
$(for ((i = 0; i < 6; i++)); do printf 'fallback line\n'; done)
fallbac"
[ "$(head -n 8 "$work/fallback.log")" = "$expected" ] ||
    fail 'the no-Perl fallback did not keep its first 100 bytes'
[ "$(wc -l <"$work/fallback.log")" -eq 9 ] &&
    tail -n 1 "$work/fallback.log" |
    grep -Eqx '\[orkestrator-log-writer\] dropped at least [0-9]+ bytes past 100' ||
    fail 'the no-Perl fallback did not end with a dropped-bytes marker'
# Repeated producers must still reach EOF without growing the capped file.
size=$(wc -c <"$work/fallback.log")
[ "$size" -le 228 ] || fail 'fallback marker exceeded its fixed allowance'
for ((run = 0; run < 4; run++)); do
    for ((i = 0; i < 20000; i++)); do printf 'repeated overflow\n'; done |
        PATH="$work/bin" /bin/bash "$writer" "$work/fallback.log" 100
    [ "$(wc -c <"$work/fallback.log")" -eq "$size" ] ||
        fail 'repeated fallback invocation grew the capped file'
done
# A file already at the data cap gets one notice; an oversized file is
# preserved without further appends. Neither path may stop draining input.
for initial in 100 300; do
    head -c "$initial" /dev/zero >"$work/existing.log"
    for ((run = 0; run < 3; run++)); do
        for ((i = 0; i < 20000; i++)); do printf 'existing overflow\n'; done |
            PATH="$work/bin" /bin/bash "$writer" "$work/existing.log" 100
        actual=$(wc -c <"$work/existing.log")
        if [ "$initial" -eq 300 ]; then
            [ "$actual" -eq 300 ] || fail 'oversized file grew on fallback'
        elif [ "$run" -eq 0 ]; then
            size="$actual"
            [ "$size" -gt 100 ] && [ "$size" -le 228 ] || fail 'missing bounded notice at cap'
        else
            [ "$actual" -eq "$size" ] || fail 'existing capped file grew on repeat'
        fi
    done
done
for ((i = 0; i < 20000; i++)); do printf 'fallback drop\n'; done |
    PATH="$work/bin" /bin/bash "$writer" "$work/absent/log" 2>/dev/null
if [ -c /dev/full ]; then
    for ((i = 0; i < 20000; i++)); do printf 'fallback drop\n'; done |
        PATH="$work/bin" /bin/bash "$writer" /dev/full 2>/dev/null
fi

echo 'log writer regression checks: passed'
