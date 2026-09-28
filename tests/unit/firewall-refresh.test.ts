import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedDomainsRevision } from "../../apps/backend/src/core/container-network";
import { fixtureScript, read, statusFile, writeStub } from "./firewall-test-support";

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

function withFixture(body: (fixture: Fixture) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ork-firewall-refresh-"));
  try {
    const script = fixtureScript(dir, "update-firewall.sh");
    const bin = join(dir, "bin");
    for (const sub of ["bin", "policy", "var", "ipsets", "run-firewall"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    writeFileSync(join(dir, "policy", "network-mode"), "restricted\n");
    writeFileSync(join(dir, "policy", "allowed-domains"), "a.example\n");
    writeFileSync(join(dir, "var", "github-ranges-active"), "# github-ranges x\n203.0.113.0/24\n");
    writeFileSync(join(dir, "calls"), "");
    writeStub(bin, "ipset", IPSET);
    writeStub(bin, "dig", DIG);
    writeStub(bin, "conntrack", 'printf "conntrack %s\\n" "$*" >> "$CALL_LOG"; exit 1');
    writeStub(bin, "chown", "exit 0");
    // The live set as init-firewall.sh left it.
    writeFileSync(join(dir, "ipsets", "allowed-domains"), "203.0.113.0/24 0\n192.0.2.10 21600\n");
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
            PATH: `${bin}:${process.env.PATH}`,
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

  test("a domain that does not resolve keeps its addresses only until they expire", () => {
    withFixture((fixture) => {
      const result = fixture.run(["--refresh"], "");
      expect(result.exitCode).toBe(0);
      const remaining = fixture.members().get("192.0.2.10");
      expect(remaining).toBeGreaterThan(3500);
      expect(remaining).toBeLessThanOrEqual(3600);
      expect(fixture.status()).toMatchObject({ carriedDomains: 1, unresolvedDomains: 1 });
      expect(typeof fixture.status().carriedUntil).toBe("string");
      // A failed resolution retries sooner.
      expect(readFileSync(join(fixture.dir, "run-firewall", "refresh-delay"), "utf8").trim()).toBe(
        "60",
      );

      // Once the recorded expiry passes, a refresh drops and revokes it.
      writeFileSync(
        join(fixture.dir, "var", "domain-addresses"),
        `a.example 192.0.2.10 ${Math.floor(Date.now() / 1000) - 1}\n`,
      );
      expect(fixture.run(["--refresh"], "").exitCode).toBe(0);
      expect(fixture.members().has("192.0.2.10")).toBe(false);
      expect(fixture.calls()).toContain("conntrack -D -d 192.0.2.10");
      expect(fixture.status()).toMatchObject({ carriedDomains: 0, refreshFailures: 2 });
      expect(readFileSync(join(fixture.dir, "run-firewall", "refresh-delay"), "utf8").trim()).toBe(
        "120",
      );
    });
  });

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
      // The defaults are read from the installed init script.
      fixtureScript(fixture.dir, "init-firewall.sh");
      const answers = "registry.npmjs.org 192.0.2.40 600\n";
      expect(fixture.run(["--refresh"], answers).exitCode).toBe(0);
      expect(fixture.members().has("192.0.2.40")).toBe(true);
      expect(fixture.status().domainsRevision).toBe(allowedDomainsRevision([]));
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
