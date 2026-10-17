import { describe, expect, test } from "bun:test";
import {
  heldSessionModel,
  parseCodexCatalogue,
  resolveCodexDefaultModel,
} from "./session-held-model.js";

/** What `model/list` answers a ChatGPT login at Codex 0.162.1. */
const CHATGPT_CATALOGUE = {
  source: "app-server",
  supportedModelIds: ["gpt-6.1-sol", "gpt-6.1-sol-mini"],
  models: [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    { id: "gpt-6.1-sol-mini", name: "GPT-6.1-Sol Mini" },
  ],
};

describe("resolveCodexDefaultModel", () => {
  test("replaces a default the live catalogue does not offer with its first row", () => {
    expect(resolveCodexDefaultModel("gpt-5.4", CHATGPT_CATALOGUE)).toEqual({
      modelId: "gpt-6.1-sol",
      substitution: {
        requestedModelId: "gpt-5.4",
        modelId: "gpt-6.1-sol",
        message: "gpt-5.4 isn't available with your Codex login; using GPT-6.1-Sol.",
      },
    });
  });

  test("keeps a default the live catalogue offers", () => {
    expect(resolveCodexDefaultModel("gpt-6.1-sol-mini", CHATGPT_CATALOGUE)).toEqual({
      modelId: "gpt-6.1-sol-mini",
    });
  });

  test.each([
    ["the persisted cache", { ...CHATGPT_CATALOGUE, source: "cache" }],
    ["the hardcoded fallback", { ...CHATGPT_CATALOGUE, source: "fallback" }],
    ["an unreadable catalogue", undefined],
    ["an older bridge picker", { source: "app-server", models: CHATGPT_CATALOGUE.models }],
    [
      "an empty live catalogue",
      { source: "app-server", supportedModelIds: ["gpt-6.1-sol", "gpt-6.1-sol-mini"], models: [] },
    ],
  ])("keeps the configured default against %s", (_name, catalogue) => {
    expect(resolveCodexDefaultModel("gpt-5.4", catalogue)).toEqual({ modelId: "gpt-5.4" });
  });

  test("keeps a supported hidden model without adding it to picker options", () => {
    const catalogue = {
      ...CHATGPT_CATALOGUE,
      supportedModelIds: [...CHATGPT_CATALOGUE.supportedModelIds, "hidden-model"],
    };
    expect(resolveCodexDefaultModel("hidden-model", catalogue)).toEqual({
      modelId: "hidden-model",
    });
    expect(resolveCodexDefaultModel("unavailable", catalogue).modelId).toBe("gpt-6.1-sol");
    expect(catalogue.models.some((model) => model.id === "hidden-model")).toBe(false);
  });

  test.each([undefined, "", "  ", "default"])(
    "leaves an unset default (%p) to Codex",
    (configured) => {
      expect(resolveCodexDefaultModel(configured, CHATGPT_CATALOGUE)).toEqual({});
    },
  );

  test("labels the replacement by id when the catalogue gives no name", () => {
    expect(
      resolveCodexDefaultModel("gpt-5.4", {
        source: "app-server",
        supportedModelIds: ["gpt-x"],
        models: [{ id: "gpt-x" }],
      }).substitution?.message,
    ).toBe("gpt-5.4 isn't available with your Codex login; using gpt-x.");
  });
});

describe("parseCodexCatalogue", () => {
  test("keeps ids, names and source and drops malformed rows", () => {
    expect(
      parseCodexCatalogue({
        source: "app-server",
        supportedModelIds: ["gpt-6.1-sol", "gpt-6.1-sol-mini"],
        models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", reasoningEfforts: [] }, { id: "" }, 7],
      }),
    ).toEqual({
      source: "app-server",
      supportedModelIds: ["gpt-6.1-sol", "gpt-6.1-sol-mini"],
      models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }],
    });
  });

  test.each([[["valid", 7]], [Array.from({ length: 1_001 }, (_, i) => `model-${i}`)]])(
    "does not treat malformed or truncated availability as complete (%#)",
    (supportedModelIds) => {
      const catalogue = parseCodexCatalogue({ ...CHATGPT_CATALOGUE, supportedModelIds });
      expect(catalogue?.supportedModelIds).toBeUndefined();
      expect(resolveCodexDefaultModel("gpt-5.4", catalogue)).toEqual({ modelId: "gpt-5.4" });
    },
  );

  test.each([[null], [[]], [{ models: "x" }]])("rejects %p", (value) => {
    expect(parseCodexCatalogue(value)).toBeUndefined();
  });
});

describe("heldSessionModel", () => {
  test("names the model and why it is not in the list", () => {
    expect(heldSessionModel("codex", "gpt-5.4")).toEqual({
      platform: "codex",
      id: "gpt-5.4",
      label: "gpt-5.4",
      providerLabel: "Codex · session model",
      description: "This session runs gpt-5.4. It is not in the current model picker.",
    });
  });
});
