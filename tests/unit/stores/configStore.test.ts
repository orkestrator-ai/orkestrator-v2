import { describe, test, expect, beforeEach } from "bun:test";
import { useConfigStore } from "../../../apps/web/src/stores/configStore";
import type { RepositoryConfig } from "../../../apps/web/src/types";

describe("configStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: {
            cpuCores: 2,
            memoryGb: 4,
          },
          envFilePatterns: [".env.local", ".env"],
          experimentalCodexRawEventLogging: true,
          agentSettings: { platforms: { claude: { model: "claude-sonnet-4-6" } } },
        },
        repositories: {},
      },
      isLoading: false,
      error: null,
    });
  });

  test("initial state has default config", () => {
    const state = useConfigStore.getState();
    expect(state.config.version).toBe("1.0");
    expect(state.config.global.containerResources.cpuCores).toBe(2);
    expect(state.config.global.containerResources.memoryGb).toBe(4);
    expect(state.config.global.envFilePatterns).toEqual([".env.local", ".env"]);
    expect(state.config.global.experimentalCodexRawEventLogging).toBe(true);
    expect(state.config.global.agentSettings?.platforms?.claude?.model).toBe("claude-sonnet-4-6");
    expect(state.config.repositories).toEqual({});
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  test("setConfig replaces entire config", () => {
    const newConfig = {
      version: "2.0",
      global: {
        containerResources: {
          cpuCores: 4,
          memoryGb: 8,
        },
        envFilePatterns: [".env"],
      },
      repositories: {
        "repo-1": {
          defaultBranch: "main",
          prBaseBranch: "develop",
        },
      },
    };

    useConfigStore.getState().setConfig(newConfig);

    const state = useConfigStore.getState();
    expect(state.config).toEqual(newConfig);
  });

  test("setConfig preserves state and config identity for equal data", () => {
    const before = useConfigStore.getState();
    const equalConfig = JSON.parse(JSON.stringify(before.config));

    before.setConfig(equalConfig);

    const after = useConfigStore.getState();
    expect(after).toBe(before);
    expect(after.config).toBe(before.config);
  });

  test("setConfig ignores a config whose keys arrive in a different order", () => {
    // A serialized compare is key-order sensitive, so a backend snapshot that
    // reordered its keys would republish identical data and rerender every
    // subscriber.
    const before = useConfigStore.getState();
    const reorderKeys = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;
    const reorderedConfig = reorderKeys({
      ...before.config,
      global: reorderKeys(before.config.global),
    });
    expect(Object.keys(reorderedConfig)).not.toEqual(Object.keys(before.config));

    before.setConfig(reorderedConfig);

    const after = useConfigStore.getState();
    expect(after).toBe(before);
    expect(after.config).toBe(before.config);
  });

  test("setConfig adopts a config that only differs by an explicitly undefined field", () => {
    // This store distinguishes present-but-undefined from absent (see
    // updateGlobalConfig, which deletes reviewInstruction rather than assigning
    // undefined). A serialized compare erases the difference and would keep the
    // stale object.
    const before = useConfigStore.getState();
    expect(Object.hasOwn(before.config.global, "reviewInstruction")).toBe(false);

    before.setConfig({
      ...before.config,
      global: { ...before.config.global, reviewInstruction: undefined },
    });

    const after = useConfigStore.getState();
    expect(after.config).not.toBe(before.config);
    expect(Object.hasOwn(after.config.global, "reviewInstruction")).toBe(true);
  });

  test("updateGlobalConfig partially updates global config", () => {
    useConfigStore.getState().updateGlobalConfig({
      containerResources: {
        cpuCores: 8,
        memoryGb: 16,
      },
    });

    const state = useConfigStore.getState();
    expect(state.config.global.containerResources.cpuCores).toBe(8);
    expect(state.config.global.containerResources.memoryGb).toBe(16);
    // Original envFilePatterns should be preserved
    expect(state.config.global.envFilePatterns).toEqual([".env.local", ".env"]);
  });

  test("updateGlobalConfig preserves other global fields", () => {
    useConfigStore.setState((state) => ({
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

    useConfigStore.getState().updateGlobalConfig({
      envFilePatterns: [".env.production"],
    });

    const state = useConfigStore.getState();
    // Container resources should be preserved
    expect(state.config.global.containerResources.cpuCores).toBe(2);
    expect(state.config.global.containerResources.memoryGb).toBe(4);
    expect(state.config.global.envFilePatterns).toEqual([".env.production"]);
    expect(state.config.global.agentSettings?.platforms?.codex?.mode).toBe("native");
  });

  test("updateGlobalConfig updates the Codex mode", () => {
    useConfigStore.setState((state) => ({
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

    useConfigStore.getState().updateGlobalConfig({
      agentSettings: { platforms: { codex: { mode: "terminal" } } },
    });

    expect(useConfigStore.getState().config.global.agentSettings?.platforms?.codex?.mode).toBe(
      "terminal",
    );
  });

  test("updateGlobalConfig updates the Claude model", () => {
    useConfigStore.getState().updateGlobalConfig({
      agentSettings: { platforms: { claude: { model: "default" } } },
    });

    expect(useConfigStore.getState().config.global.agentSettings?.platforms?.claude?.model).toBe(
      "default",
    );
  });

  test("updateGlobalConfig updates experimentalCodexRawEventLogging", () => {
    useConfigStore.getState().updateGlobalConfig({
      experimentalCodexRawEventLogging: false,
    });

    expect(useConfigStore.getState().config.global.experimentalCodexRawEventLogging).toBe(false);
  });

  test("updateGlobalConfig updates web client enablement", () => {
    useConfigStore.getState().updateGlobalConfig({ webClientEnabled: false });

    expect(useConfigStore.getState().config.global.webClientEnabled).toBe(false);
  });

  test("setRepositoryConfig adds a new repository config", () => {
    const repoConfig: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "develop",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", repoConfig);

    const state = useConfigStore.getState();
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

    useConfigStore.getState().setRepositoryConfig("repo-1", initialConfig);
    useConfigStore.getState().setRepositoryConfig("repo-1", updatedConfig);

    const state = useConfigStore.getState();
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

    useConfigStore.getState().setRepositoryConfig("repo-1", config1);
    useConfigStore.getState().setRepositoryConfig("repo-2", config2);

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]).toEqual(config1);
    expect(state.config.repositories["repo-2"]).toEqual(config2);
  });

  test("setRepositoryLastEnvironmentType preserves existing repository config", () => {
    useConfigStore.getState().setRepositoryConfig("repo-1", {
      defaultBranch: "develop",
      prBaseBranch: "release",
      defaultPortMappings: [{ containerPort: 3000, hostPort: 4000, protocol: "tcp" }],
    });

    useConfigStore.getState().setRepositoryLastEnvironmentType("repo-1", "local");

    expect(useConfigStore.getState().config.repositories["repo-1"]).toEqual({
      defaultBranch: "develop",
      prBaseBranch: "release",
      lastEnvironmentType: "local",
      defaultPortMappings: [{ containerPort: 3000, hostPort: 4000, protocol: "tcp" }],
    });
  });

  test("setRepositoryLastEnvironmentType creates a default repository config when missing", () => {
    useConfigStore.getState().setRepositoryLastEnvironmentType("repo-1", "containerized");

    expect(useConfigStore.getState().config.repositories["repo-1"]).toEqual({
      defaultBranch: "main",
      prBaseBranch: "main",
      lastEnvironmentType: "containerized",
    });
  });

  test("removeRepositoryConfig removes the specified repository", () => {
    const config: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", config);
    useConfigStore.getState().removeRepositoryConfig("repo-1");

    const state = useConfigStore.getState();
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

    useConfigStore.getState().setRepositoryConfig("repo-1", config1);
    useConfigStore.getState().setRepositoryConfig("repo-2", config2);
    useConfigStore.getState().removeRepositoryConfig("repo-1");

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]).toBeUndefined();
    expect(state.config.repositories["repo-2"]).toEqual(config2);
  });

  test("removeRepositoryConfig handles non-existent repository", () => {
    useConfigStore.getState().removeRepositoryConfig("non-existent");

    const state = useConfigStore.getState();
    expect(state.config.repositories).toEqual({});
  });

  test("getRepositoryConfig returns the correct config", () => {
    const config: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "develop",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", config);

    const result = useConfigStore.getState().getRepositoryConfig("repo-1");
    expect(result).toEqual(config);
  });

  test("getRepositoryConfig returns undefined for non-existent repository", () => {
    const result = useConfigStore.getState().getRepositoryConfig("non-existent");
    expect(result).toBeUndefined();
  });

  test("setLoading updates loading state", () => {
    useConfigStore.getState().setLoading(true);
    expect(useConfigStore.getState().isLoading).toBe(true);

    useConfigStore.getState().setLoading(false);
    expect(useConfigStore.getState().isLoading).toBe(false);
  });

  test("setError updates error state", () => {
    useConfigStore.getState().setError("Test error");
    expect(useConfigStore.getState().error).toBe("Test error");

    useConfigStore.getState().setError(null);
    expect(useConfigStore.getState().error).toBeNull();
  });

  test("setRepositoryConfig stores project-level agent override", () => {
    const repoConfig: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: { defaultAgent: "opencode", platforms: { claude: { mode: "native" } } },
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", repoConfig);

    const state = useConfigStore.getState();
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

    useConfigStore.getState().setRepositoryConfig("repo-1", repoConfig);

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]?.agentSettings?.defaultAgent).toBeUndefined();
    expect(
      state.config.repositories["repo-1"]?.agentSettings?.platforms?.claude?.mode,
    ).toBeUndefined();
  });

  test("setRepositoryConfig can update agent override to a different value", () => {
    useConfigStore.getState().setRepositoryConfig("repo-1", {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: { defaultAgent: "claude", platforms: { claude: { mode: "terminal" } } },
    });

    useConfigStore.getState().setRepositoryConfig("repo-1", {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: { defaultAgent: "codex", platforms: { claude: { mode: "native" } } },
    });

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]?.agentSettings?.defaultAgent).toBe("codex");
    expect(state.config.repositories["repo-1"]?.agentSettings?.platforms?.claude?.mode).toBe(
      "native",
    );
  });

  test("setRepositoryConfig can clear agent override by omitting fields", () => {
    useConfigStore.getState().setRepositoryConfig("repo-1", {
      defaultBranch: "main",
      prBaseBranch: "main",
      agentSettings: { defaultAgent: "opencode", platforms: { claude: { mode: "native" } } },
    });

    // Update without agent fields (clearing the override)
    useConfigStore.getState().setRepositoryConfig("repo-1", {
      defaultBranch: "main",
      prBaseBranch: "main",
    });

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]?.agentSettings?.defaultAgent).toBeUndefined();
    expect(
      state.config.repositories["repo-1"]?.agentSettings?.platforms?.claude?.mode,
    ).toBeUndefined();
  });
});
