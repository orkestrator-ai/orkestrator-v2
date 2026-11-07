import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { invoke } from "@/lib/native/backend";
import { getConfig, patchGlobalConfig, updateGlobalConfig } from "@/lib/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import {
  bindSettingsParent,
  configTargetsFor,
  configTargetsForScopes,
  runCommandNodeSetting,
  runConfigCommand,
  runConfigCommandLayers,
  settingsParent,
} from "@/lib/portal/command-node-config";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "@/types";

type FakeArgs = Readonly<Record<string, unknown>>;

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function config(owner: string): AppConfig {
  return {
    version: owner,
    global: {
      terminalLinkDefaultTarget: owner === "command" ? "browser-tab" : "external",
      terminalScrollback: owner === "command" ? 5_000 : 1_000,
      enabledAgentPlatforms: owner === "command" ? ["codex"] : ["claude"],
      agentSettings: { defaultAgent: "codex" },
      allowedDomains: [`${owner}.test`],
      envFilePatterns: [`.env.${owner}`],
      containerResourceLimits: { maxConcurrentEnvironments: owner === "command" ? 8 : 2 },
      reviewInstruction: owner === "command" ? undefined : "Leaf review",
    } as unknown as GlobalConfig,
    repositories: { [`${owner}-project`]: {} as RepositoryConfig },
  };
}

const initialPortal = portalStore.getState();

/** The command node's own window, editing another machine's settings through it. */
function installCommandWindow() {
  portalStore.store.setState({ ...initialPortal, selfId: "bk_command" as never });
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "invoke_on_node") {
      const routed = args as { command: string; args: Record<string, unknown> };
      return {
        outcome: "ok",
        result: {
          ...config("leaf"),
          ...(routed.args?.global ? { global: routed.args.global as GlobalConfig } : {}),
        },
      };
    }
    return {
      ...config("command"),
      ...(args?.global ? { global: args.global as GlobalConfig } : {}),
    };
  });
}

afterEach(() => {
  portalStore.store.setState(initialPortal);
  invokeMock.mockReset();
  resetWindowScopeForTests();
});

describe("the window's own command node", () => {
  test("on the command node's own workspace they are read and written there", async () => {
    invokeMock.mockImplementation(async () => config("command"));
    expect((await getConfig()).global.terminalScrollback).toBe(5_000);
    expect(invokeMock).toHaveBeenCalledWith("get_config");
  });
});

describe("Settings edits a machine picked in its header", () => {
  test("another machine is read through the command node with its preferences inherited", async () => {
    installCommandWindow();
    const loaded = await getConfig("bk_leaf");
    expect(invokeMock).toHaveBeenCalledWith("invoke_on_node", {
      nodeId: "bk_leaf",
      command: "get_config",
      args: {},
      requestKey: expect.any(String),
    });
    expect(loaded.global.terminalScrollback).toBe(5_000);
    expect(loaded.global.terminalLinkDefaultTarget).toBe("browser-tab");
    expect(loaded.global.allowedDomains).toEqual(["leaf.test"]);
    expect(Object.keys(loaded.repositories)).toEqual(["leaf-project"]);
  });

  test("its machine settings are saved on it and preferences on the command node", async () => {
    installCommandWindow();
    const loaded = await getConfig("bk_leaf");
    await updateGlobalConfig(
      { ...loaded.global, terminalScrollback: 7_000, allowedDomains: ["edited.test"] },
      "bk_leaf",
    );
    expect(invokeMock).toHaveBeenCalledWith("update_global_config", {
      global: expect.objectContaining({
        terminalScrollback: 7_000,
        allowedDomains: ["command.test"],
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("invoke_on_node", {
      nodeId: "bk_leaf",
      command: "update_global_config",
      args: {
        global: expect.objectContaining({ allowedDomains: ["edited.test"] }),
        preserveInheritedSettings: true,
      },
      requestKey: expect.any(String),
    });
  });

  test("the command node, by null or by its own ID, is its own config without a split", async () => {
    installCommandWindow();
    expect((await getConfig(null)).global.allowedDomains).toEqual(["command.test"]);
    expect((await getConfig("bk_command")).global.allowedDomains).toEqual(["command.test"]);
    expect(invokeMock).not.toHaveBeenCalledWith("invoke_on_node", expect.anything());
  });
});

describe("patching global settings", () => {
  test("a plain window sends only the changed keys to its own backend", async () => {
    invokeMock.mockImplementation(async () => config("command"));
    await patchGlobalConfig({ terminalScrollback: 7_000 }, { unset: ["reviewInstruction"] });
    expect(invokeMock).toHaveBeenCalledWith("patch_global_config", {
      patch: { terminalScrollback: 7_000 },
      unset: ["reviewInstruction"],
    });
    expect(invokeMock).not.toHaveBeenCalledWith("update_global_config", expect.anything());
  });

  test("an older backend gets a read-merge-write of the whole object instead", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "patch_global_config") {
        throw new Error(unknownBackendCommandMessage("patch_global_config"));
      }
      return config("leaf");
    });
    await patchGlobalConfig({ terminalScrollback: 7_000 }, { unset: ["reviewInstruction"] });
    const write = invokeMock.mock.calls.find(([command]) => command === "update_global_config");
    expect(write?.[1].global).toMatchObject({
      terminalScrollback: 7_000,
      allowedDomains: ["leaf.test"],
    });
    expect("reviewInstruction" in write![1].global).toBe(false);
  });

  test("other failures are not retried as a whole-object write", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("Select at least one agent platform");
    });
    await expect(patchGlobalConfig({ enabledAgentPlatforms: [] })).rejects.toThrow(
      "Select at least one agent platform",
    );
    expect(invokeMock).not.toHaveBeenCalledWith("update_global_config", expect.anything());
  });

  test("a selected machine's terminal link preferences are saved on the command node, which returns the effective config", async () => {
    installCommandWindow();
    const commandInvoke = invokeMock;
    commandInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "invoke_on_node") return { outcome: "ok", result: config("leaf") };
      if (command === "patch_global_config") {
        return {
          ...config("command"),
          global: { ...config("command").global, ...(args?.patch as Record<string, unknown>) },
        };
      }
      return config("command");
    });
    const saved = await patchGlobalConfig(
      { terminalLinkDefaultTarget: "external" },
      { machine: "bk_leaf" },
    );
    expect(commandInvoke).toHaveBeenCalledWith("patch_global_config", {
      patch: { terminalLinkDefaultTarget: "external" },
    });
    expect(saved.global.terminalLinkDefaultTarget).toBe("external");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "invoke_on_node",
      expect.objectContaining({
        command: "patch_global_config",
      }),
    );
  });

  test("selected-machine Auto-steer edits stay on the command node and return its effective value", async () => {
    installCommandWindow();
    let autoSteer: boolean | undefined;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "invoke_on_node") {
        return {
          outcome: "ok",
          result: { ...config("leaf"), global: { ...config("leaf").global, autoSteer: true } },
        };
      }
      if (command === "patch_global_config") {
        autoSteer = (args?.patch as Partial<GlobalConfig> | undefined)?.autoSteer;
      }
      return { ...config("command"), global: { ...config("command").global, autoSteer } };
    });
    expect(
      (await patchGlobalConfig({ autoSteer: true }, { machine: "bk_leaf" })).global.autoSteer,
    ).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("patch_global_config", { patch: { autoSteer: true } });
    expect(
      (await patchGlobalConfig({}, { unset: ["autoSteer"], machine: "bk_leaf" })).global.autoSteer,
    ).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("patch_global_config", {
      patch: {},
      unset: ["autoSteer"],
    });
    expect(invokeMock).toHaveBeenCalledWith("invoke_on_node", {
      nodeId: "bk_leaf",
      command: "get_config",
      args: {},
      requestKey: expect.any(String),
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "invoke_on_node",
      expect.objectContaining({ command: "patch_global_config" }),
    );
  });
});

describe("layering between two explicit scopes", () => {
  let windowScope: WindowScope;
  let commandClient: FakeNodeClient;
  let leafClient: FakeNodeClient;
  let commandScope: NodeScope;
  let leafScope: NodeScope;

  function fakeNode(nodeId: string, owner: string): FakeNodeClient {
    return new FakeNodeClient({
      nodeId: nodeId as BackendId,
      invoke: {
        get_config: () => config(owner),
        update_global_config: (args: FakeArgs) => ({
          ...config(owner),
          global: args.global as GlobalConfig,
        }),
        patch_global_config: (args: FakeArgs) => ({
          ...config(owner),
          global: { ...config(owner).global, ...(args.patch as Partial<GlobalConfig>) },
        }),
        update_repository_config: () => config(owner),
        set_agent_account_auto_switch: () => ({ ok: true }),
      },
    });
  }

  beforeEach(() => {
    windowScope = new WindowScope();
    commandClient = fakeNode("bk_cmd", "command");
    leafClient = fakeNode("bk_leaf", "leaf");
    commandScope = windowScope.open({ role: "command", client: commandClient });
    leafScope = windowScope.open({ role: "leaf", client: leafClient });
  });

  afterEach(() => windowScope.dispose());

  test("a command-node preference is inherited and the leaf's machine settings win", async () => {
    const loaded = await runConfigCommand(
      configTargetsForScopes(leafScope, commandScope),
      "get_config",
    );
    expect(loaded.global.terminalScrollback).toBe(5_000);
    expect(loaded.global.terminalLinkDefaultTarget).toBe("browser-tab");
    expect(loaded.global.allowedDomains).toEqual(["leaf.test"]);
    expect(loaded.global.enabledAgentPlatforms).toEqual(["claude"]);
    // The command node's default agent is coerced to one the leaf has enabled.
    expect(loaded.global.agentSettings?.defaultAgent).toBe("claude");
    expect(Object.keys(loaded.repositories)).toEqual(["leaf-project"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("a whole-object save sends inherited keys to the command scope and the rest to the leaf", async () => {
    const targets = configTargetsForScopes(leafScope, commandScope);
    const loaded = await runConfigCommand(targets, "get_config");
    const saved = await runConfigCommandLayers(targets, "update_global_config", {
      global: { ...loaded.global, terminalScrollback: 7_000, allowedDomains: ["edited.test"] },
    });
    const [commandWrite] = commandClient.calls("update_global_config");
    expect(commandWrite?.args).toEqual({
      global: expect.objectContaining({
        terminalScrollback: 7_000,
        allowedDomains: ["command.test"],
        agentSettings: { defaultAgent: "codex" },
      }),
    });
    const [leafWrite] = leafClient.calls("update_global_config");
    expect(leafWrite?.args).toEqual({
      global: expect.objectContaining({ allowedDomains: ["edited.test"] }),
      preserveInheritedSettings: true,
    });
    expect(Object.hasOwn(leafWrite!.args.global as object, "terminalScrollback")).toBe(false);
    expect(saved.commandNode.global.terminalScrollback).toBe(7_000);
    expect(saved.node?.global.allowedDomains).toEqual(["edited.test"]);
    expect(saved.config.global.terminalScrollback).toBe(7_000);
    expect(saved.config.global.allowedDomains).toEqual(["edited.test"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("a patch sends each changed key only to the scope that owns it", async () => {
    await runConfigCommand(configTargetsForScopes(leafScope, commandScope), "patch_global_config", {
      patch: { terminalScrollback: 7_000, allowedDomains: ["edited.test"] },
      unset: ["reviewInstruction", "sshAgentSocketPath"],
    });
    expect(commandClient.calls("patch_global_config").map((call) => call.args)).toEqual([
      { patch: { terminalScrollback: 7_000 }, unset: ["reviewInstruction"] },
    ]);
    expect(leafClient.calls("patch_global_config").map((call) => call.args)).toEqual([
      { patch: { allowedDomains: ["edited.test"] }, unset: ["sshAgentSocketPath"] },
    ]);
  });

  test("a leaf without the patch command gets the whole-object write with preserveInheritedSettings", async () => {
    leafClient.respond("patch_global_config", () => {
      throw new Error(unknownBackendCommandMessage("patch_global_config"));
    });
    await runConfigCommand(configTargetsForScopes(leafScope, commandScope), "patch_global_config", {
      patch: { allowedDomains: ["edited.test"] },
    });
    const [write] = leafClient.calls("update_global_config");
    expect(write?.args).toEqual({
      global: expect.objectContaining({
        allowedDomains: ["edited.test"],
        envFilePatterns: [".env.leaf"],
      }),
      preserveInheritedSettings: true,
    });
    expect(commandClient.calls("patch_global_config")).toHaveLength(0);
    expect(commandClient.calls("update_global_config")).toHaveLength(0);
  });

  test("repository settings are written on the leaf with preferences read from the command scope", async () => {
    const saved = await runConfigCommand(
      configTargetsForScopes(leafScope, commandScope),
      "update_repository_config",
      { projectId: "leaf-project", repoConfig: {} },
    );
    expect(leafClient.calls("update_repository_config")).toHaveLength(1);
    expect(commandClient.calls("update_repository_config")).toHaveLength(0);
    expect(commandClient.calls("get_config")).toHaveLength(1);
    expect(saved.global.terminalScrollback).toBe(5_000);
  });

  test("the command scope under itself is its own config, with no split", async () => {
    const targets = configTargetsForScopes(commandScope, commandScope);
    expect(targets.node).toBeNull();
    await runConfigCommand(targets, "patch_global_config", {
      patch: { allowedDomains: ["x.test"] },
    });
    expect(commandClient.calls("patch_global_config")).toHaveLength(1);
    expect(leafClient.invocations).toHaveLength(0);
  });

  test("a command-node setting goes to the command scope", async () => {
    await runCommandNodeSetting(
      configTargetsForScopes(leafScope, commandScope),
      "set_agent_account_auto_switch",
      { platform: "claude", enabled: true },
    );
    expect(commandClient.calls("set_agent_account_auto_switch")).toHaveLength(1);
    expect(leafClient.calls("set_agent_account_auto_switch")).toHaveLength(0);
  });

  test("a scope's settings parent is bound explicitly, or none outside the app window", async () => {
    expect(settingsParent(leafScope)).toBeNull();
    expect(configTargetsFor(leafScope).node).toBeNull();
    bindSettingsParent(leafScope, commandScope);
    expect(settingsParent(leafScope)?.scope).toBe(commandScope);
    await runConfigCommand(configTargetsFor(leafScope), "get_config");
    expect(commandClient.calls("get_config")).toHaveLength(1);
    expect(leafClient.calls("get_config")).toHaveLength(1);
    expect(settingsParent(commandScope)).toBeNull();
  });

  test("a leaf of the app window inherits from the app window's command scope", () => {
    const appWindow = getWindowScope();
    const appLeaf = appWindow.open({ role: "leaf", client: fakeNode("bk_app_leaf", "leaf") });
    expect(settingsParent(appLeaf)?.scope).toBe(appWindow.commandScope());
    // The app window's command scope has no parent.
    expect(settingsParent(appWindow.commandScope())).toBeNull();
  });
});
