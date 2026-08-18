import { describe, expect, test } from "bun:test";
import { FALLBACK_CLAUDE_MODELS } from "./RepositorySettings";

// These are the Claude models offered in the settings UI when no bridge server
// is reachable. They mirror the bridge-side fallback list
// (bridges/claude-bridge/src/services/session-manager.ts getAvailableModels);
// this test guards the renderer copy against drift.
describe("RepositorySettings FALLBACK_CLAUDE_MODELS", () => {
  test("offers the current Claude model line-up in priority order", () => {
    expect(FALLBACK_CLAUDE_MODELS.map((m) => m.id)).toEqual([
      "default",
      "opus[1m]",
      "claude-fable-5[1m]",
      "sonnet",
      "haiku",
    ]);
  });

  test("reasoning-capable models expose the full low..max effort ladder", () => {
    for (const id of ["default", "opus[1m]", "claude-fable-5[1m]", "sonnet"]) {
      const model = FALLBACK_CLAUDE_MODELS.find((m) => m.id === id);
      expect(model?.supportsEffort).toBe(true);
      expect(model?.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  test("Haiku is the non-reasoning tier", () => {
    const haiku = FALLBACK_CLAUDE_MODELS.find((m) => m.id === "haiku");
    expect(haiku?.supportsEffort).toBeUndefined();
  });

  test("identifies Opus 5 in both the recommended and explicit Opus entries", () => {
    for (const id of ["default", "opus[1m]"]) {
      const model = FALLBACK_CLAUDE_MODELS.find((m) => m.id === id);
      expect(model?.description).toContain("Opus 5");
      expect(model?.supportsFastMode).toBe(true);
    }
  });

  test("model ids are unique and carry display names", () => {
    const ids = FALLBACK_CLAUDE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of FALLBACK_CLAUDE_MODELS) {
      expect(model.name.length).toBeGreaterThan(0);
    }
  });
});
