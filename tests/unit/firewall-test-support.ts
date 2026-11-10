import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dir, "../..");
export const read = (path: string) => readFileSync(resolve(root, path), "utf8");
export const policyPath = "/etc/orkestrator";

/**
 * Outer budget for a test that runs the real firewall scripts against stubs.
 * One run forks well over a hundred short processes (a bash stub per
 * `iptables`, `ipset`, `dig` or `curl` call, plus the GNU tools): about
 * 0.3–1 s on an idle Linux host, 1–3 s on an idle macOS host, and past
 * Bun's generic five seconds when an aggregate saturates a macOS host. At
 * that deadline Bun kills the still-running `spawnSync` child, so the test
 * saw `exitCode: null` (flake cases 0192, 0199, 0632, 0983, 6602, 9837).
 * Owners set this with `setDefaultTimeout`, which Bun scopes to the file.
 */
export const SHELL_FIXTURE_TEST_TIMEOUT_MS = 30_000;

/**
 * The PATH reset at the top of every root container script (security H2):
 * the image runs them with root-owned directories only. A fixture removes it
 * so its command stubs and the GNU tools on its PATH apply instead of the
 * host's real `iptables` and friends.
 */
const ROOT_SCRIPT_PATH_RESET =
  /^PATH=(?:\/usr\/local\/sbin:\/usr\/local\/bin:)?\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m;

export function withCallerPath(text: string): string {
  if (!ROOT_SCRIPT_PATH_RESET.test(text)) throw new Error("Root script has no PATH reset");
  return text.replace(ROOT_SCRIPT_PATH_RESET, ": # fixture keeps the caller's PATH");
}

/**
 * Rewrites a firewall script's fixed root paths into a temporary directory:
 * policy, seed, runtime status, state and the shared library. The sibling
 * update script is only reachable when a test installs it executable.
 */
export function rewriteFirewallPaths(dir: string, text: string): string {
  return text
    .replaceAll("/usr/local/lib/orkestrator", join(dir, "lib"))
    .replaceAll("/usr/local/bin/update-firewall.sh", join(dir, "update-firewall.sh"))
    .replaceAll("/usr/local/bin/init-firewall.sh", join(dir, "init-firewall.sh"))
    .replaceAll("/etc/orkestrator-seed", join(dir, "seed"))
    .replaceAll(policyPath, join(dir, "policy"))
    .replaceAll("/run/orkestrator", join(dir, "run"))
    .replaceAll("/var/lib/orkestrator", join(dir, "var"));
}

export function fixtureScript(dir: string, name: string): string {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(
    join(dir, "lib", "firewall-domains.sh"),
    rewriteFirewallPaths(dir, read("docker/firewall-domains.sh")),
  );
  writeFileSync(
    join(dir, "lib", "default-allowed-domains"),
    read("docker/default-allowed-domains"),
  );
  const script = join(dir, name);
  const text = rewriteFirewallPaths(dir, read(`docker/${name}`));
  writeFileSync(script, name === "run-root-setup.sh" ? text : withCallerPath(text));
  return script;
}

export function writeStub(bin: string, name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Status report path for a fixture directory (root-only in the image). */
export const statusFile = (dir: string) => join(dir, "run-firewall", "firewall.json");

/** Runs `body` in a fresh temporary directory, removed afterwards. */
export function withDir(body: (dir: string) => void, prefix = "ork-egress-filter-fw-"): void {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The library's view of a gateway: trusted snapshot, policy and record. */
export function gatewayPolicy(
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
