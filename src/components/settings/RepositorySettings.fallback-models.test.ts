import { describe, expect, test } from "bun:test";
import { FALLBACK_CLAUDE_MODELS } from "./RepositorySettings";

// These are the Claude models offered in the settings UI when no bridge server
// is reachable. They mirror the bridge-side fallback list
// (bridges/claude-bridge/src/services/session-manager.ts getAvailableModels);
// this test guards the renderer copy against drift.
describe("RepositorySettings FALLBACK_CLAUDE_MODELS", () => {
  test("offers the current Claude model line-up in priority order", () => {
    expect(FALLBACK_CLAUDE_MODELS.map((m) => m.id)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
  });

  test("reasoning-capable models expose the full low..max effort ladder", () => {
    for (const id of ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"]) {
      const model = FALLBACK_CLAUDE_MODELS.find((m) => m.id === id);
      expect(model?.supportsEffort).toBe(true);
      expect(model?.supportedEffortLevels).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  });

  test("Haiku is the non-reasoning tier", () => {
    const haiku = FALLBACK_CLAUDE_MODELS.find(
      (m) => m.id === "claude-haiku-4-5-20251001",
    );
    expect(haiku?.supportsEffort).toBe(false);
  });

  test("model ids are unique and carry display names", () => {
    const ids = FALLBACK_CLAUDE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of FALLBACK_CLAUDE_MODELS) {
      expect(model.name.length).toBeGreaterThan(0);
    }
  });
});
