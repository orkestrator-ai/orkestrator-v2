import { describe, expect, test } from "bun:test";
import {
  buildTabInitialPromptQueueMessage,
  environmentIsReadyForSetupHandoff,
  isTabInitialPromptRequestId,
  STARTUP_AGENT_TAB_ID,
  tabInitialPromptRequestId,
} from "./tab-initial-prompt";

describe("tab initial prompt contract", () => {
  test("mints the one request id both the queue and the mounted tab send under", () => {
    expect(tabInitialPromptRequestId("env-1", "design-agent-1")).toBe(
      "initial-prompt:env-1:design-agent-1",
    );
    expect(tabInitialPromptRequestId("env-1", STARTUP_AGENT_TAB_ID)).toBe(
      "initial-prompt:env-1:startup-agent",
    );
  });

  test("recognizes an opening-prompt request id", () => {
    expect(isTabInitialPromptRequestId(tabInitialPromptRequestId("env-1", "tab"))).toBe(true);
    expect(isTabInitialPromptRequestId("run-script-1")).toBe(false);
  });

  test("builds each provider's queue shape", () => {
    const options = {
      model: "m",
      reasoningEffort: "high",
      fastMode: true,
      attachments: [
        { id: "seeded", type: "image" as const, path: ".orkestrator/a.png", filename: "a.png" },
      ],
    };
    // The renderer-only attachment id never reaches the durable queue.
    expect(buildTabInitialPromptQueueMessage("claude", "id-1", "Brief", options)).toEqual({
      id: "id-1",
      requestId: "id-1",
      text: "Brief",
      attachments: [{ type: "image", path: ".orkestrator/a.png", filename: "a.png" }],
      model: "m",
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: true,
    });
    expect(buildTabInitialPromptQueueMessage("codex", "id-1", "Brief", options)).toMatchObject({
      reasoningEffort: "high",
      mode: "build",
      fastMode: true,
    });
    expect(buildTabInitialPromptQueueMessage("opencode", "id-1", "Brief", options)).toMatchObject({
      variant: "high",
      mode: "build",
    });
    expect(
      buildTabInitialPromptQueueMessage("claude", "id-1", "Brief", { mode: "plan" }),
    ).toMatchObject({ planModeEnabled: true, attachments: [] });
    expect(buildTabInitialPromptQueueMessage("cursor", "id-1", "Brief", { mode: "plan" })).toEqual({
      id: "id-1",
      requestId: "id-1",
      text: "Brief",
      attachments: [],
      model: undefined,
      mode: "plan",
    });
  });
});

describe("environmentIsReadyForSetupHandoff", () => {
  test("is false until setup has finished or been overridden", () => {
    expect(environmentIsReadyForSetupHandoff(undefined)).toBe(false);
    expect(environmentIsReadyForSetupHandoff(null)).toBe(false);
    expect(environmentIsReadyForSetupHandoff({ setupPhase: "running" })).toBe(false);
    expect(environmentIsReadyForSetupHandoff({ setupPhase: "ready" })).toBe(true);
    expect(environmentIsReadyForSetupHandoff({ setupScriptsComplete: true })).toBe(true);
    expect(environmentIsReadyForSetupHandoff({ setupOverride: true })).toBe(true);
  });
});
