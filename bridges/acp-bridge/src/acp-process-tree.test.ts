import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Starts real processes: the probe, its agent and the agent's descendant. The
// probe's own 20 s timeout must fire before Bun's 5 s default would.
setDefaultTimeout(30_000);

describe("AcpProcess tree ownership", () => {
  for (const crash of [false, true]) {
    test.skipIf(process.platform === "win32")(
      crash
        ? "backend reaps the agent and a TERM-resistant descendant after bridge SIGKILL"
        : "close reaps a TERM-resistant descendant after its leader exits",
      () => {
        // Both shutdown paths must reach descendants after their parent exits.
        const probe = spawnSync(
          process.execPath,
          [
            resolve(import.meta.dir, "testing/process-tree-probe.ts"),
            ...(crash ? ["--crash"] : []),
          ],
          {
            encoding: "utf8",
            // A probe that does not exit by itself (a live child or a pending
            // timer holding its loop) fails here rather than hanging the suite.
            timeout: 20_000,
            env: { ...process.env, NODE_ENV: "test" },
          },
        );
        expect(probe.error).toBeUndefined();
        expect(probe.status).toBe(0);
        const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
        expect(result).toEqual({ leaderExited: true, descendantExited: true });
      },
    );
  }
});
