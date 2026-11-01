import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { describe, expect, test } from "bun:test";
import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";
import { buildTabInitialPromptQueueMessage } from "@orkestrator/protocol/tab-initial-prompt";
import {
  queueBoolean,
  queueDispatchMode,
  queueExecutionMode,
  queueFastMode,
  queueReasoningEffort,
  queueString,
} from "./native-agent-queue-message.js";

const malformed = [null, undefined, "text", 3, ["array"]];

describe("queue message field readers", () => {
  test("strings and booleans read only well-typed fields", () => {
    expect(queueString({ model: "gpt" }, "model")).toBe("gpt");
    expect(queueString({ model: "   " }, "model")).toBeUndefined();
    expect(queueString({ model: 3 }, "model")).toBeUndefined();
    expect(queueBoolean({ flag: false }, "flag")).toBe(false);
    expect(queueBoolean({ flag: "true" }, "flag")).toBeUndefined();
    for (const message of malformed) {
      expect(queueString(message, "model")).toBeUndefined();
      expect(queueBoolean(message, "flag")).toBeUndefined();
    }
  });

  test("reasoning effort prefers the current field, then the legacy names", () => {
    expect(queueReasoningEffort({ reasoningEffort: "high", effort: "low" })).toBe("high");
    expect(queueReasoningEffort({ effort: "low", variant: "max" })).toBe("low");
    expect(queueReasoningEffort({ variant: "max" })).toBe("max");
    expect(queueReasoningEffort({})).toBeUndefined();
  });

  test("fast mode type-checks each candidate before falling through", () => {
    expect(queueFastMode("claude", { fastModeEnabled: true, fastMode: false })).toBe(true);
    // A garbage legacy value must not shadow the shared field.
    expect(queueFastMode("claude", { fastModeEnabled: "yes", fastMode: false })).toBe(false);
    expect(queueFastMode("codex", { fastModeEnabled: true })).toBeUndefined();
    expect(queueFastMode("codex", { fastMode: true })).toBe(true);
    expect(queueFastMode("codex", null)).toBeUndefined();
  });
});

describe("queue message modes", () => {
  test("Claude reads planModeEnabled; other platforms read mode", () => {
    expect(queueExecutionMode("claude", { planModeEnabled: true })).toBe("plan");
    expect(queueExecutionMode("claude", { planModeEnabled: false })).toBe("build");
    expect(queueExecutionMode("claude", {})).toBe("build");
    expect(queueExecutionMode("codex", { mode: "plan" })).toBe("plan");
    expect(queueExecutionMode("codex", {})).toBe("build");
  });

  test("a malformed mode or message is the safe plan mode", () => {
    expect(queueExecutionMode("claude", { planModeEnabled: "no" })).toBe("plan");
    expect(queueExecutionMode("codex", { mode: "yolo" })).toBe("plan");
    for (const message of malformed) {
      expect(queueExecutionMode("codex", message)).toBe("plan");
    }
  });

  test("preserveSessionMode leaves the session's mode alone unless a mode was chosen", () => {
    expect(queueDispatchMode("codex", { preserveSessionMode: true })).toBeUndefined();
    expect(queueDispatchMode("codex", { preserveSessionMode: true, mode: "plan" })).toBe("plan");
    expect(queueDispatchMode("claude", { preserveSessionMode: true, planModeEnabled: false })).toBe(
      "build",
    );
    expect(queueDispatchMode("codex", {})).toBe("build");
  });
});

test.each(AGENT_PLATFORMS)(
  "%s legacy goal carriers preserve mode without the new flag",
  (agent) => {
    const origin = { kind: "goal", goalId: "g", iteration: 0 };
    expect(queueDispatchMode(agent, { origin })).toBeUndefined();
    expect(
      queueDispatchMode(agent, { origin, mode: "build", planModeEnabled: false }),
    ).toBeUndefined();
  },
);

describe("tab initial-prompt contract", () => {
  // The renderer and the backend's startup launch build opening prompts with
  // the protocol's builder; these readers must recover every choice from it.
  test.each([...BUILD_PIPELINE_AGENTS])("%s reads back the builder's choices", (agent) => {
    for (const mode of ["build", "plan"] as const) {
      for (const fastMode of [true, false]) {
        const message = buildTabInitialPromptQueueMessage(agent, "id-1", "Brief", {
          model: "m",
          reasoningEffort: "high",
          fastMode,
          mode,
        });
        expect(queueString(message, "requestId")).toBe("id-1");
        expect(queueString(message, "model")).toBe("m");
        expect(queueReasoningEffort(message)).toBe("high");
        expect(queueFastMode(agent, message)).toBe(fastMode);
        expect(queueExecutionMode(agent, message)).toBe(mode);
        expect(queueDispatchMode(agent, message)).toBe(mode);
      }
    }
    // An unset mode is Build, as a composer send is.
    expect(queueExecutionMode(agent, buildTabInitialPromptQueueMessage(agent, "id", "x"))).toBe(
      "build",
    );
  });
});
