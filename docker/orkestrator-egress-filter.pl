#!/usr/bin/perl
# Name checks for a restricted runtime's egress gateway.
#
# Egress filter contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY egress-filter=1
#
# The firewall allows addresses, and an address on a shared edge serves many
# names. This daemon runs in the egress gateway (root, NET_ADMIN, its own PID
# and mount namespaces) and checks the name a connection asks for:
#
# - TCP to an allowed address: init-firewall.sh redirects every new
#   connection the workload opens to an allowed address and port to
#   the daemon's port on the namespace's own address. The daemon reads the original destination
#   (SO_ORIGINAL_DST), opens its own connection there and, before relaying a
#   byte the client sent, classifies the client's first bytes:
#     TLS ClientHello  the server_name must be allowed for that port;
#     HTTP/1.x request the Host header (and an absolute-form target) must be;
#     anything else    refused on TCP 443, relayed on any other allowed port
#                      (SSH to GitHub on 22, a database on its named port).
#   A first write of printable text with no newline yet is held, because a
#   request line sent a byte at a time (`G`, `GE`, `GET` ...) must not reach
#   the server before its Host is checked. A client-first text protocol on a
#   named port must therefore end its first command with a newline: a bare
#   word (`probe`, `{"op":1}`) is never relayed, and the connection is
#   refused with no reply after CLASSIFY_TIMEOUT. Binary first bytes,
#   server-first protocols and newline-terminated commands are not held.
#   Nothing is decrypted, and no certificate is involved. A refused TLS
#   client gets an access_denied alert, a refused HTTP client a 403.
# - DNS: every query the workload sends to any port 53 off loopback, and to
#   Docker's resolver, is redirected to the daemon's DNS port. Only allowlisted names (exact), GitHub's own names
#   and Docker's `*.docker.internal` names are forwarded; anything else is
#   answered REFUSED, with an Extended DNS Error (18, Prohibited) when the
#   query carried EDNS.
#
# The daemon's own sockets carry SO_MARK, which needs CAP_NET_ADMIN or
# CAP_NET_RAW. The gateway has the first and the workload neither (it drops
# NET_RAW), so only these sockets match the firewall's marked ACCEPT rules
# and escape the redirects. Failure is closed: with the daemon gone a
# redirected connection is refused and a query gets no answer.
#
# What a name check cannot see: an encrypted ClientHello (ECH) hides the
# inner name behind an outer one; domain fronting sends an allowed SNI and a
# different Host inside TLS; a kept-alive HTTP connection or an HTTP/2
# connection reused for another name is checked once; UDP entries (QUIC)
# and non-TLS, non-HTTP protocols on a named port are checked by address
# only; and an allowed service still accepts whatever data or credential it
# is sent.
#
# It counts the connections and queries it refuses since the gateway booted
# (--counts, shown in the firewall report), and never records a refused
# name: one can carry the data an agent tried to send.
#
# Usage (init-firewall.sh starts it):
#   orkestrator-egress-filter --names FILE --resolv FILE --mark N
#       --proxy-port N --dns-port N --ready FILE
#       [--counts FILE] [--quiet FILE] [--supervise]
use strict;
use warnings;
use Socket qw(:DEFAULT inet_aton inet_ntoa pack_sockaddr_in unpack_sockaddr_in
    IPPROTO_IP IPPROTO_TCP SOL_SOCKET SO_ERROR SO_LINGER SO_REUSEADDR SO_KEEPALIVE
    SOMAXCONN INADDR_LOOPBACK);
use IO::Poll qw(POLLIN POLLOUT POLLERR POLLHUP POLLNVAL);
use POSIX qw(EAGAIN EWOULDBLOCK EINPROGRESS EINTR);
use Fcntl qw(F_GETFL F_SETFL O_NONBLOCK);
use Time::HiRes qw(time);

use constant SO_MARK         => 36;
use constant SO_ORIGINAL_DST => 80;

# Fixed bounds.
use constant MAX_CONNECTIONS   => 256;    # proxied TCP connections
use constant MAX_DNS_TCP       => 32;     # concurrent DNS-over-TCP clients
use constant MAX_PENDING_DNS   => 1024;   # forwarded UDP queries in flight
use constant BUFFER_LIMIT      => 65536;  # bytes queued per direction
use constant READ_CHUNK        => 65536;  # worst case 256 x 2 x 128 KiB
use constant PEEK_LIMIT        => 32768;  # bytes read to classify a connection
use constant CLASSIFY_TIMEOUT  => 30;     # seconds to finish a ClientHello or header
use constant FIRST_BYTE_TIMEOUT => 60;    # seconds of silence on TCP 443
use constant DNS_TIMEOUT       => 2.5;    # per upstream attempt
use constant DNS_TCP_TIMEOUT   => 10;
use constant MAX_NAMES         => 4096;
use constant RELOAD_INTERVAL   => 1;
use constant MAX_COUNT         => 999_999_999_999_999;    # 15 digits, below 2**53
use constant QUIET_LIMIT       => 120;    # seconds a --quiet marker mutes counting

# Package variable, so a test that loads this file can point it at fixtures.
our %opt = (supervise => 0);

# ---------------------------------------------------------------------------
# Allowlist
# ---------------------------------------------------------------------------

my %allowed_ports;    # "name\ttcp:port" => 1
my %allowed_names;    # name => 1 (DNS: any port or protocol)
my $names_stamp = '';

sub load_names {
    my @stat = stat($opt{names});
    my $stamp = @stat ? join(':', @stat[0, 1, 7, 9]) : 'missing';
    return 0 if $stamp eq $names_stamp;
    my (%ports, %names);
    if (open(my $fh, '<', $opt{names})) {
        my $count = 0;
        while (my $line = <$fh>) {
            chomp $line;
            if ($line =~ /^dns ([a-z0-9][a-z0-9.-]{0,252})$/) {
                last if ++$count > MAX_NAMES;
                $names{$1} = 1;
                next;
            }
            next unless $line =~ /^([a-z0-9][a-z0-9.-]{0,252}) (tcp|udp):(\d{1,5})$/;
            last if ++$count > MAX_NAMES;
            $names{$1} = 1;
            $ports{"$1\t$2:$3"} = 1;
        }
        close $fh;
    }
    %allowed_ports = %ports;
    %allowed_names = %names;
    $names_stamp = $stamp;
    return 1;
}

# Checked before every decision, so an edit applies to the next query or
# connection; a name that left also loses its open connections.
sub refresh_names {
    revoke_connections() if load_names();
}

# GitHub's ranges are allowed by address on TCP 443 and 22 without a domain
# entry, so its own names are allowed there too. github.io (Pages) is not:
# it serves any account's site from the same addresses.
sub github_name {
    my ($name) = @_;
    return $name eq 'github.com'
        || $name =~ /\.(?:github\.com|githubusercontent\.com|githubassets\.com)$/;
}

sub docker_name {
    my ($name) = @_;
    return $name eq 'docker.internal' || $name =~ /\.docker\.internal$/;
}

sub normal_name {
    my ($name) = @_;
    return undef unless defined $name;
    $name = lc $name;
    $name =~ s/\.$//;
    return undef unless length($name) <= 253 && $name =~ /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;
    return $name;
}

sub name_allowed_on_port {
    my ($name, $port) = @_;
    return 1 if $allowed_ports{"$name\ttcp:$port"};
    return 1 if ($port == 443 || $port == 22) && github_name($name);
    return 0;
}

# ---------------------------------------------------------------------------
# Refusal counts
# ---------------------------------------------------------------------------

# Connections and DNS queries refused since the gateway booted, for the
# firewall report. Counts only: a refused name can carry the data an agent
# tried to send (`<secret>.attacker.tld`), so no name, part of one or digest
# of one is kept, logged or written. The --counts file is on the gateway's
# /run tmpfs: it starts empty on every boot and carries the counts across a
# worker restart within one (losing at most the last second's).
my %refused = (connections => 0, queries => 0);
my $refused_written;

# The firewall's own boot checks ask for names off the list on purpose and
# hold the --quiet marker while they run, so they are not counted. A marker
# left by a script that died stops muting after QUIET_LIMIT seconds.
sub counting {
    return 1 unless defined $opt{quiet};
    my @stat = stat($opt{quiet});
    return !@stat || time - $stat[9] > QUIET_LIMIT;
}

sub count_refusal {
    my ($kind) = @_;
    $refused{$kind}++ if $refused{$kind} < MAX_COUNT && counting();
}

sub refusals_text {
    return sprintf(qq({"refusedConnections":%d,"refusedQueries":%d}\n),
        $refused{connections}, $refused{queries});
}

sub load_refusals {
    return unless defined $opt{counts};
    open(my $fh, '<', $opt{counts}) or return;
    my $line = <$fh> // '';
    close $fh;
    if ($line =~ /^\{"refusedConnections":(\d{1,15}),"refusedQueries":(\d{1,15})\}\n?$/) {
        @refused{qw(connections queries)} = ($1 + 0, $2 + 0);
        $refused_written = refusals_text();
    }
}

# Rewritten at most once a RELOAD_INTERVAL, and only when a count moved. A
# failed write is retried on the next one; it never stops the worker.
sub write_refusals {
    return unless defined $opt{counts};
    my $text = refusals_text();
    return if defined $refused_written && $text eq $refused_written;
    my $tmp = "$opt{counts}.tmp.$$";
    my $fh;
    if (open($fh, '>', $tmp) && print({$fh} $text) && close($fh)
        && chmod(0644, $tmp) && rename($tmp, $opt{counts})) {
        $refused_written = $text;
    } else {
        unlink $tmp;
    }
}

# ---------------------------------------------------------------------------
# Resolvers
# ---------------------------------------------------------------------------

# Docker's embedded resolver (the `nameserver` lines of the gateway's
# protected copy of resolv.conf), and the upstreams it uses. When Docker
# names its upstreams by address it contacts them from inside this namespace,
# and the daemon asks them directly for a query that was sent off-host. When
# they are contacted from the host (`host(...)`), the embedded resolver is the
# only path and is used for everything.
my (@docker_resolvers, @external_resolvers);

sub load_resolvers {
    my (@nameservers, @ext);
    if (open(my $fh, '<', $opt{resolv})) {
        while (my $line = <$fh>) {
            if ($line =~ /^nameserver\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/) {
                push @nameservers, $1;
            } elsif ($line =~ /^# ExtServers: \[(.*)\]\s*$/) {
                for my $entry (split ' ', $1) {
                    push @ext, $entry if $entry =~ /^\d{1,3}(?:\.\d{1,3}){3}$/;
                }
            }
        }
        close $fh;
    }
    die "no resolver in $opt{resolv}\n" unless @nameservers;
    @docker_resolvers = @nameservers;
    @external_resolvers = @ext ? @ext : @nameservers;
}

# ---------------------------------------------------------------------------
# Sockets
# ---------------------------------------------------------------------------

my $poll = IO::Poll->new;

sub nonblocking {
    my ($fh) = @_;
    my $flags = fcntl($fh, F_GETFL, 0) or die "fcntl: $!\n";
    fcntl($fh, F_SETFL, $flags | O_NONBLOCK) or die "fcntl: $!\n";
}

sub marked_socket {
    my ($type) = @_;
    socket(my $fh, PF_INET, $type, 0) or return undef;
    # A socket that cannot carry the mark would be rejected by the firewall;
    # refuse it here instead of trying.
    unless (setsockopt($fh, SOL_SOCKET, SO_MARK, pack('L', $opt{mark}))) {
        close $fh;
        return undef;
    }
    nonblocking($fh);
    return $fh;
}

sub listener {
    my ($type, $port) = @_;
    socket(my $fh, PF_INET, $type, 0) or die "socket: $!\n";
    setsockopt($fh, SOL_SOCKET, SO_REUSEADDR, 1) or die "setsockopt: $!\n" if $type == SOCK_STREAM;
    # Every address in this namespace: loopback for queries to Docker's
    # resolver, the namespace's own address for everything init-firewall.sh
    # redirects there. The firewall admits nothing else from outside unless a
    # published port names this one, and then accept_connections refuses it.
    bind($fh, pack_sockaddr_in($port, INADDR_ANY)) or die "bind port $port: $!\n";
    listen($fh, SOMAXCONN) or die "listen: $!\n" if $type == SOCK_STREAM;
    nonblocking($fh);
    return $fh;
}

sub hard_close {
    my ($fh) = @_;
    return unless $fh;
    setsockopt($fh, SOL_SOCKET, SO_LINGER, pack('ii', 1, 0));
    $poll->remove($fh);
    close $fh;
}

sub soft_close {
    my ($fh) = @_;
    return unless $fh;
    $poll->remove($fh);
    close $fh;
}

# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

# ('need') until the ClientHello is complete, then ('ok', name) or ('bad').
sub tls_server_name {
    my ($buffer) = @_;
    my ($handshake, $offset) = ('', 0);
    while (1) {
        return ('need') if length($buffer) < $offset + 5;
        my ($type, undef, $length) = unpack('C n n', substr($buffer, $offset, 5));
        return ('bad') if $type != 22 || $length == 0;
        return ('need') if length($buffer) < $offset + 5 + $length;
        $handshake .= substr($buffer, $offset + 5, $length);
        $offset += 5 + $length;
        next if length($handshake) < 4;
        my ($message, $high, $low) = unpack('C C n', $handshake);
        my $size = ($high << 16) | $low;
        return ('bad') if $message != 1 || $size > PEEK_LIMIT;
        last if length($handshake) >= 4 + $size;
    }
    my ($high, $low) = unpack('x C n', $handshake);
    my $body = substr($handshake, 4, ($high << 16) | $low);
    my $at = 34;    # legacy_version, random
    my $skip = sub {
        my ($width) = @_;
        return 0 if length($body) < $at + $width;
        my $n = $width == 1 ? unpack('C', substr($body, $at, 1)) : unpack('n', substr($body, $at, 2));
        $at += $width + $n;
        return length($body) >= $at;
    };
    $skip->(1) && $skip->(2) && $skip->(1) or return ('bad');    # session id, suites, compression
    return ('bad') if length($body) < $at + 2;
    my $end = $at + 2 + unpack('n', substr($body, $at, 2));
    return ('bad') if $end > length($body);
    $at += 2;
    while ($at + 4 <= $end) {
        my ($type, $length) = unpack('n n', substr($body, $at, 4));
        $at += 4;
        return ('bad') if $at + $length > $end;
        if ($type == 0) {
            my $list = substr($body, $at, $length);
            return ('bad') if length($list) < 2;
            my $pos = 2;
            my $list_end = 2 + unpack('n', $list);
            return ('bad') if $list_end > length($list);
            while ($pos + 3 <= $list_end) {
                my ($kind, $size) = unpack('C n', substr($list, $pos, 3));
                $pos += 3;
                return ('bad') if $pos + $size > $list_end;
                if ($kind == 0) {
                    my $name = normal_name(substr($list, $pos, $size));
                    return $name ? ('ok', $name) : ('bad');
                }
                $pos += $size;
            }
            return ('bad');
        }
        $at += $length;
    }
    return ('bad');    # no server_name: nothing to check against
}

sub authority_host {
    my ($authority) = @_;
    return undef if $authority =~ /[@\s]/ || $authority =~ /^\[/;
    $authority =~ s/:\d{1,5}$//;
    return normal_name($authority);
}

# ('need') until the request head is complete, then ('ok', host) or ('bad').
sub http_host {
    my ($buffer) = @_;
    $buffer =~ s/^(?:\r?\n)+//;
    my $end = $buffer =~ /\r?\n\r?\n/ ? $-[0] : -1;
    return length($buffer) >= PEEK_LIMIT ? ('bad') : ('need') if $end < 0;
    my ($line, @headers) = split /\r?\n/, substr($buffer, 0, $end);
    return ('bad') unless defined $line;
    my ($method, $target) = $line =~ m{^([!#\$%&'*+.^_`|~0-9A-Za-z-]+)[ \t\x0b\x0c\r]+(\S+)[ \t\x0b\x0c\r]+HTTP/1\.[01]$} or return ('bad');
    return ('bad') if uc($method) eq 'CONNECT';
    my @hosts = map { /^host:[ \t]*(.*?)[ \t]*$/i ? ($1) : () } @headers;
    return ('bad') unless @hosts == 1;
    my $host = authority_host($hosts[0]) // return ('bad');
    if ($target =~ m{^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)}) {
        my $target_host = authority_host($1) // return ('bad');
        return ('bad') unless $target_host eq $host;
    }
    return ('ok', $host);
}

# ('tls'|'http'|'other'|'need', ...) for a connection's first client bytes.
sub classify {
    my ($buffer) = @_;
    my $first = ord(substr($buffer, 0, 1));
    return ('tls', tls_server_name($buffer)) if $first == 22;
    # Wait through fragmented blank preambles and request lines. A complete
    # non-HTTP command line (EHLO, USER, AUTH, etc.) can pass by address.
    my $head = $buffer;
    $head =~ s/^(?:\r?\n)+//;
    return ('need') if $head eq '' || $head eq "\r";
    if ($head =~ /^([^\n]*)\n/) {
        my $line = $1;
        return ('http', http_host($buffer)) if $line =~ /HTTP\//i
            || $line =~ /^(?:GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH)[ \t\x0b\x0c\r]/i;
        return ('other');
    }
    # A textual method followed by whitespace can still be an HTTP request
    # with raw UTF-8 target bytes. Never downgrade that partial line to raw.
    return ('need') if $head =~ /^[!#\$%&'*+.^_`|~0-9A-Za-z-]+[ \t\x0b\x0c\r]/
        || $head =~ /^[\x09\x0b\x0c\x0d\x20-\x7e]+$/;
    return ('other');
}

# ---------------------------------------------------------------------------
# Proxy
# ---------------------------------------------------------------------------

my %connections;    # fileno of either side => connection
my $connection_count = 0;

# TLS alert, fatal access_denied.
my $TLS_DENIED = pack('C n n C C', 21, 0x0303, 2, 2, 49);

sub http_denied {
    my ($host) = @_;
    my $body = "Orkestrator's egress gateway refused this request: the host is not on this environment's network allowlist.\n";
    return "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n"
        . "Content-Length: " . length($body) . "\r\nConnection: close\r\n\r\n$body";
}

sub drop_connection {
    my ($c, $hard) = @_;
    return if $c->{closed};
    $c->{closed} = 1;
    for my $side (qw(client upstream)) {
        my $fh = $c->{$side} or next;
        delete $connections{fileno($fh)};
        $hard ? hard_close($fh) : soft_close($fh);
    }
    $connection_count--;
}

# Sends a refusal the client can read, then closes.
sub refuse_connection {
    my ($c, $kind) = @_;
    count_refusal('connections');
    if ($c->{upstream}) {
        delete $connections{fileno($c->{upstream})};
        hard_close($c->{upstream});
        $c->{upstream} = undef;
    }
    my $message = $kind eq 'tls' ? $TLS_DENIED : $kind eq 'http' ? http_denied() : '';
    if (length $message) {
        # Best effort: a refusal is one small write on a fresh socket.
        syswrite($c->{client}, $message);
        shutdown($c->{client}, 1);
        drop_connection($c, 0);
    } else {
        drop_connection($c, 1);
    }
}

sub accept_connections {
    my ($listener) = @_;
    while (1) {
        my $address = accept(my $client, $listener);
        last unless $address;
        my $original = getsockopt($client, IPPROTO_IP, SO_ORIGINAL_DST);
        my ($port, $ip);
        # Perl returns its whole option buffer; the first 16 bytes are the
        # sockaddr_in. A plain copy, because unpack_sockaddr_in does not read
        # substr's lvalue.
        my $sockaddr = $original && length($original) >= 16 ? substr($original, 0, 16) : undef;
        ($port, $ip) = eval { unpack_sockaddr_in($sockaddr) } if defined $sockaddr;
        # A direct connection to the listener has no original destination
        # beyond the listener itself; only redirected connections proceed.
        if (!$ip || $connection_count >= MAX_CONNECTIONS || inet_ntoa($ip) =~ /^127\./
            || $port == $opt{proxy_port} || $port == $opt{dns_port}) {
            hard_close($client);
            next;
        }
        nonblocking($client);
        setsockopt($client, SOL_SOCKET, SO_KEEPALIVE, 1);
        my $upstream = marked_socket(SOCK_STREAM);
        if (!$upstream) {
            hard_close($client);
            next;
        }
        setsockopt($upstream, SOL_SOCKET, SO_KEEPALIVE, 1);
        my $connected = connect($upstream, pack_sockaddr_in($port, $ip));
        if (!$connected && $! != EINPROGRESS) {
            hard_close($upstream);
            hard_close($client);
            next;
        }
        my $c = {
            kind       => 'proxy',
            client     => $client,
            upstream   => $upstream,
            port       => $port,
            connecting => $connected ? 0 : 1,
            classified => 0,
            peek       => '',
            to_upstream => '',
            to_client  => '',
            created    => time,
            first_byte => 0,
        };
        $connections{fileno($client)} = $c;
        $connections{fileno($upstream)} = $c;
        $connection_count++;
        update_masks($c);
    }
}

sub update_masks {
    my ($c) = @_;
    return if $c->{closed};
    my $client_mask = 0;
    $client_mask |= POLLIN if !$c->{client_eof}
        && (!$c->{classified} ? length($c->{peek}) < PEEK_LIMIT : length($c->{to_upstream}) < BUFFER_LIMIT);
    $client_mask |= POLLOUT if length $c->{to_client};
    $poll->mask($c->{client} => $client_mask);
    return unless $c->{upstream};
    my $upstream_mask = 0;
    if ($c->{connecting}) {
        $upstream_mask = POLLOUT;
    } else {
        $upstream_mask |= POLLIN if !$c->{upstream_eof} && length($c->{to_client}) < BUFFER_LIMIT;
        $upstream_mask |= POLLOUT if length $c->{to_upstream};
    }
    $poll->mask($c->{upstream} => $upstream_mask);
}

sub decide {
    my ($c, $final) = @_;
    my ($kind, $result, $name) = classify($c->{peek});
    refresh_names();
    $result //= '';
    if ($kind eq 'need' || $result eq 'need') {
        refuse_connection($c, $kind eq 'need' ? 'other' : $kind) if $final;
        return;
    }
    if ($kind eq 'other') {
        # Not TLS and not HTTP: only an explicitly named port carries it.
        return refuse_connection($c, 'other') if $c->{port} == 443;
    } elsif ($result ne 'ok' || !name_allowed_on_port($name, $c->{port})) {
        return refuse_connection($c, $kind);
    } else {
        $c->{name} = $name;
    }
    $c->{classified} = 1;
    $c->{to_upstream} .= $c->{peek};
    $c->{peek} = '';
}

sub finish_half_close {
    my ($c) = @_;
    return if $c->{closed};
    if ($c->{client_eof} && $c->{classified} && !length($c->{to_upstream}) && !$c->{upstream_shut}
        && $c->{upstream} && !$c->{connecting}) {
        shutdown($c->{upstream}, 1);
        $c->{upstream_shut} = 1;
    }
    if ($c->{upstream_eof} && !length($c->{to_client}) && !$c->{client_shut}) {
        shutdown($c->{client}, 1);
        $c->{client_shut} = 1;
    }
    drop_connection($c, 0) if $c->{client_shut} && ($c->{upstream_shut} || !$c->{classified});
}

sub proxy_event {
    my ($c, $fh, $events) = @_;
    my $is_client = fileno($fh) == fileno($c->{client});
    if ($events & (POLLERR | POLLNVAL)) {
        return drop_connection($c, 1);
    }
    if (!$is_client && $c->{connecting}) {
        return unless $events & (POLLOUT | POLLHUP);
        my $error = unpack('i', getsockopt($fh, SOL_SOCKET, SO_ERROR) // pack('i', 1));
        return drop_connection($c, 1) if $error;
        $c->{connecting} = 0;
    }
    if ($events & POLLOUT) {
        my $buffer = $is_client ? \$c->{to_client} : \$c->{to_upstream};
        if (length $$buffer) {
            my $written = syswrite($fh, $$buffer);
            if (!defined $written) {
                return drop_connection($c, 1) unless transient();
            } else {
                substr($$buffer, 0, $written, '');
            }
        }
    }
    if ($events & (POLLIN | POLLHUP)) {
        my $read = sysread($fh, my $data, READ_CHUNK);
        if (!defined $read) {
            return drop_connection($c, 1) unless transient();
        } elsif ($read == 0) {
            if ($is_client) {
                $c->{client_eof} = 1;
                decide($c, 1) unless $c->{classified};
            } else {
                $c->{upstream_eof} = 1;
            }
        } elsif ($is_client) {
            if ($c->{classified}) {
                $c->{to_upstream} .= $data;
            } else {
                $c->{first_byte} ||= time;
                $c->{peek} .= $data;
                decide($c, length($c->{peek}) >= PEEK_LIMIT);
            }
        } else {
            # Server-first protocols (a database banner) reach the client
            # while its first bytes are still awaited and checked.
            $c->{to_client} .= $data;
        }
    }
    return if $c->{closed};
    finish_half_close($c);
    update_masks($c);
}

# Snapshot and deduplicate before a callback removes either side of a pair.
# A maintenance failure closes that connection, never the whole worker.
sub maintain_connections {
    my ($kind, $action) = @_;
    my %seen;
    my @snapshot = values %connections;
    for my $c (@snapshot) {
        next if !defined $c || $seen{$c}++ || $c->{closed} || $c->{kind} ne $kind;
        eval { $action->($c); 1 } or do {
            $kind eq 'proxy' ? drop_connection($c, 1) : dns_tcp_drop($c);
        };
    }
}

sub expire_connections {
    my $now = time;
    maintain_connections('proxy', sub {
        my ($c) = @_;
        return if $c->{classified};
        if ($c->{first_byte} && $now - $c->{first_byte} > CLASSIFY_TIMEOUT) {
            decide($c, 1);
        } elsif (!$c->{first_byte} && $c->{port} == 443 && $now - $c->{created} > FIRST_BYTE_TIMEOUT) {
            refuse_connection($c, 'other');
        }
    });
}

# A name that left loses its open connections, as an address leaving the set.
sub revoke_connections {
    maintain_connections('proxy', sub {
        my ($c) = @_;
        drop_connection($c, 1) if defined $c->{name} && !name_allowed_on_port($c->{name}, $c->{port});
    });
}

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------

my %pending;    # upstream query id => query in flight
my $dns_tcp_count = 0;

# (id, flags, name, question end, has EDNS) or () for a message that is not
# one ordinary query.
sub parse_query {
    my ($message) = @_;
    return () if length($message) < 17;
    my ($id, $flags, $qd, $an, $ns, $ar) = unpack('n6', $message);
    return () if ($flags & 0x8000) || $qd != 1;
    my ($at, $total, @labels) = (12, 0);
    while (1) {
        return () if $at >= length($message);
        my $size = ord(substr($message, $at, 1));
        $at++;
        last if $size == 0;
        return () if $size > 63 || ($total += $size + 1) > 255 || $at + $size > length($message);
        push @labels, substr($message, $at, $size);
        $at += $size;
    }
    return () if $at + 4 > length($message);
    $at += 4;
    my $name = @labels && !grep({ /[^A-Za-z0-9_-]/ } @labels) ? normal_name(join('.', @labels)) : undef;
    my $edns = $an == 0 && $ns == 0 && $ar >= 1 && length($message) >= $at + 11
        && substr($message, $at, 1) eq "\0" && unpack('n', substr($message, $at + 1, 2)) == 41;
    return ($id, $flags, $name, $at, $edns ? 1 : 0);
}

sub dns_answer {
    my ($message, $flags, $question_end, $edns, $rcode) = @_;
    my $id = unpack('n', $message);
    my $reply_flags = 0x8000 | ($flags & 0x7900) | 0x0080 | $rcode;
    my $reply = pack('n6', $id, $reply_flags, 1, 0, 0, $edns ? 1 : 0)
        . substr($message, 12, $question_end - 12);
    if ($edns) {
        my $ede = pack('n', $rcode == 5 ? 18 : 22)
            . ($rcode == 5 ? "not on this environment's network allowlist (Orkestrator egress gateway)" : 'no resolver answered');
        my $option = pack('n n', 15, length $ede) . $ede;
        $reply .= pack('C n n N n', 0, 41, 1232, 0, length $option) . $option;
    }
    return $reply;
}

# The resolvers a query may go to, or () when it is refused. An allowed
# query goes where it was sent: one sent to Docker's resolver (it arrives
# over loopback) to that resolver, one sent anywhere else to the upstreams.
# Docker relays a name it does not hold to its upstreams from this
# namespace, and that relay is redirected here as an off-loopback query, so
# it can never be sent back to Docker: no loop. Docker's own names are
# answered only for a query sent to Docker's resolver.
sub query_resolvers {
    my ($name, $from_loopback) = @_;
    return () unless defined $name;
    if (docker_name($name)) {
        return $from_loopback ? @docker_resolvers : ();
    }
    return () unless $allowed_names{$name} || github_name($name);
    return $from_loopback ? @docker_resolvers : @external_resolvers;
}

my $dns_udp;
my %udp_sockets; # fileno of a connected query socket => upstream id

sub dns_udp_query {
    while (1) {
        my $from = recv($dns_udp, my $message, 4096, 0);
        last unless defined $from && length $from;
        my ($id, $flags, $name, $question_end, $edns) = parse_query($message);
        next unless defined $id;
        refresh_names();
        my ($port, $address) = unpack_sockaddr_in($from);
        my @resolvers = query_resolvers($name, inet_ntoa($address) =~ /^127\./);
        if (!@resolvers || ($flags & 0x7800)) {
            count_refusal('queries');
            send($dns_udp, dns_answer($message, $flags, $question_end, $edns, 5), 0, $from);
            next;
        }
        next if keys(%pending) >= MAX_PENDING_DNS;
        my $upstream_id;
        do {
            open(my $random, '<', '/dev/urandom') or die "random: $!\n";
            read($random, my $bytes, 2) == 2 or die "random read: $!\n";
            close $random;
            $upstream_id = unpack('n', $bytes);
        } while exists $pending{$upstream_id};
        $pending{$upstream_id} = {
            client => $from, id => $id, message => $message, flags => $flags,
            question_end => $question_end, edns => $edns,
            resolvers => \@resolvers, attempt => 0, sent => time,
        };
        dns_send($upstream_id);
    }
}

sub close_query_socket {
    my ($query) = @_;
    if (my $fh = delete $query->{socket}) {
        delete $udp_sockets{fileno($fh)};
        soft_close($fh);
    }
}

sub dns_send {
    my ($upstream_id) = @_;
    my $query = $pending{$upstream_id};
    close_query_socket($query);
    my $resolver = $query->{resolvers}[$query->{attempt}];
    my $message = pack('n', $upstream_id) . substr($query->{message}, 2);
    $query->{sent} = time;
    my $fh = marked_socket(SOCK_DGRAM) or return;
    # A separate connected socket supplies a fresh ephemeral port and lets
    # the kernel reject datagrams from any other resolver endpoint.
    unless (connect($fh, pack_sockaddr_in(53, inet_aton($resolver)))) {
        soft_close($fh);
        return;
    }
    $query->{socket} = $fh;
    $udp_sockets{fileno($fh)} = $upstream_id;
    $poll->mask($fh => POLLIN);
    send($fh, $message, 0);
}

sub dns_response_matches {
    my ($message, $query, $id) = @_;
    return 0 if length($message) < $query->{question_end};
    my ($reply_id, $flags, $questions) = unpack('n3', $message);
    return $reply_id == $id && ($flags & 0x8000) && $questions == 1
        && ($flags & 0x7800) == ($query->{flags} & 0x7800)
        && substr($message, 12, $query->{question_end} - 12)
            eq substr($query->{message}, 12, $query->{question_end} - 12);
}

sub dns_udp_answer {
    my ($fh) = @_;
    my $upstream_id = $udp_sockets{fileno($fh)};
    my $query = $pending{$upstream_id} or return;
    while (1) {
        my $from = recv($fh, my $message, 65535, 0);
        last unless defined $from && length $from;
        my ($port, $address) = unpack_sockaddr_in($from);
        next unless $port == 53 && inet_ntoa($address) eq $query->{resolvers}[$query->{attempt}];
        next unless dns_response_matches($message, $query, $upstream_id);
        delete $pending{$upstream_id};
        close_query_socket($query);
        send($dns_udp, pack('n', $query->{id}) . substr($message, 2), 0, $query->{client});
        last;
    }
}

sub expire_queries {
    my $now = time;
    for my $upstream_id (keys %pending) {
        my $query = $pending{$upstream_id};
        next if $now - $query->{sent} < DNS_TIMEOUT;
        if (++$query->{attempt} < @{$query->{resolvers}}) {
            dns_send($upstream_id);
            next;
        }
        delete $pending{$upstream_id};
        close_query_socket($query);
        send($dns_udp, dns_answer($query->{message}, $query->{flags}, $query->{question_end}, $query->{edns}, 2),
            0, $query->{client});
    }
}

# DNS over TCP: one query at a time per client, each to its own upstream
# connection, so a refusal can never interleave with a relayed answer.
sub accept_dns_tcp {
    my ($listener) = @_;
    while (1) {
        my $address = accept(my $client, $listener);
        last unless $address;
        if ($dns_tcp_count >= MAX_DNS_TCP) {
            hard_close($client);
            next;
        }
        my ($port, $ip) = unpack_sockaddr_in($address);
        nonblocking($client);
        my $c = {
            kind => 'dns', client => $client, inbound => '', to_client => '', to_upstream => '',
            from_loopback => inet_ntoa($ip) =~ /^127\./ ? 1 : 0, deadline => time + DNS_TCP_TIMEOUT,
        };
        $connections{fileno($client)} = $c;
        $dns_tcp_count++;
        dns_tcp_masks($c);
    }
}

sub dns_tcp_drop {
    my ($c) = @_;
    return if $c->{closed};
    $c->{closed} = 1;
    for my $side (qw(client upstream)) {
        my $fh = $c->{$side} or next;
        delete $connections{fileno($fh)};
        soft_close($fh);
    }
    $dns_tcp_count--;
}

sub dns_tcp_masks {
    my ($c) = @_;
    return if $c->{closed};
    my $reading = !$c->{eof} && !$c->{upstream} && !length($c->{to_client})
        && length($c->{inbound}) < 65537;
    $poll->mask($c->{client} => ($reading ? POLLIN : 0) | (length $c->{to_client} ? POLLOUT : 0));
    if ($c->{upstream}) {
        $poll->mask($c->{upstream} => $c->{connecting} || length $c->{to_upstream} ? POLLOUT : POLLIN);
    }
}

sub dns_tcp_next {
    my ($c) = @_;
    # One outstanding response per client bounds the output to one DNS frame
    # (65535-byte payload plus its length), including a non-reading client.
    return if $c->{upstream} || length($c->{to_client}) || length($c->{inbound}) < 2;
    my $size = unpack('n', $c->{inbound});
    return if length($c->{inbound}) < 2 + $size;
    my $message = substr($c->{inbound}, 2, $size);
    substr($c->{inbound}, 0, 2 + $size, '');
    $c->{deadline} = time + DNS_TCP_TIMEOUT;
    my ($id, $flags, $name, $question_end, $edns) = parse_query($message);
    return dns_tcp_drop($c) unless defined $id;
    refresh_names();
    my @resolvers = query_resolvers($name, $c->{from_loopback});
    if (!@resolvers || ($flags & 0x7800)) {
        count_refusal('queries');
        my $reply = dns_answer($message, $flags, $question_end, $edns, 5);
        $c->{to_client} .= pack('n', length $reply) . $reply;
        return;
    }
    $c->{query} = { message => $message, flags => $flags, question_end => $question_end, edns => $edns };
    $c->{resolvers} = \@resolvers;
    $c->{attempt} = 0;
    dns_tcp_attempt($c);
}

sub dns_tcp_attempt {
    my ($c) = @_;
    if (my $old = delete $c->{upstream}) {
        delete $connections{fileno($old)};
        soft_close($old);
    }
    my $q = $c->{query};
    while ($c->{attempt} < @{$c->{resolvers}}) {
        my $resolver = $c->{resolvers}[$c->{attempt}++];
        my $upstream = marked_socket(SOCK_STREAM);
        next unless $upstream;
        my $connected = connect($upstream, pack_sockaddr_in(53, inet_aton($resolver)));
        if (!$connected && $! != EINPROGRESS) { soft_close($upstream); next; }
        $c->{upstream} = $upstream;
        $c->{connecting} = $connected ? 0 : 1;
        $c->{to_upstream} = pack('n', length $q->{message}) . $q->{message};
        $c->{answer} = '';
        $c->{deadline} = time + DNS_TIMEOUT;
        $connections{fileno($upstream)} = $c;
        dns_tcp_masks($c);
        return;
    }
    my $reply = dns_answer($q->{message}, $q->{flags}, $q->{question_end}, $q->{edns}, 2);
    $c->{to_client} .= pack('n', length $reply) . $reply;
    delete $c->{query};
    $c->{deadline} = time + DNS_TCP_TIMEOUT;
    dns_tcp_masks($c);
}

sub transient { return $! == EAGAIN || $! == EWOULDBLOCK || $! == EINTR; }

sub dns_tcp_event {
    my ($c, $fh, $events) = @_;
    return $fh == $c->{client} ? dns_tcp_drop($c) : dns_tcp_attempt($c) if $events & (POLLERR | POLLNVAL);
    if ($fh == $c->{client}) {
        if (($events & POLLOUT) && length $c->{to_client}) {
            my $written = syswrite($fh, $c->{to_client});
            return dns_tcp_drop($c) unless defined $written || transient();
            substr($c->{to_client}, 0, $written, '') if $written;
        }
        if (!$c->{eof} && !$c->{upstream} && !length($c->{to_client})
            && length($c->{inbound}) < 65537 && ($events & (POLLIN | POLLHUP))) {
            my $read = sysread($fh, my $data, READ_CHUNK);
            if (defined $read && $read == 0) {
                $c->{eof} = 1;
            } elsif ($read) {
                $c->{inbound} .= $data;
            } elsif (!transient()) {
                return dns_tcp_drop($c);
            }
        }
    } else {
        if ($c->{connecting}) {
            my $error = unpack('i', getsockopt($fh, SOL_SOCKET, SO_ERROR) // pack('i', 1));
            return dns_tcp_attempt($c) if $error;
            $c->{connecting} = 0;
        }
        if (length $c->{to_upstream}) {
            my $written = syswrite($fh, $c->{to_upstream});
            return dns_tcp_attempt($c) unless defined $written || transient();
            substr($c->{to_upstream}, 0, $written, '') if $written;
        } elsif ($events & (POLLIN | POLLHUP)) {
            my $read = sysread($fh, my $data, READ_CHUNK);
            return dns_tcp_attempt($c) if defined $read && $read == 0;
            return dns_tcp_attempt($c) if !defined $read && !transient();
            $c->{answer} .= $data if $read;
            return dns_tcp_attempt($c) if length($c->{answer}) > 65537;
            if (length($c->{answer}) >= 2 && length($c->{answer}) >= 2 + unpack('n', $c->{answer})) {
                my $reply = substr($c->{answer}, 2, unpack('n', $c->{answer}));
                return dns_tcp_attempt($c) unless dns_response_matches($reply, $c->{query}, unpack('n', $c->{query}{message}));
                $c->{to_client} .= pack('n', length $reply) . $reply;
                delete $c->{query};
                $c->{deadline} = time + DNS_TCP_TIMEOUT;
                delete $connections{fileno($fh)};
                soft_close($fh);
                $c->{upstream} = undef;
            }
        }
    }
    return if $c->{closed};
    dns_tcp_next($c);
    return if $c->{closed};
    # A client that has closed its side is done once its answers are out.
    return dns_tcp_drop($c) if $c->{eof} && !$c->{upstream} && !length $c->{to_client}
        && length($c->{inbound}) < 2;
    dns_tcp_masks($c);
}

sub expire_dns_tcp {
    my $now = time;
    maintain_connections('dns', sub {
        my ($c) = @_;
        $c->{upstream} ? dns_tcp_attempt($c) : dns_tcp_drop($c) if $now > $c->{deadline};
    });
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

sub run_worker {
    my ($proxy, $udp, $dns_tcp) = @_;
    $dns_udp = $udp;
    load_resolvers();
    load_names();
    load_refusals();
    write_refusals();
    $poll->mask($_ => POLLIN) for $proxy, $dns_udp, $dns_tcp;
    my $tmp = "$opt{ready}.tmp.$$";
    open(my $ready, '>', $tmp) or die "ready: $!\n";
    print {$ready} "$$\n";
    close $ready;
    rename($tmp, $opt{ready}) or die "ready: $!\n";
    my $last_check = time;
    while (1) {
        $poll->poll(0.5);
        for my $fh ($poll->handles(POLLIN | POLLOUT | POLLERR | POLLHUP | POLLNVAL)) {
            my $events = $poll->events($fh);
            next unless $events;
            if ($fh == $proxy) { accept_connections($proxy); next; }
            if ($fh == $dns_udp) { dns_udp_query(); next; }
            if (exists $udp_sockets{fileno($fh)}) { dns_udp_answer($fh); next; }
            if ($fh == $dns_tcp) { accept_dns_tcp($dns_tcp); next; }
            my $c = $connections{fileno($fh)} or next;
            next if $c->{closed};
            # One connection's malformed input must never end the daemon.
            eval {
                $c->{kind} eq 'proxy' ? proxy_event($c, $fh, $events) : dns_tcp_event($c, $fh, $events);
                1;
            } or do {
                $c->{kind} eq 'proxy' ? drop_connection($c, 1) : dns_tcp_drop($c);
            };
        }
        my $now = time;
        if ($now - $last_check >= RELOAD_INTERVAL) {
            $last_check = $now;
            refresh_names();
            expire_connections();
            expire_dns_tcp();
            write_refusals();
        }
        expire_queries();
    }
}

# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

sub parse_options {
    my @args = @_;
    while (@args) {
        my $arg = shift @args;
        if ($arg eq '--supervise') { $opt{supervise} = 1; next; }
        die "usage: missing value for $arg\n" unless @args;
        my $value = shift @args;
        if    ($arg eq '--names')      { $opt{names} = $value; }
        elsif ($arg eq '--resolv')     { $opt{resolv} = $value; }
        elsif ($arg eq '--mark')       { $opt{mark} = $value; }
        elsif ($arg eq '--proxy-port') { $opt{proxy_port} = $value; }
        elsif ($arg eq '--dns-port')   { $opt{dns_port} = $value; }
        elsif ($arg eq '--ready')      { $opt{ready} = $value; }
        elsif ($arg eq '--counts')     { $opt{counts} = $value; }
        elsif ($arg eq '--quiet')      { $opt{quiet} = $value; }
        else { die "usage: unknown option $arg\n"; }
    }
    for my $key (qw(names resolv mark proxy_port dns_port ready)) {
        die "usage: --" . ($key =~ s/_/-/r) . " is required\n" unless defined $opt{$key};
    }
    $opt{mark} = $opt{mark} =~ /^0x([0-9a-f]+)$/i ? hex($1) : $opt{mark};
    die "invalid mark\n" unless $opt{mark} =~ /^\d+$/ && $opt{mark} > 0 && $opt{mark} < 2**32;
    for my $key (qw(proxy_port dns_port)) {
        die "invalid $key\n" unless $opt{$key} =~ /^\d+$/ && $opt{$key} > 0 && $opt{$key} < 65536;
    }
}

sub main {
    parse_options(@ARGV);
    $SIG{PIPE} = 'IGNORE';
    # The supervisor holds these for its entire lifetime, including worker
    # restart gaps. In particular, UDP must never permit a second bind.
    my @listeners = (listener(SOCK_STREAM, $opt{proxy_port}),
        listener(SOCK_DGRAM, $opt{dns_port}), listener(SOCK_STREAM, $opt{dns_port}));

    # Restarts the worker when it exits, so one crash costs a second of
    # egress rather than all of it. The namespace stays closed in between.
    if ($opt{supervise}) {
        my $child = 0;
        $SIG{TERM} = $SIG{INT} = sub { kill 'TERM', $child if $child; exit 0; };
        while (1) {
            unlink $opt{ready};
            my $pid = fork();
            if (!defined $pid) { sleep 1; next; }
            if ($pid == 0) {
                $SIG{TERM} = $SIG{INT} = 'DEFAULT';
                run_worker(@listeners);
                exit 0;
            }
            $child = $pid;
            waitpid($pid, 0);
            unlink $opt{ready};
            $child = 0;
            sleep 1;
        }
    }
    run_worker(@listeners);
    exit 0;
}

# Loaded by a test (`require`), only the functions are defined.
main() unless caller;
1;
