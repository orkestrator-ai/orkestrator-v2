import { describe, expect, test } from "bun:test";
import { CODEX_MODELS } from "./codex-models";

describe("CODEX_MODELS catalog", () => {
  test("is non-empty and every entry has an id/name", () => {
    expect(CODEX_MODELS.length).toBeGreaterThan(0);
    for (const model of CODEX_MODELS) {
      expect(typeof model.id).toBe("string");
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.name).toBe("string");
      expect(model.name.length).toBeGreaterThan(0);
    }
  });

  test("model ids are unique", () => {
    const ids = CODEX_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("bundled fallback models expose only their supported reasoning efforts", () => {
    for (const model of CODEX_MODELS) {
      expect(model.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
      expect(model.defaultReasoningEffort).toBe("high");
      expect(model.reasoningEfforts).not.toContain("max");
      expect(model.reasoningEfforts).not.toContain("ultra");
    }
  });

  test("advertises the current gpt-5.4 family and no retired ids", () => {
    const ids = CODEX_MODELS.map((m) => m.id);
    expect(ids).toContain("gpt-5.4");
    // Retired ids must not linger in the offered list. A persisted preference
    // pointing at one is reconciled by resolveCodexPreferenceSelection.
    for (const retired of [
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.2",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
    ]) {
      expect(ids).not.toContain(retired);
    }
  });

  test("leads with the gpt-5.4 default", () => {
    expect(CODEX_MODELS[0]!.id).toBe("gpt-5.4");
  });
});
