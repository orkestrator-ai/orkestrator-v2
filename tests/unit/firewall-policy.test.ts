import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const policyPath = "/etc/orkestrator";

function fixtureScript(dir: string, name: string): string {
  const script = join(dir, name);
  writeFileSync(script, read(`docker/${name}`).replaceAll(policyPath, join(dir, "policy")));
  return script;
}

function writeStub(bin: string, name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

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
    const bootstrap = read("docker/network-policy-entrypoint.sh");

    expect(dockerfile).not.toContain("SETENV:");
    expect(dockerfile).not.toMatch(/node\s+ALL=\(orkroot\)\s+NOPASSWD:\s+ALL/);
    expect(wrapper).toContain(`${policyPath}/network-mode`);
    expect(entrypoint).toContain("if ! sudo /usr/local/bin/init-firewall.sh");
    expect(entrypoint).toContain(`${policyPath}/network-mode`);
    expect(bootstrap).toContain("chown root:root");
    expect(bootstrap).toContain(
      "if [ ! -e /etc/orkestrator/network-mode ] && [ ! -e /etc/orkestrator/allowed-domains ]",
    );
    expect(bootstrap).toContain("exec setpriv --reuid=node --regid=node --init-groups");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends util-linux");
    expect(dockerfile).toContain("&& command -v setpriv");
    expect(dockerfile).toContain("setpriv --reuid=node --regid=node --init-groups id -u");
    expect(dockerfile).toContain("USER node\n\n# Default terminal settings");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/usr/bin/sudo", "/usr/local/bin/network-policy-entrypoint.sh"]',
    );
    expect(dockerfile).not.toContain("update-firewall.sh *");
    expect(dockerfile).toContain("NOPASSWD: /usr/local/bin/init-firewall.sh");
    expect(dockerfile).toContain("NOPASSWD: /usr/local/bin/run-root-setup.sh *");
  });

  test("privileged scripts read only the root-owned policy", () => {
    for (const path of ["docker/init-firewall.sh", "docker/run-root-setup.sh"]) {
      const script = read(path);
      expect(script).toContain(policyPath);
      expect(script).not.toContain("/proc/1/environ");
      expect(script).not.toContain("ORKESTRATOR_PID1_ENVIRON");
      expect(script).not.toContain("setpriv");
    }
  });

  test("root bootstrap records network policy once and ignores later caller values", () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-policy-boot-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const script = join(dir, "network-policy-entrypoint.sh");
      writeFileSync(
        script,
        read("docker/network-policy-entrypoint.sh")
          .replaceAll(policyPath, join(dir, "policy"))
          .replaceAll("/usr/local/bin/entrypoint.sh", join(dir, "node-entrypoint.sh")),
      );
      writeStub(bin, "install", 'mkdir -p "${@: -1}"');
      writeStub(bin, "chown", "exit 0");
      writeStub(bin, "stat", "printf '0:644\\n'");
      writeStub(bin, "setpriv", 'shift 3; exec "$@"');
      writeFileSync(join(dir, "node-entrypoint.sh"), "#!/bin/bash\nprintf 'node-entrypoint\\n'\n");
      chmodSync(join(dir, "node-entrypoint.sh"), 0o755);

      const run = (mode: string, domains: string) =>
        Bun.spawnSync({
          cmd: ["bash", script],
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            NETWORK_MODE: mode,
            ALLOWED_DOMAINS: domains,
          },
          stdout: "pipe",
          stderr: "pipe",
        });

      expect(run("invalid", "forged.example").exitCode).toBe(1);
      const first = run("restricted", "example.org");
      expect(first.exitCode).toBe(0);
      expect(first.stdout.toString()).toContain("node-entrypoint");
      const second = run("full", "forged.example");
      expect(second.exitCode).toBe(0);
      expect(readFileSync(join(dir, "policy/network-mode"), "utf8")).toBe("restricted\n");
      expect(readFileSync(join(dir, "policy/allowed-domains"), "utf8")).toBe("example.org\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bootstraps GitHub metadata through a scoped dig and an ipset", () => {
    const script = read("docker/init-firewall.sh");
    expect(script).toContain(`${policyPath}/network-mode`);
    expect(script).toContain(`${policyPath}/allowed-domains`);
    expect(script).toContain("dig +short A api.github.com");
    expect(script).toContain("ipset create allowed-domains hash:net");
    expect(script).toContain("iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT");
  });

  test("root setup trusts policy files and denies missing or restricted mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-root-setup-"));
    try {
      const wrapper = fixtureScript(dir, "run-root-setup.sh");
      const policy = join(dir, "policy");
      mkdirSync(policy);
      const run = () =>
        Bun.spawnSync({
          cmd: ["bash", wrapper, "echo ran-ok"],
          env: {
            ...process.env,
            NETWORK_MODE: "full",
            ORKESTRATOR_PID1_ENVIRON: join(dir, "forged"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });

      for (const mode of [null, "restricted", "invalid"]) {
        if (mode === null) rmSync(join(policy, "network-mode"), { force: true });
        else writeFileSync(join(policy, "network-mode"), `${mode}\n`);
        const denied = run();
        expect(denied.exitCode).toBe(1);
        expect(denied.stdout.toString()).not.toContain("ran-ok");
      }

      writeFileSync(join(policy, "network-mode"), "full\n");
      const allowed = run();
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout.toString()).toContain("ran-ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("firewall skips only stored full mode and fails when policy is unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-firewall-mode-"));
    try {
      const script = fixtureScript(dir, "init-firewall.sh");
      const policy = join(dir, "policy");
      mkdirSync(policy);
      writeFileSync(join(policy, "allowed-domains"), "\n");
      const run = () =>
        Bun.spawnSync({
          cmd: ["bash", script],
          env: { ...process.env, NETWORK_MODE: "full", ALLOWED_DOMAINS: "forged.example" },
          stdout: "pipe",
          stderr: "pipe",
        });

      expect(run().exitCode).not.toBe(0);
      writeFileSync(join(policy, "network-mode"), "full\n");
      const full = run();
      expect(full.exitCode).toBe(0);
      expect(full.stdout.toString()).toContain("skipping firewall configuration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("firewall uses stored domains and tolerates a repeated GitHub bootstrap range", () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-firewall-"));
    try {
      const script = fixtureScript(dir, "init-firewall.sh");
      const policy = join(dir, "policy");
      const bin = join(dir, "bin");
      mkdirSync(policy);
      mkdirSync(bin);
      writeFileSync(join(policy, "network-mode"), "restricted\n");
      writeFileSync(join(policy, "allowed-domains"), "example.org\n");
      writeStub(bin, "iptables", 'printf "iptables %s\\n" "$*" >> "$CALL_LOG"');
      writeStub(bin, "iptables-save", "exit 0");
      writeStub(
        bin,
        "ipset",
        `
printf 'ipset %s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  create) : > "$IPSET_STATE" ;;
  add)
    allow_duplicate=false
    if [ "$2" = -exist ]; then allow_duplicate=true; shift; fi
    entry="\${3%/32}"
    if grep -Fxq "$entry" "$IPSET_STATE"; then
      [ "$allow_duplicate" = true ] || exit 1
    else
      printf '%s\\n' "$entry" >> "$IPSET_STATE"
    fi
    ;;
esac`,
      );
      writeStub(
        bin,
        "dig",
        `
if [ "$1" = +short ]; then printf '192.0.2.10\\n'; exit; fi
printf 'example.org. 60 IN A 192.0.2.11\\n'`,
      );
      writeStub(
        bin,
        "curl",
        `
case "$*" in
  *api.github.com/meta*) printf '{"web":["192.0.2.10/32"],"api":[],"git":[]}\\n' ;;
  *example.com*) exit 22 ;;
  *) exit 0 ;;
esac`,
      );
      writeStub(
        bin,
        "jq",
        `
case "$*" in
  *'.web and .api and .git'*) cat >/dev/null; exit 0 ;;
  *) cat >/dev/null; printf '192.0.2.10/32\\n' ;;
esac`,
      );
      writeStub(bin, "aggregate", "cat");
      writeStub(bin, "ip", "printf 'default via 172.17.0.1 dev eth0\\n'");

      const result = Bun.spawnSync({
        cmd: ["bash", script],
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          NETWORK_MODE: "full",
          ALLOWED_DOMAINS: "forged.example",
          CALL_LOG: join(dir, "calls"),
          IPSET_STATE: join(dir, "ipset-state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const calls = readFileSync(join(dir, "calls"), "utf8");
      expect(calls).toContain("ipset add -exist allowed-domains 192.0.2.10/32");
      expect(result.stdout.toString()).toContain("Resolving example.org");
      expect(result.stdout.toString()).not.toContain("forged.example");
      expect(calls).toContain("iptables -P OUTPUT DROP");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
