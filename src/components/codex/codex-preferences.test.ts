import { describe, expect, mock, test } from "bun:test";
import type { AppConfig, GlobalConfig } from "@/types";
import type { CodexModel } from "@/lib/codex-client";
import {
  getPersistedCodexPreferences,
  persistCodexGlobalPreferences,
  resolveCodexPreferenceSelection,
  resolveReasoningEffort,
} from "./codex-preferences";

const MODELS: CodexModel[] = [
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-codex",
    name: "GPT-5.4 Codex",
    reasoningEfforts: ["medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
];

function createConfig(overrides?: Partial<GlobalConfig>): AppConfig {
  return {
    version: "1.0",
    global: {
      containerResources: {
        cpuCores: 2,
        memoryGb: 4,
      },
      envFilePatterns: [".env.local", ".env"],
      allowedDomains: ["openai.com"],
      defaultAgent: "claude",
      opencodeModel: "opencode/grok-code",
      codexModel: "gpt-5.3-codex",
      codexReasoningEffort: "medium",
      opencodeMode: "terminal",
      claudeMode: "terminal",
      claudeNativeBackend: "sdk",
      codexMode: "native",
      terminalAppearance: {
        fontFamily: "FiraCode Nerd Font",
        fontSize: 14,
        backgroundColor: "#000000",
      },
      terminalScrollback: 5000,
      ...overrides,
    },
    repositories: {},
  };
}

describe("codex-preferences resolveReasoningEffort", () => {
  test("prefers a supported stored effort", () => {
    expect(resolveReasoningEffort("gpt-5.4-codex", MODELS, "xhigh")).toBe("xhigh");
  });

  test("falls back to the model default when stored effort is unsupported", () => {
    expect(resolveReasoningEffort("gpt-5.4-codex", MODELS, "low")).toBe("high");
  });
});

describe("codex-preferences resolveCodexPreferenceSelection", () => {
  test("prefers stored session selections over persisted defaults", () => {
    const resolved = resolveCodexPreferenceSelection({
      models: MODELS,
      storedModel: "gpt-5.4-codex",
      storedReasoningEffort: "xhigh",
      persistedModel: "gpt-5.3-codex",
      persistedReasoningEffort: "medium",
    });

    expect(resolved).toEqual({
      model: "gpt-5.4-codex",
      reasoningEffort: "xhigh",
    });
  });

  test("falls back to persisted defaults for new sessions", () => {
    const resolved = resolveCodexPreferenceSelection({
      models: MODELS,
      persistedModel: "gpt-5.4-codex",
      persistedReasoningEffort: "xhigh",
    });

    expect(resolved).toEqual({
      model: "gpt-5.4-codex",
      reasoningEffort: "xhigh",
    });
  });

  test("falls back to the first available model when persisted defaults are unavailable", () => {
    const resolved = resolveCodexPreferenceSelection({
      models: MODELS,
      persistedModel: "missing-model",
      persistedReasoningEffort: "xhigh",
    });

    expect(resolved).toEqual({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
  });
});

describe("codex-preferences persistCodexGlobalPreferences", () => {
  test("returns early when preferences are unchanged", async () => {
    const config = createConfig();
    const setConfig = mock(() => {});
    const persistGlobalConfig = mock(async () => config);

    const result = await persistCodexGlobalPreferences({
      config,
      setConfig,
      persistGlobalConfig,
      model: "gpt-5.3-codex",
      effort: "medium",
    });

    expect(result).toBe(true);
    expect(setConfig).not.toHaveBeenCalled();
    expect(persistGlobalConfig).not.toHaveBeenCalled();
  });

  test("optimistically updates and then commits the backend response on success", async () => {
    const config = createConfig();
    const updatedConfig = createConfig({
      codexModel: "gpt-5.4-codex",
      codexReasoningEffort: "xhigh",
    });
    const setConfig = mock(() => {});
    const persistGlobalConfig = mock(async () => updatedConfig);

    const result = await persistCodexGlobalPreferences({
      config,
      setConfig,
      persistGlobalConfig,
      model: "gpt-5.4-codex",
      effort: "xhigh",
    });

    expect(result).toBe(true);
    expect(setConfig).toHaveBeenNthCalledWith(1, {
      ...config,
      global: {
        ...config.global,
        codexModel: "gpt-5.4-codex",
        codexReasoningEffort: "xhigh",
      },
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, updatedConfig);
  });

  test("rolls back the optimistic update when persistence fails", async () => {
    const config = createConfig();
    const setConfig = mock(() => {});
    const persistGlobalConfig = mock(async () => {
      throw new Error("save failed");
    });

    await expect(
      persistCodexGlobalPreferences({
        config,
        setConfig,
        persistGlobalConfig,
        model: "gpt-5.4-codex",
        effort: "high",
      }),
    ).rejects.toThrow("save failed");

    expect(setConfig).toHaveBeenNthCalledWith(1, {
      ...config,
      global: {
        ...config.global,
        codexModel: "gpt-5.4-codex",
        codexReasoningEffort: "high",
      },
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, config);
  });
});

describe("codex-preferences getPersistedCodexPreferences", () => {
  test("normalizes missing persisted values to defaults", () => {
    const config = createConfig({
      codexModel: "",
      codexReasoningEffort: undefined as never,
    });

    expect(getPersistedCodexPreferences(config)).toEqual({
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });
  });
});
