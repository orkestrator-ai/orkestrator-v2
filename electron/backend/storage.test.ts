import { describe, expect, test } from "bun:test";
import { defaultConfig, defaultRepositoryConfig } from "./storage";

// The default model ids here are the backend source of truth used whenever a
// user has no persisted config. They must stay in sync with the renderer
// defaults (see src/stores/configStore.test.ts) and the offered model catalogs.
describe("defaultConfig", () => {
  test("returns the current default model selection", () => {
    const { global } = defaultConfig();
    expect(global.opencodeModel).toBe("opencode/claude-sonnet-5");
    expect(global.claudeModel).toBe("claude-sonnet-5");
    expect(global.codexModel).toBe("gpt-5.4");
    expect(global.codexReasoningEffort).toBe("medium");
  });

  test("keeps the existing web client behavior enabled by default", () => {
    expect(defaultConfig().global.webClientEnabled).toBe(true);
  });

  test("does not point defaults at any retired model id", () => {
    const { global } = defaultConfig();
    const selected = [global.opencodeModel, global.claudeModel, global.codexModel];
    for (const retired of [
      "opencode/grok-code",
      "claude-sonnet-4-6",
      "gpt-5.3-codex",
    ]) {
      expect(selected).not.toContain(retired);
    }
  });

  test("returns a fresh object each call (no shared mutable state)", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a).not.toBe(b);
    expect(a.global.allowedDomains).not.toBe(b.global.allowedDomains);
    a.global.allowedDomains.push("mutated.example.com");
    expect(b.global.allowedDomains).not.toContain("mutated.example.com");
  });

  test("defaultRepositoryConfig uses main as the default and PR base branch", () => {
    expect(defaultRepositoryConfig()).toEqual({
      defaultBranch: "main",
      prBaseBranch: "main",
    });
  });
});
