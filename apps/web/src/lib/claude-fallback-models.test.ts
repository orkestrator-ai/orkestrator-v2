import { describe, expect, test } from "bun:test";
import { FALLBACK_CLAUDE_MODELS } from "@/lib/claude-fallback-models";

// These are the Claude models offered in the settings UI when no bridge server
// is reachable. They mirror the bridge-side fallback list
// (bridges/claude-bridge/src/services/session-manager.ts getAvailableModels);
// this test guards the renderer copy against drift.
describe("FALLBACK_CLAUDE_MODELS", () => {
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

  test("every entry resolves to the concrete model id the bridge reports", () => {
    // `resolvedModel` is load-bearing, not decoration: configuration stores the
    // concrete id (`claude-sonnet-5`) while the catalog is keyed by the alias
    // (`sonnet`), and the settings panes match a stored default through this
    // field. A drift here silently drops an inherited model's reasoning
    // options with every other assertion in this file still green. Mirrors
    // bridges/claude-bridge/src/services/session-manager-interactions.ts.
    expect(Object.fromEntries(FALLBACK_CLAUDE_MODELS.map((m) => [m.id, m.resolvedModel]))).toEqual({
      default: "claude-opus-5[1m]",
      "opus[1m]": "claude-opus-5[1m]",
      "claude-fable-5[1m]": "claude-fable-5",
      sonnet: "claude-sonnet-5",
      haiku: "claude-haiku-4-5-20251001",
    });
  });

  test("model ids are unique and carry display names", () => {
    const ids = FALLBACK_CLAUDE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of FALLBACK_CLAUDE_MODELS) {
      expect(model.name.length).toBeGreaterThan(0);
    }
  });
});
