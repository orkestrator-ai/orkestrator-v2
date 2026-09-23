import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    expect(wrapper).toContain("ORKESTRATOR_PID1_ENVIRON");
    expect(dockerfile).not.toContain("update-firewall.sh *");
    expect(dockerfile).toContain("NOPASSWD: /usr/local/bin/init-firewall.sh");
    expect(dockerfile).toContain("NOPASSWD: /usr/local/bin/run-root-setup.sh *");
  });

  test("reads PID 1's environment with PID 1's credentials", () => {
    // Root lacks CAP_SYS_PTRACE in the container, so a plain root read of
    // /proc/1/environ (owned by node) fails with EACCES in both scripts.
    for (const path of ["docker/init-firewall.sh", "docker/run-root-setup.sh"]) {
      const script = read(path);
      expect(script).toContain('setpriv --reuid="$(stat -c %u /proc/1)"');
      expect(script).not.toContain('< "${ORKESTRATOR_PID1_ENVIRON:-/proc/1/environ}"');
    }
  });

  test("bootstraps GitHub metadata through a scoped dig and an ipset", () => {
    const script = read("docker/init-firewall.sh");
    expect(script).toContain("container_env NETWORK_MODE");
    expect(script).toContain("container_env ALLOWED_DOMAINS");
    expect(script).toContain("dig +short A api.github.com");
    expect(script).toContain("ipset create allowed-domains hash:net");
    expect(script).toContain("iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT");
  });

  test("run-root-setup allows full network and denies restricted", () => {
    const wrapper = resolve(root, "docker/run-root-setup.sh");
    const dir = mkdtempSync(join(tmpdir(), "ork-root-setup-"));
    const environ = join(dir, "environ");
    mkdirSync(dir, { recursive: true });

    writeFileSync(environ, "NETWORK_MODE=restricted\0OTHER=1");
    const denied = Bun.spawnSync({
      cmd: ["bash", wrapper, "echo should-not-run"],
      env: { ...process.env, ORKESTRATOR_PID1_ENVIRON: environ },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr.toString()).toContain("disabled in restricted-network");
    expect(denied.stdout.toString()).not.toContain("should-not-run");

    writeFileSync(environ, "NETWORK_MODE=full\0");
    const allowed = Bun.spawnSync({
      cmd: ["bash", wrapper, "echo ran-ok"],
      env: { ...process.env, ORKESTRATOR_PID1_ENVIRON: environ },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.toString()).toContain("ran-ok");
  });

  test("workspace setup treats a failed root step as fatal", () => {
    const setup = read("docker/workspace-setup.sh");
    expect(setup).toContain("Root setup failed with code");
    expect(setup).toContain('exit "$ROOT_EXIT"');
    expect(setup).not.toContain("Root setup exited with code");
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
