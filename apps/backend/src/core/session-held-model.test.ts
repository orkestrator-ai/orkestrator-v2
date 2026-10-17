import { describe, expect, test } from "bun:test";
import {
  notOfferedSessionModel,
  parseCodexCatalogue,
  resolveCodexDefaultModel,
} from "./session-held-model.js";

/** What `model/list` answers a ChatGPT login at Codex 0.162.1. */
const CHATGPT_CATALOGUE = {
  source: "app-server",
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
    ["an empty live catalogue", { source: "app-server", models: [] }],
  ])("keeps the configured default against %s", (_name, catalogue) => {
    expect(resolveCodexDefaultModel("gpt-5.4", catalogue)).toEqual({ modelId: "gpt-5.4" });
  });

  test.each([undefined, "", "  ", "default"])(
    "leaves an unset default (%p) to Codex",
    (configured) => {
      expect(resolveCodexDefaultModel(configured, CHATGPT_CATALOGUE)).toEqual({});
    },
  );

  test("labels the replacement by id when the catalogue gives no name", () => {
    expect(
      resolveCodexDefaultModel("gpt-5.4", { source: "app-server", models: [{ id: "gpt-x" }] })
        .substitution?.message,
    ).toBe("gpt-5.4 isn't available with your Codex login; using gpt-x.");
  });
});

describe("parseCodexCatalogue", () => {
  test("keeps ids, names and source and drops malformed rows", () => {
    expect(
      parseCodexCatalogue({
        source: "app-server",
        models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", reasoningEfforts: [] }, { id: "" }, 7],
      }),
    ).toEqual({ source: "app-server", models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }] });
  });

  test.each([[null], [[]], [{ models: "x" }]])("rejects %p", (value) => {
    expect(parseCodexCatalogue(value)).toBeUndefined();
  });
});

describe("notOfferedSessionModel", () => {
  test("names the model and why it is not in the list", () => {
    expect(notOfferedSessionModel("codex", "gpt-5.4")).toEqual({
      platform: "codex",
      id: "gpt-5.4",
      label: "gpt-5.4",
      providerLabel: "Codex · not offered to this login",
      description:
        "This session runs gpt-5.4, which your Codex login does not list. Choose another model.",
    });
  });
});
