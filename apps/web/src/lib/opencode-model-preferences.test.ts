import { describe, expect, test } from "bun:test";
import { openCodeModelRefToId } from "./opencode-model-preferences";

describe("openCodeModelRefToId", () => {
  test("normalizes both OpenCode preference file formats", () => {
    expect(openCodeModelRefToId("openrouter/openai/gpt-5")).toBe(
      "openrouter/openai/gpt-5",
    );
    expect(
      openCodeModelRefToId({
        providerID: "anthropic",
        modelID: "claude-sonnet",
      }),
    ).toBe("anthropic/claude-sonnet");
    expect(openCodeModelRefToId("invalid")).toBeUndefined();
  });
});
