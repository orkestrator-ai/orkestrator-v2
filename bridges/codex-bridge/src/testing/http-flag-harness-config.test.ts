import { describe, expect, test } from "bun:test";

import { resolveHttpHarnessReadyProbeConfig } from "./http-flag-harness-config";

describe("HTTP flag harness readiness configuration", () => {
  test.each([
    [undefined, 5_000, 100],
    ["not-a-number", 5_000, 100],
    ["0", 5_000, 100],
    ["1", 50, 1],
    ["-250", 50, 1],
    ["101", 101, 3],
    ["15000", 15_000, 300],
  ] as const)("maps %s to a %i ms timeout and %i attempts", (input, timeoutMs, attempts) => {
    expect(resolveHttpHarnessReadyProbeConfig(input)).toEqual({
      timeoutMs,
      attempts,
      pollIntervalMs: 50,
    });
  });
});
