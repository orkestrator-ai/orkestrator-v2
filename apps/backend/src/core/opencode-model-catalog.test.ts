import { describe, expect, test } from "bun:test";
import {
  normalizeOpenCodeComposerCatalog,
  resolveOpenCodeDefaultModel,
  openCodeSessionModelRef,
} from "./opencode-model-catalog.js";
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

  test("does not invent a session.create model for an unqualified id", () => {
    expect(openCodeSessionCreateModel("sonnet")).toBeUndefined();
    expect(openCodeSessionCreateModel("gpt-5", "high")).toBeUndefined();
    expect(openCodeSessionCreateModel("", "high")).toBeUndefined();
    expect(openCodeSessionCreateModel(undefined, "high")).toBeUndefined();
  });
});

describe("OpenCode configured default", () => {
  test("reserves a connected configured model beyond the catalogue cap", () => {
    const models = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`model-${index}`, { id: `model-${index}` }]),
    );
    const catalog = normalizeOpenCodeComposerCatalog(
      {
        all: [{ id: "opencode-go", models }],
        connected: ["opencode-go"],
        default: { "opencode-go": "model-0" },
      },
      ["opencode-go"],
      { requireConnected: true, configuredModelId: "opencode-go/model-599" },
    );
    expect(catalog.models).toHaveLength(512);
    expect(resolveOpenCodeDefaultModel(undefined, catalog)).toEqual({
      modelId: "opencode-go/model-599",
    });
  });

  test("does not prefer a configured model from a disconnected or excluded provider", () => {
    const value = {
      all: [
        { id: "opencode", models: { sonnet: { id: "sonnet" } } },
        { id: "opencode-go", models: { deepseek: { id: "deepseek" } } },
      ],
      connected: ["opencode-go"],
      default: { opencode: "sonnet", "opencode-go": "deepseek" },
    };
    const catalog = normalizeOpenCodeComposerCatalog(value, ["opencode", "opencode-go"], {
      requireConnected: true,
      configuredModelId: "opencode/sonnet",
    });
    expect(resolveOpenCodeDefaultModel(undefined, catalog)).toEqual({
      modelId: "opencode-go/deepseek",
    });
    const excluded = normalizeOpenCodeComposerCatalog(
      { ...value, connected: ["opencode", "opencode-go"] },
      ["opencode-go"],
      { requireConnected: true, configuredModelId: "opencode/sonnet" },
    );
    expect(resolveOpenCodeDefaultModel(undefined, excluded)).toEqual({
      modelId: "opencode-go/deepseek",
    });
  });
});
