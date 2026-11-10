/**
 * The firewall scripts' side of the egress gateway's name checks: the
 * redirects and marked rules at boot, failing closed when the daemon does not
 * start, and live edits. These run the real firewall scripts against stub
 * tools, so the file is in the slow tier; when the checks run and the names
 * they hand the daemon are in firewall-egress-filter-names.test.ts. The
 * daemon itself is covered by egress-filter-daemon.test.ts, and a real
 * container run by apps/backend/tests/container-live-egress-filter.test.ts.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixtureScript,
  gatewayPolicy,
  read,
  SHELL_FIXTURE_TEST_TIMEOUT_MS,
  statusFile,
  withDir,
  writeStub,
} from "./firewall-test-support";
import { gnuToolPath, missingGnuTools, titleWithSkip } from "./gnu-shell-tools";

// Expiry stamps go through GNU `date -d`.
const NO_GNU_DATE = missingGnuTools("date");

// The boot and edit cases run the real firewall scripts; see
// SHELL_FIXTURE_TEST_TIMEOUT_MS.
setDefaultTimeout(SHELL_FIXTURE_TEST_TIMEOUT_MS);

/** Stubs for one init-firewall.sh boot on policy 3; `daemon` decides the filter. */
function bootFixture(dir: string, daemon: "ready" | "never") {
  const script = fixtureScript(dir, "init-firewall.sh");
  const filter = join(dir, "egress-filter-stub");
  // The installed daemon path. A daemon that never starts would hold the
  // script in its readiness loop for ten seconds, so that case shortens it;
  // a ready daemon keeps the real loop, which returns as soon as the stub
  // writes its file (a three-try loop raced a slow `perl` start under load).
  for (const file of [script, join(dir, "lib", "firewall-domains.sh")]) {
    const text = readFileSync(file, "utf8").replaceAll(
      "/usr/local/bin/orkestrator-egress-filter",
      filter,
    );
    writeFileSync(
      file,
      daemon === "never"
        ? text.replace("for attempt in $(seq 1 100); do", "for attempt in $(seq 1 3); do")
        : text,
    );
  }
  writeFileSync(
    filter,
    daemon === "ready"
      ? // The daemon starts under `env -i`: its arguments go to a fixed file.
        `open(my $log, ">", ${JSON.stringify(join(dir, "daemon-args"))}) or die; print {$log} "@ARGV"; close $log;\n` +
          'for (my $i = 0; $i < @ARGV; $i++) { if ($ARGV[$i] eq "--ready") { open(my $f, ">", $ARGV[$i + 1]) or die; print {$f} "1\\n"; close $f; } }\n'
      : "exit 1;\n",
  );
  gatewayPolicy(dir);
  const policy = join(dir, "policy");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // Whether the daemon's quiet marker was held when a lookup or request ran.
  const quietLog = `[ -e '${join(dir, "run-firewall", "egress-filter.quiet")}' ] && q=quiet || q=counted; printf '%s %s\\n' "$q" "$*" >> "$CALL_LOG"`;
  writeFileSync(join(policy, "network-mode"), "restricted\n");
  writeFileSync(join(policy, "allowed-domains"), "registry.npmjs.org,db.example.test:5432\n");
  writeFileSync(join(policy, "host-service-ports"), "41234\n");
  writeFileSync(join(policy, "ingress-ports"), "\n");
  writeStub(bin, "iptables", 'printf "iptables %s\\n" "$*" >> "$CALL_LOG"');
  writeStub(bin, "ip6tables", "exit 0");
  writeStub(bin, "iptables-save", "exit 0");
  writeStub(bin, "setsid", 'exec "$@"');
  writeStub(
    bin,
    "ipset",
    'printf "ipset %s\\n" "$*" >> "$CALL_LOG"; [ "$1" = list ] && printf "Members:\\n192.0.2.10,tcp:443\\n"; exit 0',
  );
  writeStub(
    bin,
    "dig",
    [
      quietLog,
      'case "$*" in',
      "  *orkestrator-dns-probe.invalid*) echo ';; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 1' ;;",
      "  *+short*) echo 192.0.2.10 ;;",
      '  *) echo "${@: -1}. 60 IN A 192.0.2.11" ;;',
      "esac",
    ].join("\n"),
  );
  writeStub(
    bin,
    "curl",
    `${quietLog}\ncase "$*" in *api.github.com/meta*) printf '{}\\n' ;; *orkestrator-sni-probe.invalid*) exit 35 ;; *example.com*) exit 22 ;; *) exit 0 ;; esac`,
  );
  writeStub(
    bin,
    "jq",
    "cat >/dev/null; case \"$*\" in *'.web and'*) exit 0 ;; *) printf '192.0.2.10/32\\n' ;; esac",
  );
  writeStub(bin, "aggregate", "cat");
  writeStub(
    bin,
    "ip",
    'case "$*" in *"route get"*) echo "192.0.2.1 via 172.20.0.1 dev eth0 src 172.20.0.2 uid 0" ;; *) echo "default via 172.20.0.1 dev eth0" ;; esac',
  );
  return Bun.spawnSync({
    cmd: ["bash", script],
    env: { ...process.env, PATH: `${bin}:${gnuToolPath}`, CALL_LOG: join(dir, "calls") },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("init-firewall.sh with name checks", () => {
  test.skipIf(Boolean(NO_GNU_DATE))(
    titleWithSkip(
      "redirects TCP to allowed tuples and every DNS query to the daemon, and lets only marked traffic leave",
      NO_GNU_DATE,
    ),
    () => {
      withDir((dir) => {
        const result = bootFixture(dir, "ready");
        expect(result.exitCode).toBe(0);
        const calls = readFileSync(join(dir, "calls"), "utf8");
        const mark = "0x6f726b";
        // Redirects, ahead of Docker's own DNS rules.
        expect(calls).toContain(
          `iptables -t nat -I OUTPUT 1 -p tcp ! --dport 53 -m mark ! --mark ${mark} -m set --match-set allowed-domains dst,dst -j DNAT --to-destination 172.20.0.2:31443`,
        );
        // The tuple proxy explicitly excludes DNS even though its -I puts it first.
        const embeddedGuard = `iptables -A OUTPUT -d 127.0.0.11 -m mark ! --mark ${mark} -j REJECT`;
        expect(calls).toContain(embeddedGuard);
        const forgedReplyGuard = `iptables -A OUTPUT -p udp -s 127.0.0.11 --sport 53 -m mark ! --mark ${mark} -j REJECT`;
        expect(calls).toContain(forgedReplyGuard);
        expect(calls.indexOf(forgedReplyGuard)).toBeLessThan(
          calls.indexOf("iptables -A OUTPUT -o lo -j ACCEPT"),
        );
        expect(calls.indexOf(embeddedGuard)).toBeLessThan(
          calls.indexOf("iptables -A OUTPUT -o lo -j ACCEPT"),
        );
        for (const protocol of ["udp", "tcp"]) {
          expect(calls).toContain(
            `iptables -t nat -I OUTPUT 1 -p ${protocol} --dport 53 ! -d 127.0.0.0/8 -m mark ! --mark ${mark} -j DNAT --to-destination 172.20.0.2:31453`,
          );
          expect(calls).toContain(
            `iptables -t nat -I OUTPUT 1 -p ${protocol} --dport 53 -d 127.0.0.11 -m mark ! --mark ${mark} -j REDIRECT --to-ports 31453`,
          );
          expect(calls).toContain(
            `iptables -A OUTPUT -p ${protocol} -d 172.20.0.2 --dport 31453 -j ACCEPT`,
          );
        }
        // Only the daemon's marked sockets reach a resolver or an allowed TCP
        // tuple; UDP entries carry no name to check.
        expect(calls).toContain(
          `iptables -A OUTPUT -p udp -d 127.0.0.11 --dport 53 -m mark --mark ${mark} -j ACCEPT`,
        );
        expect(calls).toContain(
          `iptables -A OUTPUT -p tcp -m mark --mark ${mark} -m set --match-set allowed-domains dst,dst -j ACCEPT`,
        );
        expect(calls).toContain(
          "iptables -A OUTPUT -p udp -m set --match-set allowed-domains dst,dst -j ACCEPT",
        );
        expect(calls).not.toContain(
          "iptables -A OUTPUT -m set --match-set allowed-domains dst,dst -j ACCEPT",
        );
        expect(readFileSync(join(dir, "run-firewall", "egress-names"), "utf8")).toBe(
          "registry.npmjs.org tcp:443\ndb.example.test tcp:5432\n",
        );
        expect(JSON.parse(readFileSync(statusFile(dir), "utf8"))).toMatchObject({
          state: "applied",
          egressFilter: "enforced",
        });
      });
    },
  );

  test.skipIf(Boolean(NO_GNU_DATE))(
    titleWithSkip("a daemon that never starts leaves the namespace closed", NO_GNU_DATE),
    () => {
      withDir((dir) => {
        const result = bootFixture(dir, "never");
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.toString()).toContain("the name-check daemon did not start");
        const calls = readFileSync(join(dir, "calls"), "utf8");
        expect(calls).toContain("iptables -P OUTPUT DROP");
        expect(calls).not.toContain("--match-set allowed-domains dst,dst -j ACCEPT");
        // Never reported applied; the gateway entrypoint reports `failed`.
        expect(() => readFileSync(statusFile(dir), "utf8")).toThrow();
        expect(read("docker/orkestrator-egress-gateway.sh")).toContain('"state":"failed"');
      });
    },
  );

  test.skipIf(Boolean(NO_GNU_DATE))(
    titleWithSkip(
      "the daemon counts refusals beside the report, and the boot's own checks are not counted",
      NO_GNU_DATE,
    ),
    () => {
      withDir((dir) => {
        const result = bootFixture(dir, "ready");
        expect(result.exitCode).toBe(0);
        const calls = readFileSync(join(dir, "calls"), "utf8").split("\n");
        const status = join(dir, "run-firewall");
        expect(readFileSync(join(dir, "daemon-args"), "utf8")).toContain(
          `--counts ${status}/egress-refusals.json --quiet ${status}/egress-filter.quiet`,
        );
        // Every probe for a name off the list ran while the marker was held.
        const probes = calls.filter((line) =>
          /orkestrator-(?:dns|sni)-probe\.invalid|https:\/\/example\.com/.test(line),
        );
        expect(probes).toHaveLength(3);
        for (const probe of probes) expect(probe).toStartWith("quiet ");
        // Resolving the allowlist is not muted, and the marker is gone after.
        expect(
          calls.some((line) => line.startsWith("counted ") && line.includes("registry.npmjs.org")),
        ).toBe(true);
        expect(calls.filter((line) => line.includes("https://github.com/"))).toEqual([
          expect.stringMatching(/^counted /),
        ]);
        expect(() => readFileSync(join(status, "egress-filter.quiet"))).toThrow();
      });
    },
  );

  test("the self-checks refuse a blocked name and a foreign SNI before reporting applied", () => {
    const script = read("docker/init-firewall.sh");
    const checks = script.indexOf("orkestrator-dns-probe.invalid");
    expect(checks).toBeGreaterThan(-1);
    expect(script.indexOf("orkestrator-sni-probe.invalid")).toBeGreaterThan(checks);
    expect(script.indexOf('"state\\":\\"applied\\"')).toBeGreaterThan(checks);
  });
});

describe("update-firewall.sh --set-domains with name checks", () => {
  // A stateful ipset (as in firewall-refresh.test.ts), and a dig that records
  // the daemon's names at the moment of every lookup.
  const IPSET = `
state="$IPSET_DIR"
command="$1"; shift
case "$command" in
  create) : > "$state/$1" ;;
  destroy) [ -f "$state/$1" ] || exit 1; rm -f "$state/$1" ;;
  add) [ "$1" = -exist ] && shift; [ -f "$state/$1" ] || exit 1; printf '%s %s\\n' "$2" "\${4:-0}" >> "$state/$1" ;;
  list) [ -f "$state/$1" ] || exit 1; printf 'Name: %s\\nMembers:\\n' "$1"; awk '{ print $1 " timeout " $2 }' "$state/$1" ;;
  swap) [ ! -e "$state/fail-swap" ] || exit 1; mv "$state/$1" "$state/.swap"; mv "$state/$2" "$state/$1"; mv "$state/.swap" "$state/$2" ;;
esac`;

  function editFixture(dir: string, failSwap: boolean) {
    const script = fixtureScript(dir, "update-firewall.sh");
    writeFileSync(
      join(dir, "lib", "firewall-domains.sh"),
      readFileSync(join(dir, "lib", "firewall-domains.sh"), "utf8").replaceAll(
        "/usr/local/bin/orkestrator-egress-filter",
        join(dir, "egress-filter-stub"),
      ),
    );
    gatewayPolicy(dir);
    const bin = join(dir, "bin");
    for (const sub of ["bin", "var", "ipsets", "run-firewall"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    writeFileSync(join(dir, "policy", "network-mode"), "restricted\n");
    writeFileSync(join(dir, "policy", "allowed-domains"), "a.example\n");
    writeFileSync(join(dir, "var", "github-ranges-active"), "# github-ranges x\n203.0.113.0/24\n");
    writeFileSync(join(dir, "ipsets", "allowed-domains"), "192.0.2.10,tcp:443 21600\n");
    writeFileSync(join(dir, "run-firewall", "egress-names"), "a.example tcp:443\n");
    // Reload the real daemon while a connection authorized by the previous
    // policy is active, at the point where a slow rebuild performs lookups.
    writeFileSync(join(dir, "initial-names"), "a.example tcp:443\n");
    writeFileSync(
      join(dir, "check-connections.pl"),
      `${read("docker/orkestrator-egress-filter.pl").replace("main() unless caller;", "")}
      $opt{names} = ${JSON.stringify(join(dir, "initial-names"))}; load_names();
      socketpair(my $client, my $peer, PF_UNIX, SOCK_STREAM, 0) or die $!;
      socketpair(my $upstream, my $origin, PF_UNIX, SOCK_STREAM, 0) or die $!;
      my $c = { kind => 'proxy', client => $client, upstream => $upstream,
        port => 443, name => 'a.example', classified => 1, to_client => '', to_upstream => '' };
      $connections{fileno($client)} = $connections{fileno($upstream)} = $c; $connection_count++;
      $opt{names} = ${JSON.stringify(join(dir, "run-firewall", "egress-names"))};
      refresh_names();
      die 'previous connection revoked during rebuild' if $c->{closed};
      die 'proposed connection authorized before commit' if name_allowed_on_port('b.example', 443);
      $opt{resolv} = ${JSON.stringify(join(dir, "policy", "trusted-network", "resolv.conf"))};
      load_resolvers();
      die 'proposed DNS lookup refused' unless query_resolvers('b.example', 1);
      syswrite($peer, 'still open') == 10 or die $!;
      my $data; sysread($client, $data, 10) == 10 && $data eq 'still open' or die 'previous stream lost';
      print 'retained';`,
    );
    if (failSwap) writeFileSync(join(dir, "ipsets", "fail-swap"), "");
    writeStub(bin, "ipset", IPSET);
    writeStub(
      bin,
      "dig",
      `perl '${join(dir, "check-connections.pl")}' >> '${join(dir, "connections")}' 2> '${join(dir, "connection-errors")}' || exit 1; printf '%s: %s\\n' "\${@: -1}" "$(tr '\\n' ';' < "${join(dir, "run-firewall", "egress-names")}")" >> "${join(dir, "lookups")}"; echo "\${@: -1}. 60 IN A 198.51.100.7"`,
    );
    writeStub(bin, "conntrack", "exit 0");
    writeStub(bin, "chown", "exit 0");
    return Bun.spawnSync({
      cmd: ["bash", script, "--set-domains", "b.example,b.example:8080"],
      env: { ...process.env, PATH: `${bin}:${gnuToolPath}`, IPSET_DIR: join(dir, "ipsets") },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test.skipIf(Boolean(NO_GNU_DATE))(
    titleWithSkip(
      "stages DNS lookups while preserving current connection permissions until commit",
      NO_GNU_DATE,
    ),
    () => {
      withDir((dir) => {
        const result = editFixture(dir, false);
        expect(readFileSync(join(dir, "connection-errors"), "utf8")).toBe("");
        expect(result.exitCode).toBe(0);
        expect(readFileSync(join(dir, "lookups"), "utf8")).toBe(
          "b.example: a.example tcp:443;dns b.example;\n",
        );
        expect(readFileSync(join(dir, "run-firewall", "egress-names"), "utf8")).toBe(
          "b.example tcp:443\nb.example tcp:8080\n",
        );
      });
    },
  );

  test.skipIf(Boolean(NO_GNU_DATE))(
    titleWithSkip(
      "a failed rebuild restores names without interrupting the previous stream",
      NO_GNU_DATE,
    ),
    () => {
      withDir((dir) => {
        const result = editFixture(dir, true);
        expect(readFileSync(join(dir, "connection-errors"), "utf8")).toBe("");
        expect(result.exitCode).not.toBe(0);
        expect(readFileSync(join(dir, "connections"), "utf8")).toBe("retained");
        expect(readFileSync(join(dir, "run-firewall", "egress-names"), "utf8")).toBe(
          "a.example tcp:443\n",
        );
        expect(readFileSync(join(dir, "policy", "allowed-domains"), "utf8")).toBe("a.example\n");
      });
    },
  );
});
