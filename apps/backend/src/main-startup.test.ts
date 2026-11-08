import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Each real subprocess has a 15 s bound; allow it to report before the test budget.
setDefaultTimeout(30_000);

function run(scenario: string): string[] {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dir, "testing/main-startup-probe.ts"), scenario],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, NODE_ENV: "test" },
    },
  );
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(`Startup probe failed: ${result.stderr.slice(-4000)}`);
  const last = result.stdout.trim().split("\n").at(-1)!;
  const events = JSON.parse(last).events as string[];
  if (!scenario.endsWith("fails") && events.includes("exit:1")) {
    throw new Error(
      `Unexpected startup failure: ${result.stdout.slice(-4000)} ${result.stderr.slice(-4000)}`,
    );
  }
  return events;
}

describe("main.ts service composition", () => {
  test("publishes before readiness and updater start; releases preview, gateway, descriptor, backend", () => {
    expect(run("success")).toEqual([
      "watchdog:armed",
      "backend:init",
      "gateway:start",
      "preview:start",
      "descriptor:identity",
      "descriptor:publish",
      "stdout:ready",
      "maintenance:ready",
      "updater:start",
      "preview:dispose",
      "gateway:stop",
      "descriptor:close",
      "backend:shutdown",
      "exit:0",
    ]);
  });
  test("a failed descriptor publication leaves the standalone updater pending", () => {
    expect(run("descriptor-fails")).toEqual([
      "watchdog:armed",
      "backend:init",
      "gateway:start",
      "preview:start",
      "descriptor:identity",
      "descriptor:publish",
      "stdout:ready",
      "preview:dispose",
      "gateway:stop",
      "descriptor:close",
      "backend:shutdown",
      "exit:0",
    ]);
  });
  test("stopping during publication releases acquired stages and never announces ready", () => {
    expect(run("stop-preview")).toEqual([
      "watchdog:armed",
      "backend:init",
      "gateway:start",
      "preview:start",
      "preview:dispose",
      "gateway:stop",
      "backend:shutdown",
      "exit:0",
    ]);
  });
  test("gateway failure releases the gateway and backend without later stages", () => {
    expect(run("gateway-fails")).toEqual([
      "watchdog:armed",
      "backend:init",
      "gateway:start",
      "gateway:stop",
      "backend:shutdown",
      "exit:1",
    ]);
  });
  test("init failure still shuts down the backend without publishing or starting the gateway", () => {
    expect(run("init-fails")).toEqual([
      "watchdog:armed",
      "backend:init",
      "backend:shutdown",
      "exit:1",
    ]);
  });
});
