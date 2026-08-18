import { describe, expect, test } from "bun:test";
import {
  EMPTY_OPENCODE_MODEL_PREFERENCES,
  normalizeOpenCodeModelPreferences,
  normalizeOpenCodeModelReferences,
  openCodeModelRefToId,
} from "./opencode-model-preferences";

describe("openCodeModelRefToId", () => {
  test("normalizes string references including nested model ids", () => {
    expect(openCodeModelRefToId("  openrouter / openai / gpt-5  ")).toBe("openrouter/openai/gpt-5");
    expect(openCodeModelRefToId("anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet");
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
    expect(openCodeModelRefToId({ providerID: "", modelID: "model" })).toBeUndefined();
    expect(openCodeModelRefToId({ providerID: "provider", modelID: " " })).toBeUndefined();
    expect(openCodeModelRefToId({ providerID: "/", modelID: "/" })).toBeUndefined();
    expect(
      openCodeModelRefToId({
        providerID: undefined,
        modelID: "model",
      } as never),
    ).toBeUndefined();
    expect(openCodeModelRefToId(undefined)).toBeUndefined();
  });
});

describe("normalizeOpenCodeModelReferences", () => {
  test("accepts both wire formats, dedupes, and preserves order", () => {
    expect(
      normalizeOpenCodeModelReferences([
        "openrouter/openai/gpt-5",
        { providerID: "anthropic", modelID: "claude-sonnet" },
        // Duplicate of the first entry, written the other way around.
        { providerID: "openrouter", modelID: "openai/gpt-5" },
        "anthropic/claude-sonnet",
      ]),
    ).toEqual(["openrouter/openai/gpt-5", "anthropic/claude-sonnet"]);
  });

  test("drops entries that are neither a parseable string nor a full object ref", () => {
    expect(
      normalizeOpenCodeModelReferences([
        "no-slash",
        "",
        null,
        undefined,
        42,
        [],
        {},
        { providerID: "anthropic" },
        { modelID: "claude-sonnet" },
        { providerID: 1, modelID: 2 },
        { providerID: "anthropic", modelID: "" },
        "anthropic/claude-sonnet",
      ]),
    ).toEqual(["anthropic/claude-sonnet"]);
  });

  test("returns an empty list for anything that is not an array", () => {
    for (const input of [undefined, null, "anthropic/claude", {}, 7]) {
      expect(normalizeOpenCodeModelReferences(input)).toEqual([]);
    }
  });
});

describe("normalizeOpenCodeModelPreferences", () => {
  test("normalizes every field of a well-formed file", () => {
    expect(
      normalizeOpenCodeModelPreferences({
        recent: [{ providerID: "anthropic", modelID: "claude-sonnet" }],
        favorite: ["openrouter/openai/gpt-5"],
        variant: { " openai/gpt-5 ": "  high  " },
      }),
    ).toEqual({
      recent: ["anthropic/claude-sonnet"],
      favorite: ["openrouter/openai/gpt-5"],
      variant: { "openai/gpt-5": "high" },
    });
  });

  test("drops variant entries with a blank key or a non-string value", () => {
    expect(
      normalizeOpenCodeModelPreferences({
        variant: {
          "  ": "high",
          "openai/gpt-5": "   ",
          "openai/gpt-4": 5,
          "openai/gpt-6": null,
          "openai/gpt-7": "low",
        },
      }),
    ).toEqual({ recent: [], favorite: [], variant: { "openai/gpt-7": "low" } });
  });

  test("ignores a variant map that is an array or a non-object", () => {
    for (const variant of [["high"], "high", 7, null]) {
      expect(normalizeOpenCodeModelPreferences({ variant }).variant).toEqual({});
    }
  });

  test("degrades to empty preferences for a malformed file", () => {
    for (const input of [undefined, null, "", 0, "recent", ["recent"], []]) {
      expect(normalizeOpenCodeModelPreferences(input)).toEqual(EMPTY_OPENCODE_MODEL_PREFERENCES);
    }
  });

  test("tolerates missing fields", () => {
    expect(normalizeOpenCodeModelPreferences({})).toEqual({
      recent: [],
      favorite: [],
      variant: {},
    });
  });

  test("salvages the readable fields when the file is partly corrupt", () => {
    // A hand-edited file can be wrong in one place and fine in another; each
    // field is normalized independently rather than discarding the whole file.
    expect(
      normalizeOpenCodeModelPreferences({
        recent: "openai/gpt-5",
        favorite: [{ providerID: "openai" }, "anthropic/claude-sonnet-5", 7],
        variant: { "anthropic/claude-sonnet-5": "high", "": "low" },
      }),
    ).toEqual({
      recent: [],
      favorite: ["anthropic/claude-sonnet-5"],
      variant: { "anthropic/claude-sonnet-5": "high" },
    });
  });

  test("does not mutate or alias the shared empty constant", () => {
    const result = normalizeOpenCodeModelPreferences({ recent: ["a/b"] });
    expect(result).not.toBe(EMPTY_OPENCODE_MODEL_PREFERENCES);
    expect(EMPTY_OPENCODE_MODEL_PREFERENCES.recent).toEqual([]);
  });
});
