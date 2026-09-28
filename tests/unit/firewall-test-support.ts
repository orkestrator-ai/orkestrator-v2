import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dir, "../..");
export const read = (path: string) => readFileSync(resolve(root, path), "utf8");
export const policyPath = "/etc/orkestrator";

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
  const script = join(dir, name);
  writeFileSync(script, rewriteFirewallPaths(dir, read(`docker/${name}`)));
  return script;
}

export function writeStub(bin: string, name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Status report path for a fixture directory (root-only in the image). */
export const statusFile = (dir: string) => join(dir, "run-firewall", "firewall.json");
