import { describe, expect, test } from "bun:test";
import { isEnvironmentReadyForAgents, isEnvironmentSetupSettled } from "./environment-readiness.js";

describe("isEnvironmentSetupSettled", () => {
  test("accepts a ready phase, legacy completion or the user's override", () => {
    expect(isEnvironmentSetupSettled({ setupPhase: "ready" })).toBe(true);
    expect(isEnvironmentSetupSettled({ setupPhase: "pending", setupScriptsComplete: true })).toBe(
      true,
    );
    expect(isEnvironmentSetupSettled({ setupPhase: "failed", setupOverride: true })).toBe(true);
  });

  test("rejects unfinished or failed setup without an override", () => {
    expect(isEnvironmentSetupSettled(null)).toBe(false);
    expect(isEnvironmentSetupSettled(undefined)).toBe(false);
    expect(isEnvironmentSetupSettled({})).toBe(false);
    expect(isEnvironmentSetupSettled({ setupPhase: "running" })).toBe(false);
    expect(
      isEnvironmentSetupSettled({
        setupPhase: "failed",
        setupScriptsComplete: false,
        setupOverride: false,
      }),
    ).toBe(false);
  });
});

describe("isEnvironmentReadyForAgents", () => {
  test("requires a running environment with settled setup", () => {
    expect(isEnvironmentReadyForAgents({ status: "running", setupPhase: "ready" })).toBe(true);
    expect(
      isEnvironmentReadyForAgents({ status: "running", setupPhase: "failed", setupOverride: true }),
    ).toBe(true);
    expect(isEnvironmentReadyForAgents({ status: "stopped", setupPhase: "ready" })).toBe(false);
    expect(isEnvironmentReadyForAgents({ status: "running", setupPhase: "running" })).toBe(false);
    expect(isEnvironmentReadyForAgents(undefined)).toBe(false);
  });
});
