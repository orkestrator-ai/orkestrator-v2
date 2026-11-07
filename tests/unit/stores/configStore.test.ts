import { describe, test, expect, beforeEach } from "bun:test";
import { configStore } from "../../../apps/web/src/stores/configStore";
import type { AppConfig, RepositoryConfig } from "../../../apps/web/src/types";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
} from "../../../apps/web/src/constants/terminal";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";

describe("configStore", () => {
  beforeEach(() => {
    // Reset store between tests
    appCommandStore(configStore).setState({
      config: {
        version: "1.0",
        global: {
          containerResources: {
            cpuCores: 2,
            memoryGb: 4,
          },
          envFilePatterns: [".env.local", ".env"],
          allowedDomains: [],
          terminalAppearance: { ...DEFAULT_TERMINAL_APPEARANCE },
          terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
          agentSettings: { platforms: { claude: { model: "claude-sonnet-4-6" } } },
        },
        repositories: {},
      },
      isLoading: false,
      hasLoaded: false,
      error: null,
    });
  });

  test("initial state has default config", () => {
    const state = appCommandStore(configStore).getState();
    expect(state.config.version).toBe("1.0");
    expect(state.config.global.containerResources.cpuCores).toBe(2);
    expect(state.config.global.containerResources.memoryGb).toBe(4);
    expect(state.config.global.envFilePatterns).toEqual([".env.local", ".env"]);
    expect(state.config.global.agentSettings?.platforms?.claude?.model).toBe("claude-sonnet-4-6");
    expect(state.config.repositories).toEqual({});
    expect(state.isLoading).toBe(false);
    expect(state.hasLoaded).toBe(false);
    expect(state.error).toBeNull();
  });

  test("setConfig replaces entire config", () => {
    const newConfig: AppConfig = {
      version: "2.0",
      global: {
        containerResources: {
          cpuCores: 4,
          memoryGb: 8,
        },
        envFilePatterns: [".env"],
        allowedDomains: [],
        terminalAppearance: { ...DEFAULT_TERMINAL_APPEARANCE },
        terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
      },
      repositories: {
        "repo-1": {
          defaultBranch: "main",
          prBaseBranch: "develop",
        },
      },
    };

    appCommandStore(configStore).getState().setConfig(newConfig);

    const state = appCommandStore(configStore).getState();
    expect(state.config).toEqual(newConfig);
    expect(state.hasLoaded).toBe(true);
  });

  test("first equal backend config marks defaults loaded without replacing config", () => {
    appCommandStore(configStore).setState({
      config: appCommandStore(configStore).getInitialState().config,
    });
    const before = appCommandStore(configStore).getState();

    before.setConfig(structuredClone(before.config));

    const after = appCommandStore(configStore).getState();
    expect(after.hasLoaded).toBe(true);
    expect(after.config).toBe(before.config);
    expect(after).not.toBe(before);
  });

  test("loading and failure do not mark config loaded before a backend snapshot arrives", () => {
    const { setLoading, setError, setConfig } = appCommandStore(configStore).getState();
    setLoading(true);
    expect(appCommandStore(configStore).getState().hasLoaded).toBe(false);
    setError("Config could not be loaded");
    setLoading(false);
    expect(appCommandStore(configStore).getState().hasLoaded).toBe(false);
    setError(null);
    setConfig(structuredClone(appCommandStore(configStore).getState().config));
    expect(appCommandStore(configStore).getState().hasLoaded).toBe(true);
  });

  test("setConfig preserves state and config identity for equal data", () => {
    appCommandStore(configStore).setState({ hasLoaded: true });
    const before = appCommandStore(configStore).getState();
    const equalConfig = JSON.parse(JSON.stringify(before.config));

    before.setConfig(equalConfig);

    const after = appCommandStore(configStore).getState();
    expect(after).toBe(before);
    expect(after.config).toBe(before.config);
  });

  test("setConfig ignores a config whose keys arrive in a different order", () => {
    appCommandStore(configStore).setState({ hasLoaded: true });
    // A serialized compare is key-order sensitive, so a backend snapshot that
    // reordered its keys would republish identical data and rerender every
    // subscriber.
    const before = appCommandStore(configStore).getState();
    const reorderKeys = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;
    const reorderedConfig = reorderKeys({
      ...before.config,
      global: reorderKeys(before.config.global),
    });
    expect(Object.keys(reorderedConfig)).not.toEqual(Object.keys(before.config));

    before.setConfig(reorderedConfig);

    const after = appCommandStore(configStore).getState();
    expect(after).toBe(before);
    expect(after.config).toBe(before.config);
  });

  test("setConfig adopts a config that only differs by an explicitly undefined field", () => {
    // This store distinguishes present-but-undefined from absent (see
    // updateGlobalConfig, which deletes reviewInstruction rather than assigning
    // undefined). A serialized compare erases the difference and would keep the
    // stale object.
    const before = appCommandStore(configStore).getState();
    expect(Object.hasOwn(before.config.global, "reviewInstruction")).toBe(false);

    before.setConfig({
      ...before.config,
      global: { ...before.config.global, reviewInstruction: undefined },
    });

    const after = appCommandStore(configStore).getState();
    expect(after.config).not.toBe(before.config);
    expect(Object.hasOwn(after.config.global, "reviewInstruction")).toBe(true);
  });

  test("updateGlobalConfig partially updates global config", () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        containerResources: {
          cpuCores: 8,
          memoryGb: 16,
        },
      });

    const state = appCommandStore(configStore).getState();
    expect(state.config.global.containerResources.cpuCores).toBe(8);
    expect(state.config.global.containerResources.memoryGb).toBe(16);
    // Original envFilePatterns should be preserved
    expect(state.config.global.envFilePatterns).toEqual([".env.local", ".env"]);
  });

  test("updateGlobalConfig preserves other global fields", () => {
    appCommandStore(configStore).setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: {
            ...state.config.global.agentSettings,
            platforms: {
              ...state.config.global.agentSettings?.platforms,
              codex: { mode: "native" },
            },
          },
        },
      },
    }));

    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        envFilePatterns: [".env.production"],
      });

    const state = appCommandStore(configStore).getState();
    // Container resources should be preserved
    expect(state.config.global.containerResources.cpuCores).toBe(2);
    expect(state.config.global.containerResources.memoryGb).toBe(4);
    expect(state.config.global.envFilePatterns).toEqual([".env.production"]);
    expect(state.config.global.agentSettings?.platforms?.codex?.mode).toBe("native");
  });

  test("updateGlobalConfig updates the Codex mode", () => {
    appCommandStore(configStore).setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: {
            ...state.config.global.agentSettings,
            platforms: {
              ...state.config.global.agentSettings?.platforms,
              codex: { mode: "native" },
            },
          },
        },
      },
    }));

    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        agentSettings: { platforms: { codex: { mode: "terminal" } } },
      });

    expect(
      appCommandStore(configStore).getState().config.global.agentSettings?.platforms?.codex?.mode,
    ).toBe("terminal");
  });

  test("updateGlobalConfig updates the Claude model", () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        agentSettings: { platforms: { claude: { model: "default" } } },
      });

    expect(
      appCommandStore(configStore).getState().config.global.agentSettings?.platforms?.claude?.model,
    ).toBe("default");
  });

  test("updateGlobalConfig updates web client enablement", () => {
    appCommandStore(configStore).getState().updateGlobalConfig({ webClientEnabled: false });

    expect(appCommandStore(configStore).getState().config.global.webClientEnabled).toBe(false);
  });

  test("setRepositoryConfig adds a new repository config", () => {
    const repoConfig: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "develop",
    };

    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", repoConfig);

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]).toEqual(repoConfig);
  });

  test("setRepositoryConfig updates existing repository config", () => {
    const initialConfig: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };
    const updatedConfig: RepositoryConfig = {
      defaultBranch: "develop",
      prBaseBranch: "staging",
    };

    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", initialConfig);
    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", updatedConfig);

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]).toEqual(updatedConfig);
  });

  test("setRepositoryConfig preserves other repositories", () => {
    const config1: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };
    const config2: RepositoryConfig = {
      defaultBranch: "develop",
      prBaseBranch: "develop",
    };

    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", config1);
    appCommandStore(configStore).getState().setRepositoryConfig("repo-2", config2);

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]).toEqual(config1);
    expect(state.config.repositories["repo-2"]).toEqual(config2);
  });

  test("removeRepositoryConfig removes the specified repository", () => {
    const config: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };

    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", config);
    appCommandStore(configStore).getState().removeRepositoryConfig("repo-1");

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]).toBeUndefined();
  });

  test("removeRepositoryConfig preserves other repositories", () => {
    const config1: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };
    const config2: RepositoryConfig = {
      defaultBranch: "develop",
      prBaseBranch: "develop",
    };

    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", config1);
    appCommandStore(configStore).getState().setRepositoryConfig("repo-2", config2);
    appCommandStore(configStore).getState().removeRepositoryConfig("repo-1");

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]).toBeUndefined();
    expect(state.config.repositories["repo-2"]).toEqual(config2);
  });

  test("removeRepositoryConfig handles non-existent repository", () => {
    appCommandStore(configStore).getState().removeRepositoryConfig("non-existent");

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories).toEqual({});
  });

  test("getRepositoryConfig returns the correct config", () => {
    const config: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "develop",
    };

    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", config);

    const result = appCommandStore(configStore).getState().getRepositoryConfig("repo-1");
    expect(result).toEqual(config);
  });

  test("getRepositoryConfig returns undefined for non-existent repository", () => {
    const result = appCommandStore(configStore).getState().getRepositoryConfig("non-existent");
    expect(result).toBeUndefined();
  });

  test("setLoading updates loading state", () => {
    appCommandStore(configStore).getState().setLoading(true);
    expect(appCommandStore(configStore).getState().isLoading).toBe(true);

    appCommandStore(configStore).getState().setLoading(false);
    expect(appCommandStore(configStore).getState().isLoading).toBe(false);
  });

  test("setError updates error state", () => {
    appCommandStore(configStore).getState().setError("Test error");
    expect(appCommandStore(configStore).getState().error).toBe("Test error");

    appCommandStore(configStore).getState().setError(null);
    expect(appCommandStore(configStore).getState().error).toBeNull();
  });

  test("setRepositoryConfig stores project-level agent override", () => {
    const repoConfig: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: { defaultAgent: "opencode", platforms: { claude: { mode: "native" } } },
    };

    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", repoConfig);

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]?.agentSettings?.defaultAgent).toBe("opencode");
    expect(state.config.repositories["repo-1"]?.agentSettings?.platforms?.claude?.mode).toBe(
      "native",
    );
  });

  test("setRepositoryConfig stores config without agent overrides", () => {
    const repoConfig: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };

    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", repoConfig);

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]?.agentSettings?.defaultAgent).toBeUndefined();
    expect(
      state.config.repositories["repo-1"]?.agentSettings?.platforms?.claude?.mode,
    ).toBeUndefined();
  });

  test("setRepositoryConfig can update agent override to a different value", () => {
    appCommandStore(configStore)
      .getState()
      .setRepositoryConfig("repo-1", {
        defaultBranch: "main",
        prBaseBranch: "main",
        agentSettings: { defaultAgent: "claude", platforms: { claude: { mode: "terminal" } } },
      });

    appCommandStore(configStore)
      .getState()
      .setRepositoryConfig("repo-1", {
        defaultBranch: "main",
        prBaseBranch: "main",
        agentSettings: { defaultAgent: "codex", platforms: { claude: { mode: "native" } } },
      });

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]?.agentSettings?.defaultAgent).toBe("codex");
    expect(state.config.repositories["repo-1"]?.agentSettings?.platforms?.claude?.mode).toBe(
      "native",
    );
  });

  test("setRepositoryConfig can clear agent override by omitting fields", () => {
    appCommandStore(configStore)
      .getState()
      .setRepositoryConfig("repo-1", {
        defaultBranch: "main",
        prBaseBranch: "main",
        agentSettings: { defaultAgent: "opencode", platforms: { claude: { mode: "native" } } },
      });

    // Update without agent fields (clearing the override)
    appCommandStore(configStore).getState().setRepositoryConfig("repo-1", {
      defaultBranch: "main",
      prBaseBranch: "main",
    });

    const state = appCommandStore(configStore).getState();
    expect(state.config.repositories["repo-1"]?.agentSettings?.defaultAgent).toBeUndefined();
    expect(
      state.config.repositories["repo-1"]?.agentSettings?.platforms?.claude?.mode,
    ).toBeUndefined();
  });
});
