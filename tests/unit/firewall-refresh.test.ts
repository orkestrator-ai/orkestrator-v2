import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedDomainsRevision } from "../../apps/backend/src/core/container-network";
import { fixtureScript, read, statusFile, writeStub } from "./firewall-test-support";
import { gnuToolPath, missingGnuTools, titleWithSkip } from "./gnu-shell-tools";

// Expiry stamps go through GNU `date -d`.
const NO_GNU_DATE = missingGnuTools("date");

// A stateful ipset: one file per set, "entry timeout" per line.
const IPSET = `
printf 'ipset %s\\n' "$*" >> "$CALL_LOG"
state="$IPSET_DIR"
command="$1"; shift
case "$command" in
  create) : > "$state/$1" ;;
  destroy) [ -f "$state/$1" ] || exit 1; rm -f "$state/$1" ;;
  add)
    [ "$1" = -exist ] && shift
    [ -f "$state/$1" ] || exit 1
    { grep -v "^$2 " "$state/$1" || true; } > "$state/$1.tmp"
    mv "$state/$1.tmp" "$state/$1"
    printf '%s %s\\n' "$2" "\${4:-0}" >> "$state/$1"
    ;;
  list)
    [ -f "$state/$1" ] || exit 1
    printf 'Name: %s\\nMembers:\\n' "$1"
    awk '{ print $1 " timeout " $2 }' "$state/$1"
    ;;
  swap) mv "$state/$1" "$state/.swap"; mv "$state/$2" "$state/$1"; mv "$state/.swap" "$state/$2" ;;
esac`;

// Answers from DIG_ANSWERS ("domain address ttl" lines); anything else fails.
const DIG = `
domain="\${@: -1}"
awk -v d="$domain" '$1 == d { print d ". " $3 " IN A " $2 }' "$DIG_ANSWERS"`;

interface Fixture {
  dir: string;
  run: (args: string[], answers: string) => ReturnType<typeof Bun.spawnSync>;
  members: () => Map<string, number>;
  calls: () => string;
  status: () => Record<string, unknown>;
}

/**
 * A restricted container whose stored list is `a.example`. With `policy: 3`
 * the live set holds tuples and the stored list also opens a.example:80; a
 * stale GitHub range has been dropped from the published ranges since boot.
 */
function withFixture(body: (fixture: Fixture) => void, options: { policy?: 2 | 3 } = {}): void {
  const dir = mkdtempSync(join(tmpdir(), "ork-firewall-refresh-"));
  try {
    const script = fixtureScript(dir, "update-firewall.sh");
    const bin = join(dir, "bin");
    for (const sub of ["bin", "policy", "var", "ipsets", "run-firewall"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    const tuples = options.policy === 3;
    writeFileSync(join(dir, "policy", "network-mode"), "restricted\n");
    writeFileSync(
      join(dir, "policy", "allowed-domains"),
      tuples ? "a.example,a.example:80\n" : "a.example\n",
    );
    if (options.policy) writeFileSync(join(dir, "policy", "network-policy"), `${options.policy}\n`);
    writeFileSync(join(dir, "var", "github-ranges-active"), "# github-ranges x\n203.0.113.0/24\n");
    writeFileSync(join(dir, "calls"), "");
    writeStub(bin, "ipset", IPSET);
    writeStub(bin, "dig", DIG);
    writeStub(bin, "conntrack", 'printf "conntrack %s\\n" "$*" >> "$CALL_LOG"; exit 1');
    writeStub(bin, "chown", "exit 0");
    // The live set as init-firewall.sh left it.
    writeFileSync(
      join(dir, "ipsets", "allowed-domains"),
      tuples
        ? [
            "203.0.113.0/24,tcp:443 0",
            "203.0.113.0/24,tcp:22 0",
            "198.18.0.0/15,tcp:22 0",
            "192.0.2.10,tcp:443 21600",
            "192.0.2.10,tcp:80 21600",
            "",
          ].join("\n")
        : "203.0.113.0/24 0\n192.0.2.10 21600\n",
    );
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(dir, "var", "domain-addresses"), `a.example 192.0.2.10 ${now + 3600}\n`);
    const fixture: Fixture = {
      dir,
      run: (args, answers) => {
        writeFileSync(join(dir, "answers"), answers);
        return Bun.spawnSync({
          cmd: ["bash", script, ...args],
          env: {
            ...process.env,
            PATH: `${bin}:${gnuToolPath}`,
            CALL_LOG: join(dir, "calls"),
            IPSET_DIR: join(dir, "ipsets"),
            DIG_ANSWERS: join(dir, "answers"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
      },
      members: () =>
        new Map(
          readFileSync(join(dir, "ipsets", "allowed-domains"), "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const [entry = "", timeout = "0"] = line.split(" ");
              return [entry, Number(timeout)] as const;
            }),
        ),
      calls: () => readFileSync(join(dir, "calls"), "utf8"),
      status: () => JSON.parse(readFileSync(statusFile(dir), "utf8")) as Record<string, unknown>,
    };
    body(fixture);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("firewall allowlist refresh and edits", () => {
  test("a new list is swapped in, removed addresses are revoked and the list is stored", () => {
    withFixture((fixture) => {
      const result = fixture.run(["--set-domains", "b.example"], "b.example 198.51.100.7 120\n");
      expect(result.exitCode).toBe(0);
      const members = fixture.members();
      expect(members.get("203.0.113.0/24")).toBe(0);
      expect(members.get("198.51.100.7")).toBe(21600);
      expect(members.has("192.0.2.10")).toBe(false);
      const calls = fixture.calls();
      // Built beside the live set, then swapped; never an empty live set.
      expect(calls.indexOf("ipset create allowed-domains-next")).toBeLessThan(
        calls.indexOf("ipset swap allowed-domains-next allowed-domains"),
      );
      expect(calls).not.toContain("ipset destroy allowed-domains\n");
      expect(calls).toContain("conntrack -D -d 192.0.2.10");
      expect(calls).not.toContain("conntrack -D -d 198.51.100.7");
      expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe(
        "b.example\n",
      );
      const status = fixture.status();
      expect(status).toMatchObject({
        state: "applied",
        resolvedDomains: 1,
        revokedEntries: 1,
        revocation: "conntrack",
        refreshFailures: 0,
      });
      // The backend computes the same revision for the list it configured.
      expect(status.domainsRevision).toBe(allowedDomainsRevision(["b.example"]));
      // The refresh cadence follows the TTL, within its floor.
      expect(readFileSync(join(fixture.dir, "run-firewall", "refresh-delay"), "utf8").trim()).toBe(
        "300",
      );
    });
  });

  test.skipIf(NO_GNU_DATE !== undefined)(
    titleWithSkip(
      "a domain that does not resolve keeps its addresses only until they expire",
      NO_GNU_DATE,
    ),
    () => {
      withFixture((fixture) => {
        const result = fixture.run(["--refresh"], "");
        expect(result.exitCode).toBe(0);
        const remaining = fixture.members().get("192.0.2.10");
        expect(remaining).toBeGreaterThan(3500);
        expect(remaining).toBeLessThanOrEqual(3600);
        expect(fixture.status()).toMatchObject({ carriedDomains: 1, unresolvedDomains: 1 });
        expect(typeof fixture.status().carriedUntil).toBe("string");
        // A failed resolution retries sooner.
        expect(
          readFileSync(join(fixture.dir, "run-firewall", "refresh-delay"), "utf8").trim(),
        ).toBe("60");

        // Once the recorded expiry passes, a refresh drops and revokes it.
        writeFileSync(
          join(fixture.dir, "var", "domain-addresses"),
          `a.example 192.0.2.10 ${Math.floor(Date.now() / 1000) - 1}\n`,
        );
        expect(fixture.run(["--refresh"], "").exitCode).toBe(0);
        expect(fixture.members().has("192.0.2.10")).toBe(false);
        expect(fixture.calls()).toContain("conntrack -D -d 192.0.2.10");
        expect(fixture.status()).toMatchObject({ carriedDomains: 0, refreshFailures: 2 });
        expect(
          readFileSync(join(fixture.dir, "run-firewall", "refresh-delay"), "utf8").trim(),
        ).toBe("120");
      });
    },
  );

  test("a rotated answer keeps the domain's earlier address until it expires", () => {
    withFixture((fixture) => {
      expect(fixture.run(["--refresh"], "a.example 192.0.2.99 60\n").exitCode).toBe(0);
      const members = fixture.members();
      expect(members.get("192.0.2.99")).toBe(21600);
      // Still trusted for the rest of its recorded lifetime, and not revoked.
      expect(members.get("192.0.2.10")).toBeGreaterThan(3500);
      expect(fixture.calls()).not.toContain("conntrack -D -d 192.0.2.10");
      expect(fixture.status()).toMatchObject({ carriedDomains: 0, refreshFailures: 0 });
      const record = readFileSync(join(fixture.dir, "var", "domain-addresses"), "utf8");
      expect(record).toContain("a.example 192.0.2.99 ");
      expect(record).toContain("a.example 192.0.2.10 ");
    });
  });

  test.skipIf(NO_GNU_DATE !== undefined)(
    titleWithSkip(
      "an address the kernel expired between refreshes still has its connections revoked",
      NO_GNU_DATE,
    ),
    () => {
      withFixture(
        (fixture) => {
          expect(fixture.run(["--refresh"], "a.example 192.0.2.99 60\n").exitCode).toBe(0);
          expect(fixture.members().has("192.0.2.10,tcp:443")).toBe(true);
          // Six hours pass with no refresh: the kernel drops the rotated-away
          // address on its own timeout, before any refresh can see it go.
          const sets = join(fixture.dir, "ipsets", "allowed-domains");
          writeFileSync(
            sets,
            readFileSync(sets, "utf8")
              .split("\n")
              .filter((line) => !line.startsWith("192.0.2.10,"))
              .join("\n"),
          );
          const record = join(fixture.dir, "var", "domain-addresses");
          writeFileSync(
            record,
            readFileSync(record, "utf8").replace(
              /^a\.example 192\.0\.2\.10 \d+$/m,
              `a.example 192.0.2.10 ${Math.floor(Date.now() / 1000) - 1}`,
            ),
          );
          writeFileSync(join(fixture.dir, "calls"), "");
          expect(fixture.run(["--refresh"], "a.example 192.0.2.99 60\n").exitCode).toBe(0);
          const calls = fixture.calls();
          // Its established flows are deleted per tuple, like a removal.
          expect(calls).toContain("conntrack -D -p tcp --dport 443 -d 192.0.2.10");
          expect(calls).toContain("conntrack -D -p tcp --dport 80 -d 192.0.2.10");
          expect(calls).not.toContain("-d 192.0.2.99");
          expect(fixture.status()).toMatchObject({ revokedEntries: 2 });
          // Revoked once: a later refresh has nothing left to revoke.
          writeFileSync(join(fixture.dir, "calls"), "");
          expect(fixture.run(["--refresh"], "a.example 192.0.2.99 60\n").exitCode).toBe(0);
          expect(fixture.calls()).not.toContain("conntrack -D");
        },
        { policy: 3 },
      );
    },
  );

  test("add and remove edit the stored list through the same swap", () => {
    withFixture((fixture) => {
      const answers = "a.example 192.0.2.10 600\nc.example 192.0.2.30 600\n";
      expect(fixture.run(["--add", "c.example"], answers).exitCode).toBe(0);
      expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe(
        "a.example,c.example\n",
      );
      expect(fixture.members().has("192.0.2.30")).toBe(true);
      expect(fixture.run(["--remove", "a.example"], answers).exitCode).toBe(0);
      expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe(
        "c.example\n",
      );
      expect(fixture.members().has("192.0.2.10")).toBe(false);
    });
  });

  test("adding to an empty stored list keeps the image defaults", () => {
    withFixture((fixture) => {
      fixtureScript(fixture.dir, "init-firewall.sh");
      writeFileSync(join(fixture.dir, "policy", "allowed-domains"), "\n");
      const result = fixture.run(["--add", "c.example"], "c.example 192.0.2.30 600\n");
      expect(result.exitCode).toBe(0);
      const stored = readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8");
      expect(stored).toContain("c.example");
      expect(stored.split(",").length).toBeGreaterThan(2);
    });
  });

  test("a list with characters outside a domain name changes nothing", () => {
    withFixture((fixture) => {
      const result = fixture.run(["--set-domains", "a.example;rm -rf /"], "");
      expect(result.exitCode).toBe(2);
      expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe(
        "a.example\n",
      );
      expect(fixture.calls()).not.toContain("ipset swap");
    });
  });

  test("full access only stores the list; there is no allowlist to change", () => {
    withFixture((fixture) => {
      writeFileSync(join(fixture.dir, "policy", "network-mode"), "full\n");
      expect(fixture.run(["--set-domains", "b.example"], "").exitCode).toBe(0);
      expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe(
        "b.example\n",
      );
      expect(fixture.calls()).not.toContain("ipset");
    });
  });

  test("an empty stored list means the image defaults", () => {
    withFixture((fixture) => {
      writeFileSync(join(fixture.dir, "policy", "allowed-domains"), "\n");
      // The defaults are the installed list generated from the canonical one.
      const answers = "registry.npmjs.org 192.0.2.40 600\n";
      expect(fixture.run(["--refresh"], answers).exitCode).toBe(0);
      expect(fixture.members().has("192.0.2.40")).toBe(true);
      expect(fixture.status().domainsRevision).toBe(allowedDomainsRevision([]));
    });
  });

  test("a missing default list allows nothing beyond GitHub", () => {
    withFixture((fixture) => {
      writeFileSync(join(fixture.dir, "policy", "allowed-domains"), "\n");
      rmSync(join(fixture.dir, "lib", "default-allowed-domains"));
      const answers = "registry.npmjs.org 192.0.2.40 600\n";
      expect(fixture.run(["--refresh"], answers).exitCode).toBe(0);
      const members = fixture.members();
      expect(members.has("192.0.2.40")).toBe(false);
      expect(members.has("192.0.2.10")).toBe(false);
      expect(members.get("203.0.113.0/24")).toBe(0);
    });
  });

  test("none is an empty list, never the image defaults", () => {
    withFixture((fixture) => {
      fixtureScript(fixture.dir, "init-firewall.sh");
      const answers = "registry.npmjs.org 192.0.2.40 600\n";
      expect(fixture.run(["--set-domains", "none"], answers).exitCode).toBe(0);
      const members = fixture.members();
      expect(members.has("192.0.2.40")).toBe(false);
      expect(members.has("192.0.2.10")).toBe(false);
      expect(members.get("203.0.113.0/24")).toBe(0);
      expect(fixture.status().domainsRevision).toBe(allowedDomainsRevision([]));
      // Removing the last domain also means none.
      expect(
        fixture.run(["--set-domains", "a.example"], "a.example 192.0.2.10 600\n").exitCode,
      ).toBe(0);
      expect(fixture.run(["--remove", "a.example"], answers).exitCode).toBe(0);
      expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe("none\n");
      expect(fixture.members().has("192.0.2.40")).toBe(false);
    });
  });

  test("policy 3 swaps tuples in and revokes only the ports that left", () => {
    withFixture(
      (fixture) => {
        const result = fixture.run(
          ["--set-domains", "a.example,b.example:5432/udp"],
          "a.example 192.0.2.10 600\nb.example 198.51.100.7 120\n",
        );
        expect(result.exitCode).toBe(0);
        const members = fixture.members();
        expect(members.get("203.0.113.0/24,tcp:443")).toBe(0);
        expect(members.get("203.0.113.0/24,tcp:22")).toBe(0);
        expect(members.get("192.0.2.10,tcp:443")).toBe(21600);
        expect(members.get("198.51.100.7,udp:5432")).toBe(21600);
        expect(members.has("192.0.2.10,tcp:80")).toBe(false);
        expect(members.has("198.51.100.7,tcp:443")).toBe(false);
        expect(members.has("198.18.0.0/15,tcp:22")).toBe(false);
        const calls = fixture.calls();
        // The dropped port of a kept address, and a dropped range by its mask.
        expect(calls).toContain("conntrack -D -p tcp --dport 80 -d 192.0.2.10\n");
        expect(calls).toContain(
          "conntrack -D -p tcp --dport 22 -d 198.18.0.0 --mask-dst 255.254.0.0",
        );
        expect(calls).not.toContain("--dport 443 -d 192.0.2.10");
        expect(calls).not.toContain("conntrack -D -d ");
        expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe(
          "a.example,b.example:5432/udp\n",
        );
        const status = fixture.status();
        expect(status).toMatchObject({ resolvedDomains: 2, revokedEntries: 2, invalidDomains: 0 });
        expect(status.domainsRevision).toBe(
          allowedDomainsRevision(["a.example", "b.example:5432/udp"]),
        );
      },
      { policy: 3 },
    );
  });

  test("policy 3 installs and removes explicit GitHub tuples while retaining built-in ranges", () => {
    withFixture(
      (fixture) => {
        const answers =
          "github.com 203.0.113.10 60\napi.github.com 203.0.113.11 60\nnotgithub.com.example 192.0.2.40 60\n";
        expect(
          fixture.run(
            [
              "--set-domains",
              "github.com:80,github.com:443/udp,api.github.com:8443,notgithub.com.example",
            ],
            answers,
          ).exitCode,
        ).toBe(0);
        expect([...fixture.members().keys()].sort()).toEqual(
          [
            "203.0.113.0/24,tcp:443",
            "203.0.113.0/24,tcp:22",
            "203.0.113.10,tcp:80",
            "203.0.113.10,udp:443",
            "203.0.113.11,tcp:8443",
            "192.0.2.40,tcp:443",
          ].sort(),
        );
        expect(fixture.status().allowedEntries).toBe(fixture.members().size);
        expect(fixture.run(["--set-domains", "github.com,github.com:22"], "").exitCode).toBe(0);
        expect([...fixture.members().keys()].sort()).toEqual(
          ["203.0.113.0/24,tcp:443", "203.0.113.0/24,tcp:22"].sort(),
        );
        expect(fixture.calls()).toContain("conntrack -D -p tcp --dport 80 -d 203.0.113.10");
        expect(fixture.calls()).toContain("conntrack -D -p udp --dport 443 -d 203.0.113.10");
        expect(fixture.calls()).not.toContain("--dport 443 -d 203.0.113.0");
      },
      { policy: 3 },
    );
  });

  test("policy 3 counts a malformed port as invalid; policy 2 refuses a port outright", () => {
    withFixture(
      (fixture) => {
        const result = fixture.run(
          ["--set-domains", "a.example:99999,a.example"],
          "a.example 192.0.2.10 600\n",
        );
        expect(result.exitCode).toBe(0);
        expect(fixture.status()).toMatchObject({ resolvedDomains: 1, invalidDomains: 1 });
        expect([...fixture.members().keys()].filter((entry) => entry.startsWith("192."))).toEqual([
          "192.0.2.10,tcp:443",
        ]);
      },
      { policy: 3 },
    );
    withFixture(
      (fixture) => {
        const result = fixture.run(["--set-domains", "a.example:80"], "");
        expect(result.exitCode).toBe(2);
        expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe(
          "a.example\n",
        );
        expect(fixture.calls()).not.toContain("ipset swap");
      },
      { policy: 2 },
    );
  });

  test("policy 3 refreshes the stored tuples and add/remove edit them", () => {
    withFixture(
      (fixture) => {
        expect(fixture.run(["--refresh"], "a.example 192.0.2.10 600\n").exitCode).toBe(0);
        expect(fixture.members().get("192.0.2.10,tcp:80")).toBe(21600);
        expect(
          fixture.run(["--remove", "a.example:80"], "a.example 192.0.2.10 600\n").exitCode,
        ).toBe(0);
        expect(readFileSync(join(fixture.dir, "policy", "allowed-domains"), "utf8")).toBe(
          "a.example\n",
        );
        expect(fixture.members().has("192.0.2.10,tcp:80")).toBe(false);
        expect(fixture.members().has("192.0.2.10,tcp:443")).toBe(true);
      },
      { policy: 3 },
    );
  });

  test("the refresher and every root mutation stay out of node's runtime directory", () => {
    const library = read("docker/firewall-domains.sh");
    expect(library).toContain("ORK_STATUS_DIR=/run/orkestrator-firewall");
    expect(library).not.toMatch(/ORK_[A-Z_]+=\/run\/orkestrator\//);
    const init = read("docker/init-firewall.sh");
    // The refresher must not inherit the mutation lock.
    expect(init).toContain("--refresh-loop </dev/null >/dev/null 2>&1 8>&- &");
    const dockerfile = read("docker/Dockerfile");
    expect(dockerfile).toContain(
      "COPY docker/firewall-domains.sh /usr/local/lib/orkestrator/firewall-domains.sh",
    );
    expect(dockerfile).toMatch(/^\s+conntrack \\$/m);
  });
});
