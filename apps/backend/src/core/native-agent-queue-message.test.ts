import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { describe, expect, test } from "bun:test";
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
