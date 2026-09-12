import { describe, expect, test } from "bun:test";
import { openCodeSessionModelRef } from "./opencode-model-catalog.js";
import { openCodeSessionCreateModel } from "./opencode-provider-helpers.js";

describe("openCodeSessionModelRef", () => {
  test("reads Session.model id/providerID", () => {
    expect(
      openCodeSessionModelRef({
        model: { providerID: "opencode-go", id: "deepseek-v4-flash", variant: "default" },
      }),
    ).toEqual({
      modelId: "opencode-go/deepseek-v4-flash",
      reasoningId: "default",
    });
  });

  test("reads prompt-shaped modelID", () => {
    expect(
      openCodeSessionModelRef({
        model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet" },
      }),
    ).toEqual({ modelId: "openrouter/anthropic/claude-sonnet" });
  });

  test("does not double-prefix an already qualified id", () => {
    expect(
      openCodeSessionModelRef({
        model: { providerID: "openrouter", id: "openrouter/anthropic/claude-sonnet" },
      }),
    ).toEqual({ modelId: "openrouter/anthropic/claude-sonnet" });
  });
});

describe("openCodeSessionCreateModel", () => {
  test("maps a qualified id onto the session.create body", () => {
    expect(openCodeSessionCreateModel("opencode-go/deepseek-v4-flash", "default")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4-flash",
    });
    expect(openCodeSessionCreateModel("opencode-go/deepseek-v4-flash", "high")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4-flash",
      variant: "high",
    });
  });
});
