import { describe, expect, test } from "bun:test";
import { openCodeModelRefToId } from "./opencode-model-preferences";

describe("openCodeModelRefToId", () => {
  test("normalizes string references including nested model ids", () => {
    expect(openCodeModelRefToId("  openrouter / openai / gpt-5  ")).toBe(
      "openrouter/openai/gpt-5",
    );
    expect(openCodeModelRefToId("anthropic/claude-sonnet")).toBe(
      "anthropic/claude-sonnet",
    );
  });

  test("normalizes object references and trims both fields", () => {
    expect(
      openCodeModelRefToId({
        providerID: "  anthropic ",
        modelID: " claude-sonnet ",
      }),
    ).toBe("anthropic/claude-sonnet");
    expect(
      openCodeModelRefToId({
        providerID: "openrouter",
        modelID: " openai / gpt-5 ",
      }),
    ).toBe("openrouter/openai/gpt-5");
  });

  test("rejects malformed string references", () => {
    for (const reference of [
      "",
      "   ",
      "invalid",
      "/",
      " / ",
      "/model",
      "provider/",
      "provider//model",
    ]) {
      expect(openCodeModelRefToId(reference)).toBeUndefined();
    }
  });

  test("rejects blank object fields and undefined", () => {
    expect(
      openCodeModelRefToId({ providerID: "", modelID: "model" }),
    ).toBeUndefined();
    expect(
      openCodeModelRefToId({ providerID: "provider", modelID: " " }),
    ).toBeUndefined();
    expect(
      openCodeModelRefToId({ providerID: "/", modelID: "/" }),
    ).toBeUndefined();
    expect(
      openCodeModelRefToId({
        providerID: undefined,
        modelID: "model",
      } as never),
    ).toBeUndefined();
    expect(openCodeModelRefToId(undefined)).toBeUndefined();
  });
});
