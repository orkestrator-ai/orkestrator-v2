import { describe, expect, test } from "bun:test";
import { useConfigStore } from "./configStore";
import { defaultConfig } from "../../electron/backend/storage";

// `getInitialState()` returns the store's DEFAULT_CONFIG regardless of any
// mutations other tests may have applied, so these assertions are isolation-safe.
const initialGlobal = useConfigStore.getInitialState().config.global;

describe("configStore DEFAULT_CONFIG defaults", () => {
  test("uses the current default model selection", () => {
    expect(initialGlobal.opencodeModel).toBe("opencode/claude-sonnet-5");
    expect(initialGlobal.claudeModel).toBe("claude-sonnet-5");
    expect(initialGlobal.codexModel).toBe("gpt-5.4");
    expect(initialGlobal.codexReasoningEffort).toBe("medium");
  });

  test("does not default to any retired model id", () => {
    const selected = [
      initialGlobal.opencodeModel,
      initialGlobal.claudeModel,
      initialGlobal.codexModel,
    ];
    for (const retired of [
      "opencode/grok-code",
      "claude-sonnet-4-6",
      "gpt-5.3-codex",
    ]) {
      expect(selected).not.toContain(retired);
    }
  });

  // Guards the drift the settings UI depends on: GlobalSettings falls back to
  // these renderer defaults, while the backend persists defaultConfig(). If the
  // two disagree, a user's first-run defaults differ from what gets saved.
  test("agrees with the backend defaultConfig() model selection", () => {
    const backendGlobal = defaultConfig().global;
    expect(initialGlobal.opencodeModel).toBe(backendGlobal.opencodeModel);
    expect(initialGlobal.claudeModel).toBe(backendGlobal.claudeModel);
    expect(initialGlobal.codexModel).toBe(backendGlobal.codexModel);
    expect(initialGlobal.codexReasoningEffort).toBe(backendGlobal.codexReasoningEffort);
    expect(initialGlobal.defaultAgent).toBe(backendGlobal.defaultAgent);
  });
});
