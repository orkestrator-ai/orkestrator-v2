import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("AcpProcess.request timeout re-arming", () => {
  test("moves an outstanding request's timeout, later or sooner", () => {
    const probe = spawnSync(
      process.execPath,
      [resolve(import.meta.dir, "testing/request-rearm-probe.ts")],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, NODE_ENV: "test" },
      },
    );
    expect(probe.status).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!) as Record<
      "sooner" | "later",
      { outcome: string; elapsedMs: number }
    >;
    // A 60 s timeout brought forward to 150 ms fires then, as a timeout.
    expect(result.sooner.outcome).toBe("silent ACP probe/never timed out");
    expect(result.sooner.elapsedMs).toBeGreaterThanOrEqual(140);
    expect(result.sooner.elapsedMs).toBeLessThan(5_000);
    // Moved again before it fired: only the last time counts.
    expect(result.later.outcome).toBe("silent ACP probe/never timed out");
    expect(result.later.elapsedMs).toBeGreaterThanOrEqual(590);
    expect(result.later.elapsedMs).toBeLessThan(5_000);
  });
});
