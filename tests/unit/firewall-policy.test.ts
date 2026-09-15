import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("container firewall policy", () => {
  test("installs fail-closed policies before mutating firewall state", () => {
    const script = read("docker/init-firewall.sh");
    const trap = script.indexOf("trap firewall_fail_closed ERR");
    const outputDrop = script.indexOf("iptables -P OUTPUT DROP", trap);
    const firstFlush = script.indexOf("iptables -F");

    expect(trap).toBeGreaterThan(-1);
    expect(outputDrop).toBeGreaterThan(trap);
    expect(firstFlush).toBeGreaterThan(outputDrop);
    expect(script).not.toContain("iptables -P OUTPUT ACCEPT");
  });

  test("scopes DNS to configured resolvers and has no blanket SSH exception", () => {
    const script = read("docker/init-firewall.sh");
    const activeLines = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const dnsRules = activeLines.filter((line) => line.includes("--dport 53"));

    expect(dnsRules).toEqual([
      'iptables -A OUTPUT -p udp -d "$resolver" --dport 53 -j ACCEPT',
      'iptables -A OUTPUT -p tcp -d "$resolver" --dport 53 -j ACCEPT',
    ]);
    expect(activeLines.some((line) => line.includes("--dport 22"))).toBe(false);
  });

  test("does not let node override firewall policy through sudo", () => {
    const dockerfile = read("docker/Dockerfile");
    const wrapper = read("docker/run-root-setup.sh");
    const entrypoint = read("docker/entrypoint.sh");

    expect(dockerfile).not.toContain("SETENV:");
    expect(dockerfile).not.toMatch(/node\s+ALL=\(orkroot\)\s+NOPASSWD:\s+ALL/);
    expect(wrapper).toContain("/proc/1/environ");
    expect(wrapper).toContain("network_mode:-restricted");
    expect(entrypoint).toContain("if ! sudo /usr/local/bin/init-firewall.sh");
    expect(entrypoint).toContain('if [ "${NETWORK_MODE:-restricted}" != "full" ]');
  });

  test("uses committed host keys instead of build-time trust on first use", () => {
    const dockerfile = read("docker/Dockerfile");
    const knownHosts = read("docker/known_hosts");

    expect(dockerfile).not.toContain("ssh-keyscan");
    expect(dockerfile).toContain(
      "COPY docker/known_hosts /usr/local/share/orkestrator-known-hosts",
    );
    for (const host of ["github.com", "gitlab.com", "bitbucket.org"]) {
      expect(knownHosts).toContain(host);
    }
  });
});
