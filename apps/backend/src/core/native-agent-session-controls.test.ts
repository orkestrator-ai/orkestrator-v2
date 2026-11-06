import { describe, expect, test } from "bun:test";
import type { PersistedNativeAgentSession } from "./models.js";
import { nativeAgentSessionWithControls } from "./native-agent-session-controls.js";

function session(
  agent: PersistedNativeAgentSession["agent"],
  controls: PersistedNativeAgentSession["controls"],
): PersistedNativeAgentSession {
  return { agent, controls } as PersistedNativeAgentSession;
}

describe("nativeAgentSessionWithControls", () => {
  test("keeps Pi's auto-compaction toggle across a model switch, and drops model parameters", () => {
    const updated = nativeAgentSessionWithControls(
      session("pi", {
        modelId: "faux/faux-1",
        parameterValues: { autoCompaction: false, other: "x" },
      }),
      { modelId: "faux/faux-2" },
    );
    expect(updated.controls?.modelId).toBe("faux/faux-2");
    expect(updated.controls?.parameterValues).toEqual({ autoCompaction: false });
  });

  test("a model switch still clears the same id on another platform", () => {
    const updated = nativeAgentSessionWithControls(
      session("grok", { modelId: "a", parameterValues: { autoCompaction: false } }),
      { modelId: "b" },
    );
    expect(updated.controls?.parameterValues).toBeUndefined();
  });
});
