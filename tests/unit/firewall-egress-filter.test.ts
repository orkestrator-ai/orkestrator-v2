/**
 * The firewall scripts' side of the egress gateway's name checks: when they
 * run, the names they hand the daemon, the redirects and marked rules at
 * boot, failing closed when the daemon does not start, and live edits. The
 * daemon itself is covered by egress-filter-daemon.test.ts, and a real
 * container run by apps/backend/tests/container-live-egress-filter.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureScript, read, statusFile, writeStub } from "./firewall-test-support";
import { gnuToolPath, missingGnuTools, titleWithSkip } from "./gnu-shell-tools";

// Expiry stamps go through GNU `date -d`.
const NO_GNU_DATE = missingGnuTools("date");

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ork-egress-filter-fw-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The library's view of a gateway: trusted snapshot, policy and record. */
function gatewayPolicy(
  dir: string,
  options: { policy?: string; record?: string | null; trusted?: boolean } = {},
): void {
  const policy = join(dir, "policy");
  mkdirSync(policy, { recursive: true });
  if (options.trusted !== false) {
    mkdirSync(join(policy, "trusted-network"), { recursive: true });
    writeFileSync(join(policy, "trusted-network", "resolv.conf"), "nameserver 127.0.0.11\n");
    writeFileSync(join(policy, "trusted-network", "host-addresses"), "");
  }
  writeFileSync(join(policy, "network-policy"), `${options.policy ?? "3"}\n`);
  if (options.record !== null) {
    writeFileSync(join(policy, "egress-filter"), `${options.record ?? "on"}\n`);
  }
}

function library(dir: string, code: string, bin?: string): string {
  fixtureScript(dir, "update-firewall.sh");
  const result = Bun.spawnSync({
    cmd: ["bash", "-ec", `source '${join(dir, "lib", "firewall-domains.sh")}'; ${code}`],
    env: { ...process.env, PATH: bin ? `${bin}:${gnuToolPath}` : gnuToolPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

describe("when the name checks run", () => {
  test("only in a gateway on policy 3, as the gateway recorded at its first boot", () => {
    const state = (options: Parameters<typeof gatewayPolicy>[1]) => {
      let value = "";
      withDir((dir) => {
        gatewayPolicy(dir, options);
        value = library(dir, "ork_filter_state").trim();
      });
      return value;
    };
    expect(state({})).toBe("enforced");
    expect(state({ record: "off" })).toBe("off");
    // An unreadable or unexpected record keeps them on: fail closed.
    expect(state({ record: "garbage" })).toBe("enforced");
    // A gateway from an image before the checks never wrote a record.
    expect(state({ record: null })).toBe("unavailable");
    expect(state({ policy: "2" })).toBe("unavailable");
    // No trusted snapshot: the firewall runs in the workload itself.
    expect(state({ trusted: false })).toBe("unavailable");
  });

  test("the gateway records the choice once and keeps it across restarts", () => {
    const gateway = read("docker/orkestrator-egress-gateway.sh");
    const record = gateway.indexOf("if [ ! -e /etc/orkestrator/egress-filter ]; then");
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(gateway.indexOf("/usr/local/bin/init-firewall.sh"));
    expect(gateway).toContain('case "${ORKESTRATOR_EGRESS_FILTER:-on}" in');
    // The workload's own entrypoint never records or runs them.
    expect(read("docker/network-policy-entrypoint.sh")).not.toContain("egress-filter");
  });
});

describe("the names the daemon allows", () => {
  test("one line per valid domain and port; invalid entries are left out", () => {
    withDir((dir) => {
      gatewayPolicy(dir);
      library(
        dir,
        "ork_write_filter_names 'Registry.npmjs.org,db.example.test:5432,quic.test:443/udp,*.wild.test,bad_name,db.example.test:99999,' ",
      );
      expect(readFileSync(join(dir, "run-firewall", "egress-names"), "utf8")).toBe(
        ["registry.npmjs.org tcp:443", "db.example.test tcp:5432", "quic.test udp:443", ""].join(
          "\n",
        ),
      );
    });
  });

  test("an empty list leaves only GitHub's own names, which the daemon knows itself", () => {
    withDir((dir) => {
      gatewayPolicy(dir);
      library(dir, "ork_write_filter_names ''");
      expect(readFileSync(join(dir, "run-firewall", "egress-names"), "utf8")).toBe("");
    });
  });
});

/** Stubs for one init-firewall.sh boot on policy 3; `daemon` decides the filter. */
function bootFixture(dir: string, daemon: "ready" | "never") {
  const script = fixtureScript(dir, "init-firewall.sh");
  const filter = join(dir, "egress-filter-stub");
  // The installed daemon path, and a start bounded for the test.
  for (const file of [script, join(dir, "lib", "firewall-domains.sh")]) {
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replaceAll("/usr/local/bin/orkestrator-egress-filter", filter)
        .replace("for attempt in $(seq 1 100); do", "for attempt in $(seq 1 3); do"),
    );
  }
  writeFileSync(
    filter,
    daemon === "ready"
      ? 'for (my $i = 0; $i < @ARGV; $i++) { if ($ARGV[$i] eq "--ready") { open(my $f, ">", $ARGV[$i + 1]) or die; print {$f} "1\\n"; close $f; } }\n'
      : "exit 1;\n",
  );
  gatewayPolicy(dir);
  const policy = join(dir, "policy");
  const bin = join(dir, "bin");
  mkdirSync(bin);
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
    `case "$*" in *api.github.com/meta*) printf '{}\\n' ;; *orkestrator-sni-probe.invalid*) exit 35 ;; *example.com*) exit 22 ;; *) exit 0 ;; esac`,
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
    if (failSwap) writeFileSync(join(dir, "ipsets", "fail-swap"), "");
    writeStub(bin, "ipset", IPSET);
    writeStub(
      bin,
      "dig",
      `printf '%s: %s\\n' "\${@: -1}" "$(tr '\\n' ';' < "${join(dir, "run-firewall", "egress-names")}")" >> "${join(dir, "lookups")}"; echo "\${@: -1}. 60 IN A 198.51.100.7"`,
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
      "writes the new names before resolving them, since the gateway's own lookups go through the daemon",
      NO_GNU_DATE,
    ),
    () => {
      withDir((dir) => {
        const result = editFixture(dir, false);
        expect(result.exitCode).toBe(0);
        expect(readFileSync(join(dir, "lookups"), "utf8")).toBe(
          "b.example: b.example tcp:443;b.example tcp:8080;\n",
        );
        expect(readFileSync(join(dir, "run-firewall", "egress-names"), "utf8")).toBe(
          "b.example tcp:443\nb.example tcp:8080\n",
        );
      });
    },
  );

  test.skipIf(Boolean(NO_GNU_DATE))(
    titleWithSkip("puts the previous names back when the rebuild fails", NO_GNU_DATE),
    () => {
      withDir((dir) => {
        const result = editFixture(dir, true);
        expect(result.exitCode).not.toBe(0);
        expect(readFileSync(join(dir, "run-firewall", "egress-names"), "utf8")).toBe(
          "a.example tcp:443\n",
        );
        expect(readFileSync(join(dir, "policy", "allowed-domains"), "utf8")).toBe("a.example\n");
      });
    },
  );
});
