import { describe, expect, test } from "bun:test";
import { resolveCatalogModelId } from "@/lib/agent-launch";
import { FALLBACK_CLAUDE_MODELS } from "@/lib/claude-fallback-models";
import { CLAUDE_FALLBACK_MODEL_CATALOG } from "@orkestrator/protocol/claude-model-catalog";

// These are the Claude models offered in the settings UI when no bridge server
// is reachable. They mirror what Claude Code 2.1.280's supportedModels()
// reports. The bridge and renderer both project the same protocol constant;
// this test guards the renderer projection as well as the shipped contents.
describe("FALLBACK_CLAUDE_MODELS", () => {
  test("projects the catalogue shared with the Claude bridge", () => {
    expect(FALLBACK_CLAUDE_MODELS).toEqual([...CLAUDE_FALLBACK_MODEL_CATALOG]);
  });

  test("offers the current Claude model line-up in priority order", () => {
    expect(FALLBACK_CLAUDE_MODELS.map((m) => m.id)).toEqual([
      "default",
      "opus[1m]",
      "claude-fable-5-1[1m]",
      "sonnet",
      "haiku",
    ]);
  });

  test("reasoning-capable models expose the full low..max effort ladder", () => {
    for (const id of ["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"]) {
      const model = FALLBACK_CLAUDE_MODELS.find((m) => m.id === id);
      expect(model?.supportsEffort).toBe(true);
      expect(model?.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  test("Haiku 5.5 is the default Haiku and takes effort, unlike 4.5", () => {
    const haiku = FALLBACK_CLAUDE_MODELS.find((m) => m.id === "haiku");
    expect(haiku?.description).toContain("Haiku 5.5");
    expect(haiku?.supportsEffort).toBe(true);
  });

  test("identifies Opus 5.5 in both the recommended and explicit Opus entries", () => {
    for (const id of ["default", "opus[1m]"]) {
      const model = FALLBACK_CLAUDE_MODELS.find((m) => m.id === id);
      expect(model?.description).toContain("Opus 5.5 with 1M context");
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
      default: "claude-opus-5-5[1m]",
      "opus[1m]": "claude-opus-5-5[1m]",
      "claude-fable-5-1[1m]": "claude-fable-5-1",
      sonnet: "claude-sonnet-5-5",
      haiku: "claude-haiku-5-5",
    });
  });

  test("a saved Haiku 4.5 default follows the alias to Haiku 5.5", () => {
    // Configuration stores the resolved id; once the `haiku` row resolves to
    // 5.5 nothing matches the old one, which fell through to the first entry.
    const options = FALLBACK_CLAUDE_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      reasoningEfforts: [],
      resolvedModel: model.resolvedModel,
    }));
    for (const saved of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      expect(resolveCatalogModelId("claude", options, saved)).toBe("haiku");
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
