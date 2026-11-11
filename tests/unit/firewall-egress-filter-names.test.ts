/**
 * When the egress gateway's name checks run and the names the firewall
 * library hands the daemon. Each case sources the library once in bash; the
 * boots and live edits that run the whole firewall scripts are in the
 * slow-tier firewall-egress-filter.test.ts.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixtureScript,
  gatewayPolicy,
  read,
  SHELL_FIXTURE_TEST_TIMEOUT_MS,
  withDir,
} from "./firewall-test-support";
import { gnuToolPath } from "./gnu-shell-tools";

// One bash process per case; see SHELL_FIXTURE_TEST_TIMEOUT_MS.
setDefaultTimeout(SHELL_FIXTURE_TEST_TIMEOUT_MS);

/** Sources the library rewritten for each fixture directory in one bash process. */
function library(dirs: readonly string[], code: string): string[] {
  const steps = dirs.map((dir) => {
    fixtureScript(dir, "update-firewall.sh");
    // Each directory runs in its own subshell; a NUL separates the outputs.
    return `( source '${join(dir, "lib", "firewall-domains.sh")}'; ${code} ); printf '\\0'`;
  });
  const result = Bun.spawnSync({
    cmd: ["bash", "-ec", steps.join("\n")],
    env: { ...process.env, PATH: gnuToolPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split("\0").slice(0, dirs.length);
}

describe("when the name checks run", () => {
  test("only in a gateway on policy 3, as the gateway recorded at its first boot", () => {
    const cases: [Parameters<typeof gatewayPolicy>[1], string][] = [
      [{}, "enforced"],
      [{ record: "off" }, "off"],
      // An unreadable or unexpected record keeps them on: fail closed.
      [{ record: "garbage" }, "enforced"],
      // A gateway from an image before the checks never wrote a record.
      [{ record: null }, "unavailable"],
      [{ policy: "2" }, "unavailable"],
      // No trusted snapshot: the firewall runs in the workload itself.
      [{ trusted: false }, "unavailable"],
    ];
    withDir((root) => {
      const dirs = cases.map(([options], index) => {
        const dir = join(root, String(index));
        gatewayPolicy(dir, options);
        return dir;
      });
      const states = library(dirs, "ork_filter_state").map((state) => state.trim());
      expect(states).toEqual(cases.map(([, state]) => state));
    });
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
        [dir],
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
      library([dir], "ork_write_filter_names ''");
      expect(readFileSync(join(dir, "run-firewall", "egress-names"), "utf8")).toBe("");
    });
  });
});
