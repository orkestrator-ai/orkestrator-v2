#!/bin/bash
# Size-rotated writer for bridge and server output.
#
# Bounded logs contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY bounded-logs=1
#
#   <process> 2>&1 | orkestrator-log-writer <file> [max-bytes] [files]
#
# The writer owns the open file, so rotation cannot lose writes the way a
# rename behind a still-writing process does: when the next line would take
# the file past max-bytes it is closed, shifted to <file>.1 (… <file>.N-1,
# oldest dropped) and a new file is opened. Defaults: 5 MiB, 3 files. It only
# ever writes a local file, so it cannot stall its producer on a network or a
# renderer, and it keeps draining its input until end of file whatever
# happens to the file, so the producer never sees a closed pipe.
set -u
file="${1:?usage: orkestrator-log-writer <file> [max-bytes] [files]}"
max="${2:-5242880}"
keep="${3:-3}"
case "$max$keep" in *[!0-9]*) echo "orkestrator-log-writer: sizes must be numbers" >&2; exit 2 ;; esac
[ "$keep" -ge 1 ] || keep=1
# The exec session that launched the producer may end; that is not a reason
# to stop draining.
trap '' HUP TERM
umask 077
# `fold` bounds a line before awk reads it: a producer that never writes a
# newline would otherwise have awk hold its whole output in memory. It is
# line-buffered, or a pipe would hold back the last few KiB of output — the
# lines a failure diagnosis needs.
stdbuf -oL fold -b -w 65536 | LC_ALL=C awk -v file="$file" -v max="$max" -v keep="$keep" '
function shell_quote(s) { gsub(/\047/, "\047\\\047\047", s); return "\047" s "\047" }
function rotate(   i, from, to) {
    close(file)
    for (i = keep - 1; i >= 1; i--) {
        from = (i == 1) ? file : file "." (i - 1)
        to = file "." i
        system("mv -f " shell_quote(from) " " shell_quote(to) " 2>/dev/null")
    }
    if (keep == 1) system(": > " shell_quote(file))
    size = 0
}
BEGIN {
    size = 0
    cmd = "stat -c %s " shell_quote(file) " 2>/dev/null"
    if ((cmd | getline existing) > 0) size = existing + 0
    close(cmd)
}
{
    # One line larger than a whole file is cut, so it cannot defeat the bound.
    if (length($0) + 1 > max) $0 = substr($0, 1, max - 32) " [line truncated]"
    n = length($0) + 1
    if (size > 0 && size + n > max) rotate()
    print >> file
    fflush(file)
    size += n
}
'
