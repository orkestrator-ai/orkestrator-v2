import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { bindSettingsParent } from "@/lib/portal/command-node-config";
import { requestResourceResync } from "@/lib/resource-sync";
import { startStoreResourceSync } from "@/lib/store-resource-sync";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { configStore, effectiveConfig, runScopedConfigCommand } from "./configStore";
import { defaultConfig } from "../../../backend/src/core/storage";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "../types";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "@orkestrator/protocol/agent-mail";
import { appCommandStore } from "@/test/app-command-store";

type FakeArgs = Readonly<Record<string, unknown>>;

// `getInitialState()` returns the store's DEFAULT_CONFIG regardless of any
// mutations other tests may have applied, so these assertions are isolation-safe.
const initialGlobal = appCommandStore(configStore).getInitialState().config.global;

describe("configStore DEFAULT_CONFIG defaults", () => {
  test("uses the current default model selection", () => {
    const platforms = initialGlobal.agentSettings?.platforms;
    // Unset: OpenCode's connected, allowlisted default.
    expect(platforms?.opencode).toEqual({ mode: "terminal" });
    expect(platforms?.claude?.model).toBe("claude-sonnet-5-5");
    expect(platforms?.codex?.model).toBe("gpt-5.4");
    expect(platforms?.codex?.reasoningEffort).toBe("high");
    expect(initialGlobal.codexMaxConcurrentThreads).toBe(5);
    expect(initialGlobal.useHostGitHubCredentials).toBe(true);
    expect(platforms?.claude?.mode).toBe("native");
    expectTypeOf<GlobalConfig["codexMaxConcurrentThreads"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<GlobalConfig["useHostGitHubCredentials"]>().toEqualTypeOf<boolean | undefined>();
  });

  test("does not default to any retired model id", () => {
    const selected = [
      initialGlobal.agentSettings?.platforms?.opencode?.model,
      initialGlobal.agentSettings?.platforms?.claude?.model,
      initialGlobal.agentSettings?.platforms?.codex?.model,
    ];
    for (const retired of ["opencode/grok-code", "claude-sonnet-4-6", "gpt-5.3-codex"]) {
      expect(selected).not.toContain(retired);
    }
  });

  test("seeds the backend's new-install allowlist, not a renderer copy", () => {
    expect(initialGlobal.allowedDomains).toEqual(defaultConfig().global.allowedDomains);
  });

  // Guards the drift the settings UI depends on: GlobalSettings falls back to
  // these renderer defaults, while the backend persists defaultConfig(). Both
  // now come from one protocol builder; compare the whole config so a future
  // second copy on either side fails here rather than in a user's first run.
  test("is exactly the backend's new-install defaultConfig()", () => {
    expect(appCommandStore(configStore).getInitialState().config).toEqual(defaultConfig());
  });

  test("uses the protocol's agent messaging defaults", () => {
    expect(initialGlobal.agentMessaging).toEqual({ ...DEFAULT_AGENT_MESSAGING_SETTINGS });
    expect(initialGlobal.agentMessaging?.wakePeers).toBe(false);
  });
});

describe("configStore review instruction updates", () => {
  beforeEach(() => {
    appCommandStore(configStore).setState({
      config: structuredClone(appCommandStore(configStore).getInitialState().config),
      isLoading: false,
      error: null,
    });
  });

  test("sets and removes a custom review instruction without changing sibling config", () => {
    const originalAgent =
      appCommandStore(configStore).getState().config.global.agentSettings?.defaultAgent;

    appCommandStore(configStore).getState().updateGlobalConfig({
      reviewInstruction: "Review {{targetBranch}}.",
    });
    expect(appCommandStore(configStore).getState().config.global.reviewInstruction).toBe(
      "Review {{targetBranch}}.",
    );

    appCommandStore(configStore).getState().updateGlobalConfig({ reviewInstruction: undefined });
    const global = appCommandStore(configStore).getState().config.global;
    expect(global.reviewInstruction).toBeUndefined();
    expect(Object.hasOwn(global, "reviewInstruction")).toBe(false);
    expect(global.agentSettings?.defaultAgent).toBe(originalAgent);
  });
});

describe("configStore per node scope", () => {
  const COMMAND = "bk_config-command" as BackendId;
  const LEAF = "bk_config-leaf" as BackendId;

  function nodeConfig(owner: "command" | "leaf"): AppConfig {
    const base = structuredClone(appCommandStore(configStore).getInitialState().config);
    return {
      ...base,
      global: {
        ...base.global,
        terminalScrollback: owner === "command" ? 5_000 : 1_000,
        allowedDomains: [`${owner}.test`],
        enabledAgentPlatforms: owner === "command" ? ["codex", "claude"] : ["claude"],
        agentSettings: { ...base.global.agentSettings, defaultAgent: "codex" },
      },
      repositories: { [`${owner}-project`]: {} as RepositoryConfig },
    };
  }

  function fakeNode(nodeId: BackendId, owner: "command" | "leaf"): FakeNodeClient {
    let stored = nodeConfig(owner);
    return new FakeNodeClient({
      nodeId,
      invoke: {
        get_config: () => stored,
        patch_global_config: (args: FakeArgs) => {
          stored = {
            ...stored,
            global: { ...stored.global, ...(args.patch as Partial<GlobalConfig>) },
          };
          return stored;
        },
      },
    });
  }

  let windowScope: WindowScope;
  let commandClient: FakeNodeClient;
  let leafClient: FakeNodeClient;
  let commandScope: NodeScope;
  let leafScope: NodeScope;

  beforeEach(() => {
    windowScope = new WindowScope();
    commandClient = fakeNode(COMMAND, "command");
    leafClient = fakeNode(LEAF, "leaf");
    commandScope = windowScope.open({ role: "command", client: commandClient });
    leafScope = windowScope.open({ role: "leaf", client: leafClient });
    bindSettingsParent(leafScope, commandScope);
  });

  afterEach(() => {
    windowScope.dispose();
    resetWindowScopeForTests();
  });

  test("each scope keeps its own config", () => {
    commandScope.store(configStore).getState().setConfig(nodeConfig("command"));
    const other = new WindowScope();
    try {
      const unrelated = other.open({ role: "command", client: fakeNode(LEAF, "leaf") });
      expect(unrelated.store(configStore).getState().config.global.terminalScrollback).not.toBe(
        5_000,
      );
      expect(unrelated.store(configStore).getState().hasLoaded).toBe(false);
    } finally {
      other.dispose();
    }
    expect(commandScope.store(configStore).getState().hasLoaded).toBe(true);
  });

  test("a leaf inherits the command scope's preferences and keeps its machine settings", () => {
    commandScope.store(configStore).getState().setConfig(nodeConfig("command"));
    const leaf = leafScope.store(configStore);
    leaf.getState().setConfig(nodeConfig("leaf"));

    const shown = leaf.getState().config.global;
    expect(shown.terminalScrollback).toBe(5_000);
    expect(shown.allowedDomains).toEqual(["leaf.test"]);
    expect(shown.enabledAgentPlatforms).toEqual(["claude"]);
    // The command node's default agent, coerced to one the leaf has enabled.
    expect(shown.agentSettings?.defaultAgent).toBe("claude");
    expect(Object.keys(leaf.getState().config.repositories)).toEqual(["leaf-project"]);
    expect(effectiveConfig(leafScope)).toEqual(leaf.getState().config);
    expect(effectiveConfig(leafScope, commandScope)).toEqual(leaf.getState().config);
    // The command scope under itself is its own config.
    expect(effectiveConfig(commandScope).global.allowedDomains).toEqual(["command.test"]);
  });

  test("a leaf follows the command scope's preference changes until it is disposed", () => {
    const command = commandScope.store(configStore);
    command.getState().setConfig(nodeConfig("command"));
    const leaf = leafScope.store(configStore);
    leaf.getState().setConfig(nodeConfig("leaf"));

    command
      .getState()
      .updateGlobalConfig({ terminalScrollback: 9_000, allowedDomains: ["x.test"] });
    expect(leaf.getState().config.global.terminalScrollback).toBe(9_000);
    // A command-node machine setting never reaches the leaf.
    expect(leaf.getState().config.global.allowedDomains).toEqual(["leaf.test"]);

    leafScope.dispose();
    command.getState().updateGlobalConfig({ terminalScrollback: 3_000 });
    expect(leaf.getState().config.global.terminalScrollback).toBe(9_000);
  });

  test("an optimistic inherited update on the leaf shows at once", () => {
    commandScope.store(configStore).getState().setConfig(nodeConfig("command"));
    const leaf = leafScope.store(configStore);
    leaf.getState().setConfig(nodeConfig("leaf"));
    leaf.getState().updateGlobalConfig({ terminalScrollback: 4_000 });
    expect(leaf.getState().config.global.terminalScrollback).toBe(4_000);
    leaf.getState().setRepositoryConfig("other", {} as RepositoryConfig);
    expect(Object.keys(leaf.getState().config.repositories).sort()).toEqual([
      "leaf-project",
      "other",
    ]);
    leaf.getState().removeRepositoryConfig("leaf-project");
    expect(Object.keys(leaf.getState().config.repositories)).toEqual(["other"]);
  });

  test("a split save reaches each scope's client and leaves each store with its node's answer", async () => {
    const saved = await runScopedConfigCommand(
      { scope: leafScope, commandScope },
      "patch_global_config",
      {
        patch: { terminalScrollback: 7_000, allowedDomains: ["edited.test"] },
      },
    );
    expect(commandClient.calls("patch_global_config").map((call) => call.args)).toEqual([
      { patch: { terminalScrollback: 7_000 } },
    ]);
    expect(leafClient.calls("patch_global_config").map((call) => call.args)).toEqual([
      { patch: { allowedDomains: ["edited.test"] } },
    ]);
    expect(saved.global.terminalScrollback).toBe(7_000);
    expect(saved.global.allowedDomains).toEqual(["edited.test"]);
    const command = commandScope.store(configStore).getState().config.global;
    expect(command.terminalScrollback).toBe(7_000);
    expect(command.allowedDomains).toEqual(["command.test"]);
    expect(leafScope.store(configStore).getState().config).toEqual(saved);
  });

  test("a leaf scope's own sync reads its node's config and lays the command scope's over it", async () => {
    commandScope.store(configStore).getState().setConfig(nodeConfig("command"));
    const stop = startStoreResourceSync({}, { scope: leafScope });
    try {
      requestResourceResync(leafScope);
      const leaf = leafScope.store(configStore);
      for (let attempt = 0; attempt < 50 && !leaf.getState().hasLoaded; attempt++) {
        await Promise.resolve();
      }
      expect(leafClient.calls("get_config")).toHaveLength(1);
      expect(commandClient.calls("get_config")).toHaveLength(0);
      expect(leaf.getState().config.global.allowedDomains).toEqual(["leaf.test"]);
      expect(leaf.getState().config.global.terminalScrollback).toBe(5_000);
    } finally {
      stop();
    }
  });

  test("the deprecated statics reach the app's command scope", () => {
    const app = getWindowScope().commandScope();
    appCommandStore(configStore).getState().setConfig(nodeConfig("command"));
    expect(app.store(configStore).getState().config.global.terminalScrollback).toBe(5_000);
    expect(leafScope.store(configStore).getState().hasLoaded).toBe(false);
  });
});
