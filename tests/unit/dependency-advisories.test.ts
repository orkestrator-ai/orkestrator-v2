import { expect, test } from "bun:test";
import { semver } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Cover every shipping resolution, including nested copies in standalone runtimes.
const lockfiles = [
  "bun.lock",
  "bridges/claude-bridge/bun.lock",
  "packages/cli/bridge-runtimes/cursor-bridge/bun.lock",
  "packages/cli/bridge-runtimes/pi-bridge/bun.lock",
  "packages/cli/release-runtime/bun.lock",
];

for (const file of lockfiles) {
  test(`${file} keeps MCP HTTP dependencies above the remediated versions`, () => {
    const text = readFileSync(join(import.meta.dir, "../..", file), "utf8");
    const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as {
      packages: Record<string, [string, ...unknown[]]>;
    };
    const floors = { "@hono/node-server": "2.1.3", qs: "6.16.1" };
    for (const [name, minimum] of Object.entries(floors)) {
      const resolutions = Object.values(lock.packages)
        .map(([resolution]) => resolution)
        .filter((resolution) => resolution.startsWith(`${name}@`));
      // Not all runtimes depend on both packages; absence is safe.
      if (file === "bun.lock" || file === "bridges/claude-bridge/bun.lock") {
        expect(resolutions.length, `${file}: missing ${name} resolutions`).toBeGreaterThan(0);
      }
      for (const resolution of resolutions) {
        expect(
          semver.satisfies(resolution.slice(name.length + 1), `>=${minimum}`),
          `${file}: ${resolution} must stay at or above ${minimum} (to-do 7541)`,
        ).toBe(true);
      }
    }
  });
}
