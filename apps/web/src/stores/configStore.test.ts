import { beforeEach, describe, expect, expectTypeOf, test } from "bun:test";
import { useConfigStore } from "./configStore";
import { defaultConfig } from "../../../backend/src/core/storage";
import type { GlobalConfig } from "../types";

// `getInitialState()` returns the store's DEFAULT_CONFIG regardless of any
// mutations other tests may have applied, so these assertions are isolation-safe.
const initialGlobal = useConfigStore.getInitialState().config.global;

describe("configStore DEFAULT_CONFIG defaults", () => {
  test("uses the current default model selection", () => {
    expect(initialGlobal.opencodeModel).toBe("opencode/claude-sonnet-5");
    expect(initialGlobal.claudeModel).toBe("claude-sonnet-5");
    expect(initialGlobal.codexModel).toBe("gpt-5.4");
    expect(initialGlobal.codexReasoningEffort).toBe("high");
    expect(initialGlobal.codexMaxConcurrentThreads).toBe(5);
    expect(initialGlobal.useHostGitHubCredentials).toBe(true);
    expectTypeOf<GlobalConfig["codexMaxConcurrentThreads"]>()
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<GlobalConfig["useHostGitHubCredentials"]>()
      .toEqualTypeOf<boolean | undefined>();
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
    expect(initialGlobal.codexMaxConcurrentThreads).toBe(backendGlobal.codexMaxConcurrentThreads);
    expect(initialGlobal.defaultAgent).toBe(backendGlobal.defaultAgent);
    expect(initialGlobal.webClientEnabled).toBe(backendGlobal.webClientEnabled);
    expect(initialGlobal.reviewInstruction).toBe(backendGlobal.reviewInstruction);
    expect(initialGlobal.useHostGitHubCredentials)
      .toBe(backendGlobal.useHostGitHubCredentials);
  });
});

describe("configStore review instruction updates", () => {
  beforeEach(() => {
    useConfigStore.setState({
      config: structuredClone(useConfigStore.getInitialState().config),
      isLoading: false,
      error: null,
    });
  });

  test("sets and removes a custom review instruction without changing sibling config", () => {
    const originalAgent = useConfigStore.getState().config.global.defaultAgent;

    useConfigStore.getState().updateGlobalConfig({
      reviewInstruction: "Review {{targetBranch}}.",
    });
    expect(useConfigStore.getState().config.global.reviewInstruction).toBe(
      "Review {{targetBranch}}.",
    );

    useConfigStore.getState().updateGlobalConfig({ reviewInstruction: undefined });
    const global = useConfigStore.getState().config.global;
    expect(global.reviewInstruction).toBeUndefined();
    expect(Object.hasOwn(global, "reviewInstruction")).toBe(false);
    expect(global.defaultAgent).toBe(originalAgent);
  });
});
