/**
 * The egress gateway's name-check daemon (docker/orkestrator-egress-filter.pl),
 * loaded as a library: its ClientHello, HTTP and DNS parsing and its name
 * rules, connected DNS state and socket-backed maintenance. A real container run is in
 * apps/backend/tests/container-live-egress-filter.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./firewall-test-support";

const DAEMON = join(root, "docker/orkestrator-egress-filter.pl");
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ork-egress-filter-"));
  writeFileSync(
    join(dir, "names"),
    [
      "registry.npmjs.org tcp:443",
      "db.example.test tcp:5432",
      "Bad Line",
      "quic.test udp:443",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "resolv-host"),
    "nameserver 127.0.0.11\noptions ndots:0\n# ExtServers: [host(192.168.65.7)]\n",
  );
  writeFileSync(
    join(dir, "resolv-ip"),
    "nameserver 127.0.0.11\n# ExtServers: [203.0.113.53 198.51.100.53 host(10.0.0.1)]\n",
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Runs Perl with the daemon loaded; `ARGV` carries hex inputs. */
function perl(code: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [
      "perl",
      "-e",
      `require ${JSON.stringify(DAEMON)}; $main::opt{names} = ${JSON.stringify(join(dir, "names"))}; main::load_names(); ${code}`,
      "--",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

const u16 = (value: number) => Buffer.from([value >> 8, value & 255]);

function clientHello(serverName: string | null): Buffer {
  const extensions: Buffer[] = [];
  if (serverName !== null) {
    const name = Buffer.from(serverName);
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    const list = Buffer.concat([u16(entry.length), entry]);
    extensions.push(Buffer.concat([u16(0), u16(list.length), list]));
  }
  // supported_versions (TLS 1.3), so the extension walk passes another one.
  extensions.push(Buffer.concat([u16(43), u16(3), Buffer.from([2, 3, 4])]));
  const all = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([32]),
    Buffer.alloc(32, 9),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(all.length),
    all,
  ]);
  return Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
}

const record = (handshake: Buffer) =>
  Buffer.concat([Buffer.from([22, 3, 1]), u16(handshake.length), handshake]);

const sni = (bytes: Buffer) =>
  perl('print join("|", main::tls_server_name(pack("H*", $ARGV[0])));', bytes.toString("hex"));

describe("TLS server_name", () => {
  test("reads the name from a ClientHello, lower-cased and without a trailing dot", () => {
    expect(sni(record(clientHello("Registry.NPMJS.org.")))).toBe("ok|registry.npmjs.org");
  });

  test("waits for a ClientHello split across records, then reads it", () => {
    const handshake = clientHello("registry.npmjs.org");
    const split = Buffer.concat([
      record(handshake.subarray(0, 20)),
      record(handshake.subarray(20)),
    ]);
    expect(sni(split.subarray(0, 30))).toBe("need");
    expect(sni(split)).toBe("ok|registry.npmjs.org");
  });

  test("refuses a ClientHello without a name, and anything that is not one", () => {
    expect(sni(record(clientHello(null)))).toBe("bad");
    expect(sni(Buffer.from([22, 3, 1, 0, 4, 2, 0, 0, 0]))).toBe("bad");
    expect(sni(record(clientHello("bad name.test")))).toBe("bad");
  });
});

const http = (head: string) =>
  perl(
    'print join("|", main::http_host(pack("H*", $ARGV[0])));',
    Buffer.from(head).toString("hex"),
  );

describe("HTTP Host", () => {
  test("reads one Host header, without its port", () => {
    expect(http("GET / HTTP/1.1\r\nHost: Registry.npmjs.org:80\r\nAccept: */*\r\n\r\n")).toBe(
      "ok|registry.npmjs.org",
    );
  });

  test("waits for the end of the head", () => {
    expect(http("GET / HTTP/1.1\r\nHost: registry.npmjs.org")).toBe("need");
  });

  test("refuses a missing or repeated Host, CONNECT, and an absolute target naming another host", () => {
    expect(http("GET / HTTP/1.1\r\nAccept: */*\r\n\r\n")).toBe("bad");
    expect(http("GET / HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n")).toBe("bad");
    expect(http("CONNECT a.test:443 HTTP/1.1\r\nHost: a.test\r\n\r\n")).toBe("bad");
    expect(http("GET http://evil.test/ HTTP/1.1\r\nHost: a.test\r\n\r\n")).toBe("bad");
    expect(http("GET http://a.test/x HTTP/1.1\r\nHost: a.test\r\n\r\n")).toBe("ok|a.test");
    expect(http("GET / HTTP/1.1\r\nHost: user@a.test\r\n\r\n")).toBe("bad");
  });
});

describe("classification", () => {
  const classify = (bytes: string) =>
    perl(
      'print join("|", map { $_ // "" } main::classify(pack("H*", $ARGV[0])));',
      Buffer.from(bytes).toString("hex"),
    );

  test("tells TLS, HTTP and anything else apart", () => {
    expect(classify("SSH-2.0-OpenSSH_9.6\r\n")).toBe("other");
    expect(classify("GE")).toBe("need");
    expect(classify("GET / HTTP/1.1\r\nHost: a.test\r\n\r\n")).toBe("http|ok|a.test");
    expect(classify("\u0000\u0000\u0000\u0008")).toBe("other");
  });

  test("recognizes HTTP preambles, method case and whitespace across every byte split", () => {
    for (const request of [
      "\r\nGET / HTTP/1.1\r\nHost: tenant.invalid\r\n\r\n",
      "\r\n\r\nget / HTTP/1.1\r\nHost: tenant.invalid\r\n\r\n",
      "GET\t/\tHTTP/1.1\r\nHost: tenant.invalid\r\n\r\n",
      "custom / HTTP/1.1\r\nHost: tenant.invalid\r\n\r\n",
      "GET /é/🦊 HTTP/1.1\r\nHost: tenant.invalid\r\n\r\n",
      "custom /é HTTP/1.1\r\nHost: tenant.invalid\r\n\r\n",
      "\nGET / HTTP/1.1\nHost: tenant.invalid\n\n",
    ]) {
      expect(classify(request)).toBe("http|ok|tenant.invalid");
      expect(
        perl(
          `
        my $request = pack("H*", $ARGV[0]);
        for my $n (1 .. length($request) - 1) {
          my ($kind) = main::classify(substr($request, 0, $n));
          die "premature raw relay at $n" if $kind eq 'other';
        }
        print 'ok';`,
          Buffer.from(request).toString("hex"),
        ),
      ).toBe("ok");
    }
    expect(classify("gEt / HTTP/9.9\r\nHost: tenant.invalid\r\n\r\n")).toBe("http|bad");
  });

  test("releases complete client-first protocol commands without waiting for HTTP headers", () => {
    for (const line of ["EHLO mail.test", "USER alice", "AUTH secret", "PING"]) {
      expect(classify(`${line}\r\n`)).toBe("other");
    }
  });

  test("holds printable text until a newline, even text that can never become a method", () => {
    // A request line sent a byte at a time must not be relayed before its
    // Host is read, so no newline-less printable write is released early
    // (to-do 7000, retired 2026-11-11, kept it; documented in docker/AGENTS.md).
    for (const write of ["probe", "PING", '{"op":1}', "hello world"]) {
      expect(classify(write)).toBe("need");
      expect(classify(`${write}\n`)).toBe("other");
    }
  });

  test("allows a name only on the ports its entries name, and GitHub's names on 443 and 22", () => {
    const allowed = (name: string, port: number) =>
      perl(`print main::name_allowed_on_port("${name}", ${port}) ? 1 : 0;`);
    expect(allowed("registry.npmjs.org", 443)).toBe("1");
    expect(allowed("registry.npmjs.org", 80)).toBe("0");
    expect(allowed("db.example.test", 5432)).toBe("1");
    expect(allowed("quic.test", 443)).toBe("0");
    expect(allowed("codeload.github.com", 443)).toBe("1");
    expect(allowed("objects.githubusercontent.com", 22)).toBe("1");
    expect(allowed("github.com", 8443)).toBe("0");
    // GitHub Pages serves any account's site from GitHub's addresses.
    expect(allowed("attacker.github.io", 443)).toBe("0");
    expect(allowed("evilgithub.com", 443)).toBe("0");
  });
});

function query(name: string, options: { edns?: boolean; flags?: number } = {}): string {
  const labels = name
    .split(".")
    .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const question = Buffer.concat([...labels, Buffer.from([0]), u16(1), u16(1)]);
  const opt = options.edns
    ? Buffer.concat([Buffer.from([0]), u16(41), u16(1232), Buffer.alloc(4), u16(0)])
    : Buffer.alloc(0);
  const header = Buffer.concat([
    u16(0x1234),
    u16(options.flags ?? 0x0100),
    u16(1),
    u16(0),
    u16(0),
    u16(options.edns ? 1 : 0),
  ]);
  return Buffer.concat([header, question, opt]).toString("hex");
}

describe("DNS", () => {
  const resolvers = (resolv: string, name: string, loopback: boolean) =>
    perl(
      `$main::opt{resolv} = ${JSON.stringify(join(dir, resolv))}; main::load_resolvers(); print join(",", main::query_resolvers(main::normal_name("${name}"), ${loopback ? 1 : 0}));`,
    );

  test("forwards an allowed name where it was sent, and refuses everything else", () => {
    // Docker contacts its upstreams from the host: its resolver is the only path.
    expect(resolvers("resolv-host", "registry.npmjs.org", true)).toBe("127.0.0.11");
    expect(resolvers("resolv-host", "registry.npmjs.org", false)).toBe("127.0.0.11");
    // Docker names its upstreams by address: an off-host query goes to them.
    expect(resolvers("resolv-ip", "registry.npmjs.org", true)).toBe("127.0.0.11");
    expect(resolvers("resolv-ip", "registry.npmjs.org", false)).toBe("203.0.113.53,198.51.100.53");
    // Any port or protocol of an entry makes its name resolvable.
    expect(resolvers("resolv-ip", "quic.test", true)).toBe("127.0.0.11");
    expect(resolvers("resolv-ip", "api.github.com", true)).toBe("127.0.0.11");
    expect(resolvers("resolv-ip", "c2VjcmV0.exfil.attacker.invalid", true)).toBe("");
    expect(resolvers("resolv-ip", "sub.registry.npmjs.org", true)).toBe("");
  });

  test("answers Docker's own names only for a query sent to Docker's resolver", () => {
    expect(resolvers("resolv-ip", "host.docker.internal", true)).toBe("127.0.0.11");
    expect(resolvers("resolv-ip", "host.docker.internal", false)).toBe("");
  });

  test("parses one ordinary query and refuses with an Extended DNS Error", () => {
    const parsed = perl(
      'my @q = main::parse_query(pack("H*", $ARGV[0])); print join("|", @q[0, 2, 4]);',
      query("Exfil.Attacker.invalid", { edns: true }),
    );
    expect(parsed).toBe(`${0x1234}|exfil.attacker.invalid|1`);
    const answer = perl(
      'my $m = pack("H*", $ARGV[0]); my @q = main::parse_query($m); print unpack("H*", main::dns_answer($m, $q[1], $q[3], $q[4], 5));',
      query("exfil.attacker.invalid", { edns: true }),
    );
    const bytes = Buffer.from(answer, "hex");
    expect(bytes.readUInt16BE(0)).toBe(0x1234);
    // Response, recursion desired echoed, recursion available, REFUSED.
    expect(bytes.readUInt16BE(2)).toBe(0x8185);
    expect(bytes.readUInt16BE(10)).toBe(1);
    expect(bytes.toString("latin1")).toContain("not on this environment's network allowlist");
    // EDE option 15, info code 18 (Prohibited).
    expect(answer).toContain("000f");
    expect(answer).toContain("0012");
  });

  test("ignores responses, several questions and malformed names", () => {
    const parse = (hex: string) =>
      perl('print scalar(my @q = main::parse_query(pack("H*", $ARGV[0])));', hex);
    expect(parse(query("a.test", { flags: 0x8180 }))).toBe("0");
    expect(parse(query("a.test").slice(0, 20))).toBe("0");
    const twoQuestions = Buffer.from(query("a.test"), "hex");
    twoQuestions.writeUInt16BE(2, 4);
    expect(parse(twoQuestions.toString("hex"))).toBe("0");
    // A label with a dot inside it is a name no allowlist entry can match.
    const dotted = perl(
      'my @q = main::parse_query(pack("H*", $ARGV[0])); print defined $q[2] ? $q[2] : "undef";',
      Buffer.concat([
        Buffer.from(query("a.test"), "hex").subarray(0, 12),
        Buffer.from([3]),
        Buffer.from("a.b"),
        Buffer.from([4]),
        Buffer.from("test"),
        Buffer.from([0]),
        u16(1),
        u16(1),
      ]).toString("hex"),
    );
    expect(dotted).toBe("undef");
  });
});

/** Append a harness in the daemon's lexical scope, without a production test API. */
function runtimePerl(code: string, prelude = ""): string {
  const source = readFileSync(DAEMON, "utf8").replace("main() unless caller;", "");
  const result = Bun.spawnSync({
    cmd: ["perl", "-e", `${prelude}\n${source}\n${code}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

describe("DNS reply authentication and failover", () => {
  test("requires the response bit, id, opcode and exact original question", () => {
    expect(
      perl(
        `
      my $message = pack('H*', $ARGV[0]);
      my ($id, $flags, undef, $end) = main::parse_query($message);
      my $q = { message => $message, flags => $flags, question_end => $end };
      my $reply = main::dns_answer($message, $flags, $end, 0, 0);
      print main::dns_response_matches($reply, $q, $id) ? 'yes' : 'no';
      for my $bad ($message, substr($reply, 0, -1),
          pack('n', $id + 1) . substr($reply, 2),
          substr($reply, 0, 2) . pack('n', 0x8980) . substr($reply, 4),
          substr($reply, 0, -1) . pack('C', 2)) {
        die 'accepted forged response' if main::dns_response_matches($bad, $q, $id);
      }`,
        query("registry.npmjs.org"),
      ),
    ).toBe("yes");
  });

  const tcpHarness = () => `
    $opt{names} = ${JSON.stringify(join(dir, "names"))};
    $opt{resolv} = ${JSON.stringify(join(dir, "resolv-ip"))};
    load_names(); load_resolvers();
    socketpair(my $client, my $reader, PF_UNIX, SOCK_STREAM, 0) or die $!;
    nonblocking($client);
    my $message = pack('H*', '${query("registry.npmjs.org")}');
    my $c = { kind => 'dns', client => $client, inbound => pack('n', length $message) . $message,
      to_client => '', from_loopback => 0, deadline => time + 10 };
    $connections{fileno($client)} = $c; $dns_tcp_count++;
    my @peers;
    no warnings 'redefine';
    local *main::marked_socket = sub {
      socketpair(my $out, my $peer, PF_UNIX, SOCK_STREAM, 0) or die $!;
      nonblocking($out); push @peers, $peer; return $out;
    };
    dns_tcp_next($c);
  `;
  const connectPrelude = `our @destinations;
    BEGIN { *CORE::GLOBAL::connect = sub { push @main::destinations, $_[1]; return 1; }; }`;

  test("retries another protected resolver on TCP error or deadline, then relays its answer", () => {
    // Construct paths at test time, after beforeAll has created the fixtures.
    const harness = tcpHarness();
    for (const failure of [
      "dns_tcp_event($c, $c->{upstream}, POLLERR);",
      "$c->{deadline} = time - 1; expire_dns_tcp();",
    ]) {
      expect(
        runtimePerl(
          `${harness}
        ${failure}
        die 'no second resolver' unless $c->{attempt} == 2;
        my (undef, $ip) = unpack_sockaddr_in($main::destinations[1]);
        die 'wrong resolver' unless inet_ntoa($ip) eq '198.51.100.53';
        $c->{to_upstream} = ''; $c->{connecting} = 0;
        my $answer = dns_answer($message, 0x100, length($message), 0, 0);
        syswrite($peers[1], pack('n', length $answer) . $answer);
        dns_tcp_event($c, $c->{upstream}, POLLIN);
        die 'answer lost' unless substr($c->{to_client}, 2) eq $answer;
        die 'worker lost client' if $c->{closed};
        print 'ok';`,
          connectPrelude,
        ),
      ).toBe("ok");
    }
  });

  test("exhausts TCP resolvers with SERVFAIL and never forwards forbidden names", () => {
    const harness = tcpHarness();
    expect(
      runtimePerl(
        `${harness}
      dns_tcp_event($c, $c->{upstream}, POLLERR);
      dns_tcp_event($c, $c->{upstream}, POLLERR);
      die 'not SERVFAIL' unless (unpack('n', substr($c->{to_client}, 4, 2)) & 15) == 2;
      my $blocked = pack('H*', '${query("blocked.invalid")}');
      $c->{inbound} = pack('n', length $blocked) . $blocked; $c->{to_client} = '';
      dns_tcp_next($c);
      die 'forwarded blocked name' unless @main::destinations == 2;
      die 'not REFUSED' unless (unpack('n', substr($c->{to_client}, 4, 2)) & 15) == 5;
      print 'ok';`,
        connectPrelude,
      ),
    ).toBe("ok");
  });
});

describe("proxy classification and DNS backpressure", () => {
  test("fragmented UTF-8 requests check Host before forwarding on a named port", () => {
    for (const host of ["db.example.test", "blocked.invalid"]) {
      expect(
        runtimePerl(`
      $opt{names} = ${JSON.stringify(join(dir, "names"))}; load_names();
      my $request = pack('H*', '${Buffer.from(`GET /é/🦊 HTTP/1.1\r\nHost: ${host}\r\n\r\n`).toString("hex")}');
      for my $split (1 .. length($request) - 1) {
        socketpair(my $client, my $peer, PF_UNIX, SOCK_STREAM, 0) or die $!;
        socketpair(my $upstream, my $origin, PF_UNIX, SOCK_STREAM, 0) or die $!;
        nonblocking($client); nonblocking($origin);
        my $c = { kind => 'proxy', client => $client, upstream => $upstream,
          port => 5432, classified => 0, peek => substr($request, 0, $split),
          to_upstream => '', to_client => '' };
        $connections{fileno($client)} = $connections{fileno($upstream)} = $c;
        $connection_count++;
        decide($c, 0);
        die 'forwarded partial request' if $c->{classified} || length $c->{to_upstream};
        $c->{peek} .= substr($request, $split); decide($c, 0);
        if ('${host}' eq 'blocked.invalid') {
          die 'forbidden Host relayed' unless $c->{closed};
        } else {
          die 'allowed request lost' unless $c->{classified} && $c->{to_upstream} eq $request;
          drop_connection($c, 0);
        }
        close $peer; close $origin;
      }
      print 'ok';`),
      ).toBe("ok");
    }
  });

  test("a newline-less text first write on a named port is held, then refused with no reply", () => {
    expect(
      runtimePerl(`
      $opt{names} = ${JSON.stringify(join(dir, "names"))}; load_names();
      for my $write ('probe', '{"op":1}') {
        socketpair(my $client, my $peer, PF_UNIX, SOCK_STREAM, 0) or die $!;
        socketpair(my $upstream, my $origin, PF_UNIX, SOCK_STREAM, 0) or die $!;
        nonblocking($peer); nonblocking($origin);
        my $c = { kind => 'proxy', client => $client, upstream => $upstream,
          port => 5432, classified => 0, peek => $write, created => time,
          first_byte => time, to_upstream => '', to_client => '' };
        $connections{fileno($client)} = $connections{fileno($upstream)} = $c;
        $connection_count++;
        decide($c, 0);
        die 'relayed before a newline' if $c->{classified} || length $c->{to_upstream} || $c->{closed};
        # What expire_connections does once CLASSIFY_TIMEOUT has passed.
        $c->{first_byte} = time - 31; expire_connections();
        die 'still held after the timeout' unless $c->{closed};
        my $n = sysread($peer, my $reply, 64);
        die 'the refusal sent a reply' if $n;
        die 'bytes reached the upstream' if sysread($origin, my $leak, 64);
      }
      die 'connection leaked' unless $connection_count == 0 && keys(%connections) == 0;
      print 'ok';`),
    ).toBe("ok");
  });

  test("a non-reading DNS client cannot accumulate responses and pipelined queries resume in order", () => {
    expect(
      runtimePerl(`
      $opt{names} = ${JSON.stringify(join(dir, "names"))}; load_names();
      socketpair(my $client, my $peer, PF_UNIX, SOCK_STREAM, 0) or die $!;
      nonblocking($client); nonblocking($peer);
      my $fill = 'x' x 65536; my $filled = 0;
      while (my $n = syswrite($client, $fill)) { $filled += $n; }
      my $message = pack('H*', '${query("blocked.invalid", { edns: true })}');
      my $frame = pack('n', length $message) . $message;
      my $c = { kind => 'dns', client => $client, inbound => $frame x 1000,
        to_client => '', to_upstream => '', from_loopback => 0, deadline => time + 10 };
      dns_tcp_next($c); dns_tcp_masks($c);
      my $size = length $c->{to_client}; my $left = length $c->{inbound};
      die 'no refusal' unless $size > 0 && $size <= 65537;
      die 'still reading while blocked' if $poll->mask($client) & POLLIN;
      for (1 .. 4000) { dns_tcp_next($c); }
      die 'unbounded replies' unless length($c->{to_client}) == $size && length($c->{inbound}) == $left;
      while ($filled > 0) { my $n = sysread($peer, my $data, $filled > 65536 ? 65536 : $filled); die $! unless $n; $filled -= $n; }
      dns_tcp_event($c, $client, POLLOUT);
      die 'pipeline did not advance exactly once' unless length($c->{inbound}) == $left - length($frame);
      sysread($peer, my $answer, 65536) > 2 or die 'no answer';
      die 'wrong reply ID' unless unpack('n', substr($answer, 2, 2)) == 0x1234;
      # A separate client remains usable while the first is blocked.
      socketpair(my $other, my $reader, PF_UNIX, SOCK_STREAM, 0) or die $!;
      nonblocking($other);
      my $d = { kind => 'dns', client => $other, inbound => $frame,
        to_client => '', from_loopback => 0, deadline => time + 10 };
      dns_tcp_next($d); dns_tcp_event($d, $other, POLLOUT);
      sysread($reader, $answer, 65536) > 2 or die 'other client blocked';
      print 'ok';`),
    ).toBe("ok");
  });
});

describe("socket-backed maintenance", () => {
  test("revocation and the 30/60 second expiry paths retain unrelated connections", () => {
    expect(
      runtimePerl(`
      $opt{names} = ${JSON.stringify(join(dir, "names"))}; load_names();
      my @clients;
      for my $n (0 .. 3) {
        socketpair(my $client, my $peer, PF_UNIX, SOCK_STREAM, 0) or die $!;
        socketpair(my $upstream, my $server, PF_UNIX, SOCK_STREAM, 0) or die $!;
        push @clients, $peer, $server;
        my $c = { kind => 'proxy', client => $client, upstream => $upstream,
          port => 443, created => time - 61, first_byte => 0,
          classified => $n < 2 ? 1 : 0, peek => 'GET / HTTP/1.1',
          to_client => '', to_upstream => '' };
        $c->{name} = $n == 0 ? 'registry.npmjs.org' : 'revoked.invalid' if $n < 2;
        $c->{first_byte} = time - 31 if $n == 2;
        $connections{fileno($client)} = $connections{fileno($upstream)} = $c;
        $connection_count++;
      }
      revoke_connections(); expire_connections();
      die 'wrong survivors' unless $connection_count == 1 && keys(%connections) == 2;
      maintain_connections('proxy', sub { die 'injected maintenance error'; });
      die 'error escaped or connection leaked' unless $connection_count == 0 && keys(%connections) == 0;
      print 'ok';`),
    ).toBe("ok");
  });
});

describe("refusal counts", () => {
  // Names that look like an exfiltration attempt: none of them, nor any part
  // of one, may appear in what the daemon writes.
  const SECRET = "c2VjcmV0LXRva2Vu";
  const blockedTls = record(clientHello(`${SECRET}.attacker.invalid`)).toString("hex");
  const allowedTls = record(clientHello("registry.npmjs.org")).toString("hex");
  const blockedHttp = Buffer.from(
    `GET / HTTP/1.1\r\nHost: ${SECRET}.http.invalid\r\n\r\n`,
  ).toString("hex");

  /** Counts every kind of refusal through the daemon's own paths, then writes them. */
  const refusals = (counts: string, prelude = "") => `
    $opt{names} = ${JSON.stringify(join(dir, "names"))};
    $opt{resolv} = ${JSON.stringify(join(dir, "resolv-ip"))};
    $opt{counts} = ${JSON.stringify(counts)};
    load_names(); load_resolvers(); load_refusals();
    ${prelude}
    my @keep;
    my $connection = sub {
      my ($port, $bytes) = @_;
      socketpair(my $client, my $peer, PF_UNIX, SOCK_STREAM, 0) or die $!;
      socketpair(my $upstream, my $origin, PF_UNIX, SOCK_STREAM, 0) or die $!;
      push @keep, $peer, $origin;
      my $c = { kind => 'proxy', client => $client, upstream => $upstream, port => $port,
        classified => 0, peek => pack('H*', $bytes), to_upstream => '', to_client => '',
        created => time, first_byte => time };
      $connections{fileno($client)} = $connections{fileno($upstream)} = $c;
      $connection_count++;
      decide($c, 0);
      return $c;
    };
    # A foreign SNI, a foreign Host, and silence on 443 past its limit.
    $connection->(443, '${blockedTls}');
    $connection->(5432, '${blockedHttp}');
    my $silent = $connection->(443, '');
    $silent->{first_byte} = 0; $silent->{created} = time - 61; expire_connections();
    # An allowed name is not a refusal.
    my $allowed = $connection->(443, '${allowedTls}');
    die 'allowed connection refused' unless $allowed->{classified};
    # A refused query over UDP, then over TCP; an allowed one is forwarded.
    socket($dns_udp, PF_INET, SOCK_DGRAM, 0) or die $!;
    bind($dns_udp, pack_sockaddr_in(0, inet_aton('127.0.0.1'))) or die $!;
    nonblocking($dns_udp);
    socket(my $asker, PF_INET, SOCK_DGRAM, 0) or die $!;
    for my $hex ('${query(`${SECRET}.dns.invalid`, { edns: true })}', '${query("registry.npmjs.org")}') {
      send($asker, pack('H*', $hex), 0, getsockname($dns_udp)) or die $!;
    }
    select undef, undef, undef, 0.1;
    { no warnings 'redefine'; local *main::dns_send = sub {}; dns_udp_query(); }
    socketpair(my $tcp, my $reader, PF_UNIX, SOCK_STREAM, 0) or die $!;
    push @keep, $reader;
    my $message = pack('H*', '${query(`${SECRET}.tcp.invalid`)}');
    dns_tcp_next({ kind => 'dns', client => $tcp, inbound => pack('n', length $message) . $message,
      to_client => '', to_upstream => '', from_loopback => 0, deadline => time + 10 });
    write_refusals();
    print "$refused{connections} $refused{queries}";
  `;

  test("counts refused connections and queries, never allowed ones, and writes only the two numbers", () => {
    const counts = join(dir, "counts-basic.json");
    expect(runtimePerl(refusals(counts))).toBe("3 2");
    const written = readFileSync(counts, "utf8");
    expect(written).toBe('{"refusedConnections":3,"refusedQueries":2}\n');
    for (const part of [SECRET, "attacker", "invalid", "dns", "http"]) {
      expect(written).not.toContain(part);
    }
  });

  test("a restarted worker carries the counts on, and ignores a file it did not write", () => {
    const counts = join(dir, "counts-resume.json");
    writeFileSync(counts, '{"refusedConnections":40,"refusedQueries":2}\n');
    expect(runtimePerl(refusals(counts))).toBe("43 4");
    expect(readFileSync(counts, "utf8")).toBe('{"refusedConnections":43,"refusedQueries":4}\n');
    for (const content of [
      '{"refusedConnections":40}\n',
      '{"refusedConnections":-4,"refusedQueries":2}\n',
      `{"refusedConnections":${"9".repeat(16)},"refusedQueries":2}\n`,
      `{"refusedConnections":1,"refusedQueries":1,"name":"${SECRET}"}\n`,
    ]) {
      writeFileSync(counts, content);
      expect(runtimePerl(refusals(counts))).toBe("3 2");
    }
  });

  test("the firewall's own checks hold a quiet marker; one left behind stops muting", () => {
    const counts = join(dir, "counts-quiet.json");
    const quiet = join(dir, "quiet");
    writeFileSync(quiet, "");
    const prelude = `$opt{quiet} = ${JSON.stringify(quiet)};`;
    expect(runtimePerl(refusals(counts, prelude))).toBe("0 0");
    expect(readFileSync(counts, "utf8")).toBe('{"refusedConnections":0,"refusedQueries":0}\n');
    const stale = new Date(Date.now() - 121_000);
    utimesSync(quiet, stale, stale);
    expect(runtimePerl(refusals(counts, prelude))).toBe("3 2");
    rmSync(quiet);
    expect(runtimePerl(refusals(counts, prelude))).toBe("6 4");
  });

  test("rewrites the file only when a count moved, and stops counting at its bound", () => {
    const counts = join(dir, "counts-writes.json");
    expect(
      runtimePerl(`
      $opt{counts} = ${JSON.stringify(counts)};
      write_refusals();
      unlink $opt{counts} or die $!;
      write_refusals();
      die 'rewrote an unchanged count' if -e $opt{counts};
      count_refusal('queries'); write_refusals();
      die 'missed a moved count' unless -e $opt{counts};
      $refused{connections} = MAX_COUNT; count_refusal('connections');
      die 'passed the bound' unless $refused{connections} == MAX_COUNT;
      print 'ok';`),
    ).toBe("ok");
  });
});
