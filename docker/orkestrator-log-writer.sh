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
# One Perl process, not a `stdbuf fold | awk` pipeline. Each tool in that
# pipeline buffered a pipe its own way: mawk held its input until it had a
# few KiB unless run with `-W interactive`, and Rust coreutils' `fold` (Ubuntu
# 26.04) holds its output whatever `stdbuf` asks. Either way a quiet bridge's
# lines sat in a buffer instead of the file. Here each read is written before
# the next one; only a line still waiting for its newline is held, and never
# more than 64 KiB of it, so a producer that never writes a newline cannot
# grow the writer's memory. perl-base is Essential on Debian, so the image
# always has it.
if ! command -v perl >/dev/null 2>&1; then
    # A custom image without Perl: no rotation, but still bounded. Append up
    # to max-bytes less what the file already holds, then count the rest
    # while draining it, so the producer never sees a closed pipe. A failed
    # open or write leaves the rest to the count as well. At end of input a
    # marker says how much was dropped.
    size=0
    # Only a regular file has a size to read; /dev/full, say, reads forever.
    [ -f "$file" ] && size=$(( $(wc -c <"$file" 2>/dev/null || echo 0) ))
    room=$(( max > size ? max - size : 0 ))
    head -c "$room" >>"$file" 2>/dev/null || true
    dropped=$(( $(wc -c) ))
    if [ "$dropped" -gt 0 ]; then
        printf '\n[orkestrator-log-writer] dropped at least %s bytes past %s\n' "$dropped" "$max" \
            >>"$file" 2>/dev/null || true
    fi
    exit 0
fi
exec perl -e '
use strict;
use warnings;
use Errno qw(EINTR);
use Fcntl qw(O_WRONLY O_APPEND O_CREAT);

my ($file, $max, $keep) = @ARGV;
# A longer line is split here, before it is held, as `fold -b -w` did.
my $fold = 65536;
my $size = (-f $file ? -s _ : 0) || 0;
my ($log, $out, $buffer) = (undef, "", "");
# Lines lost to a failed open, write or rotation since the last write that
# succeeded. The next write that succeeds starts with a marker giving the
# count, so a gap (a full disk, say) is visible in the log itself. If the
# file never becomes writable again, the marker never appears. Accounting is
# not wound back for lost lines: $size running ahead of the file only makes
# the next rotation, which frees the oldest file, come sooner.
my $dropped = 0;

# A failed open or write drops that output; the next write tries again.
sub put {
    return unless length $out;
    my $data = $out;
    $data = "[orkestrator-log-writer] dropped $dropped lines\n$data" if $dropped;
    # The marker is not counted towards $size until written, so it can take
    # a file past max-bytes by its own length.
    my $marker = length($data) - length($out);
    $out = "";
    if (!$log && !sysopen($log, $file, O_WRONLY | O_APPEND | O_CREAT, 0600)) {
        undef $log;
        lost($data, 0, $marker);
        return;
    }
    my $offset = 0;
    while ($offset < length $data) {
        my $wrote = syswrite($log, $data, length($data) - $offset, $offset);
        if (!defined $wrote) {
            next if $! == EINTR;
            close $log;
            undef $log;
            lost($data, $offset, $marker);
            return;
        }
        $offset += $wrote;
    }
    $size += $marker;
    $dropped = 0;
}

# Counts the lines of $data from $offset on as dropped: every line not
# written whole. A marker that was written has reported its count.
sub lost {
    my ($data, $offset, $marker) = @_;
    if ($marker && $offset >= $marker) {
        $dropped = 0;
        $size += $marker;
    }
    my $from = $offset > $marker ? $offset : $marker;
    $dropped += (substr($data, $from) =~ tr/\n//);
}

sub rotate {
    put();
    close $log if $log;
    undef $log;
    for (my $i = $keep - 1; $i >= 1; $i--) {
        my $source = $i == 1 ? $file : "$file." . ($i - 1);
        next unless -e $source;
        return 0 unless rename($source, "$file.$i");
    }
    return 0 if $keep == 1 && -e $file && !truncate($file, 0);
    $size = 0;
    return 1;
}

sub line {
    my ($text) = @_;
    # One line larger than a whole file is cut, so it cannot defeat the bound.
    $text = substr($text, 0, $max > 32 ? $max - 32 : 0) . " [line truncated]"
        if length($text) + 1 > $max;
    my $n = length($text) + 1;
    # A failed rotation leaves the active file (and its accounting) intact.
    # Drop this line and retry on later input, while continuing to drain.
    if ($size > 0 && $size + $n > $max && !rotate()) {
        $dropped++;
        return;
    }
    $out .= "$text\n";
    $size += $n;
}

binmode STDIN;
while (1) {
    my $read = sysread(STDIN, $buffer, 65536, length $buffer);
    if (!defined $read) {
        next if $! == EINTR;
        last;
    }
    last if $read == 0;
    while (1) {
        my $at = index($buffer, "\n");
        if ($at >= 0 && $at <= $fold) {
            line(substr($buffer, 0, $at));
            substr($buffer, 0, $at + 1, "");
        } elsif (length($buffer) > $fold) {
            line(substr($buffer, 0, $fold));
            substr($buffer, 0, $fold, "");
        } else {
            last;
        }
    }
    put();
}
line($buffer) if length $buffer;
put();
' -- "$file" "$max" "$keep"
