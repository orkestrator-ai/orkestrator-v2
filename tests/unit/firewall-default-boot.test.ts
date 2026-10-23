import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureScript, read, statusFile, writeStub } from "./firewall-test-support";
import { gnuToolPath, missingGnuTools, titleWithSkip } from "./gnu-shell-tools";

const skip = missingGnuTools("date");
for (const fallback of ["generated", "empty", "missing"]) {
  test.skipIf(Boolean(skip))(
    titleWithSkip(`first firewall apply with empty policy and ${fallback} fallback`, skip),
    () => {
      const dir = mkdtempSync(join(tmpdir(), "ork-default-boot-"));
      try {
        const script = fixtureScript(dir, "init-firewall.sh");
        const policy = join(dir, "policy");
        const bin = join(dir, "bin");
        mkdirSync(policy);
        mkdirSync(bin);
        mkdirSync(join(dir, "seed"));
        writeFileSync(join(policy, "network-mode"), "restricted\n");
        writeFileSync(join(policy, "allowed-domains"), "\n");
        writeFileSync(join(policy, "network-policy"), "3\n");
        writeFileSync(join(policy, "host-service-ports"), "\n");
        writeFileSync(join(policy, "ingress-ports"), "\n");
        writeFileSync(
          join(dir, "seed/github-ranges"),
          `# github-ranges ${new Date().toISOString()}\n192.0.2.0/24\n`,
        );
        const defaults = join(dir, "lib/default-allowed-domains");
        if (fallback === "empty") writeFileSync(defaults, "\n");
        if (fallback === "missing") rmSync(defaults);
        for (const command of ["iptables", "ip6tables", "ipset"]) {
          writeStub(bin, command, `printf '${command} %s\\n' "$*" >> "$CALL_LOG"`);
        }
        writeStub(bin, "iptables-save", "exit 0");
        writeStub(bin, "getent", "exit 2");
        writeStub(
          bin,
          "dig",
          `printf 'dig %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = +short ]; then echo 192.0.2.10; else printf '%s. 60 IN A 198.51.100.42\\n' "\${@: -1}"; fi`,
        );
        writeStub(bin, "ip", "echo 'default via 172.17.0.1 dev eth0'");
        writeStub(bin, "curl", `case "$*" in *https://github.com/*) exit 0 ;; *) exit 22 ;; esac`);
        const result = Bun.spawnSync({
          cmd: ["bash", script],
          env: {
            ...process.env,
            PATH: `${bin}:${gnuToolPath}`,
            CALL_LOG: join(dir, "calls"),
            ALLOWED_DOMAINS: "forged.example",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode).toBe(0);
        const calls = readFileSync(join(dir, "calls"), "utf8");
        expect(calls).toContain("ipset add -exist allowed-domains 192.0.2.0/24,tcp:443 timeout 0");
        expect(calls).toContain("iptables -P OUTPUT DROP");
        expect(calls).not.toContain("forged.example");
        const status = JSON.parse(readFileSync(statusFile(dir), "utf8"));
        expect(status).toMatchObject({ state: "applied", policy: 3 });
        if (fallback === "generated") {
          for (const domain of read("docker/default-allowed-domains")
            .trim()
            .split("\n")
            .filter(
              (line) => !line.startsWith("#") && !["github.com", "api.github.com"].includes(line),
            )) {
            expect(calls).toContain(` ${domain}\n`);
          }
          expect(calls).toContain(
            "ipset add -exist allowed-domains 198.51.100.42,tcp:443 timeout 21600",
          );
          expect(status.resolvedDomains).toBeGreaterThan(0);
        } else {
          expect(calls).not.toContain("198.51.100.42");
          expect(status.resolvedDomains).toBe(0);
          expect(result.stdout.toString()).toContain("missing or empty; allowing only GitHub");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
}
