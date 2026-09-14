import { describe, expect, test } from "bun:test";
import { environmentIsReadyForSetupHandoff } from "./startup-agent-handoff";

describe("environmentIsReadyForSetupHandoff", () => {
  test("is false until setup has finished or been overridden", () => {
    expect(environmentIsReadyForSetupHandoff(undefined)).toBe(false);
    expect(environmentIsReadyForSetupHandoff({ setupPhase: "running" })).toBe(false);
    expect(environmentIsReadyForSetupHandoff({ setupPhase: "ready" })).toBe(true);
    expect(environmentIsReadyForSetupHandoff({ setupScriptsComplete: true })).toBe(true);
    expect(environmentIsReadyForSetupHandoff({ setupOverride: true })).toBe(true);
  });
});
