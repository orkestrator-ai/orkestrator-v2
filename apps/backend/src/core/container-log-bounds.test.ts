import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { bridgeLogEnvironmentExports } from "./container-log-bounds.js";

describe("bridgeLogEnvironmentExports", () => {
  test("a container bridge writes JSON lines, with no level unless the backend has one", () => {
    expect(bridgeLogEnvironmentExports({})).toBe("export ORKESTRATOR_LOG_FORMAT=json");
  });

  test("the level survives the shell whatever it holds", () => {
    const level = "warn,bridge.codex=debug'; touch /tmp/nope; '";
    const script = `${bridgeLogEnvironmentExports({ ORKESTRATOR_LOG_LEVEL: level })}
printf '%s' "$ORKESTRATOR_LOG_FORMAT|$ORKESTRATOR_LOG_LEVEL"`;
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    expect(result.stdout).toBe(`json|${level}`);
  });
});
