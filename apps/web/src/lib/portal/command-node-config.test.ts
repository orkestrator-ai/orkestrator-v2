import { afterEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  getConfig,
  patchGlobalConfig,
  updateGlobalConfig,
  updateRepositoryConfig,
} from "@/lib/backend";
import { portalStore } from "@/lib/portal/portal-store";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "@/types";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function config(owner: string): AppConfig {
  return {
    version: owner,
    global: {
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

function installLeafWindow() {
  const portal = {
    invoke: mock(async (_command: string, args?: Record<string, unknown>) => ({
      ...config("command"),
      ...(args?.global ? { global: args.global as GlobalConfig } : {}),
    })),
    listen: mock(() => () => undefined),
  };
  window.orkestratorPortal = portal as never;
  window.orkestratorWorkspaceTarget = { nodeId: "bk_leaf", nodeName: "Leaf", path: "direct" };
  invokeMock.mockImplementation(async (_command: string, args?: Record<string, unknown>) => ({
    ...config("leaf"),
    ...(args?.global ? { global: args.global as GlobalConfig } : {}),
  }));
  return portal;
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
  delete window.orkestratorPortal;
  delete window.orkestratorWorkspaceTarget;
  invokeMock.mockReset();
});

describe("settings belong to the command node", () => {
  test("on the command node's own workspace they are read and written there", async () => {
    invokeMock.mockImplementation(async () => config("command"));
    expect((await getConfig()).global.terminalScrollback).toBe(5_000);
    expect(invokeMock).toHaveBeenCalledWith("get_config");
  });

  test("on a leaf window inherited settings are saved to the command node and machine settings to the leaf", async () => {
    const portal = installLeafWindow();
    const loaded = await getConfig();
    expect(loaded.global.terminalScrollback).toBe(5_000);
    expect(Object.keys(loaded.repositories)).toEqual(["leaf-project"]);

    const global = { ...loaded.global, terminalScrollback: 7_000 };
    await updateGlobalConfig(global);
    expect(portal.invoke).toHaveBeenCalledWith("update_global_config", {
      global: expect.objectContaining({
        terminalScrollback: 7000,
        allowedDomains: ["command.test"],
        enabledAgentPlatforms: ["codex"],
        agentSettings: { defaultAgent: "codex" },
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("update_global_config", {
      global: expect.objectContaining({
        allowedDomains: ["leaf.test"],
        enabledAgentPlatforms: ["claude"],
      }),
      preserveInheritedSettings: true,
    });
  });

  test("on a leaf window repository settings are written to the leaf", async () => {
    const portal = installLeafWindow();
    const saved = await updateRepositoryConfig("leaf-project", {} as RepositoryConfig);
    expect(invokeMock).toHaveBeenCalledWith("update_repository_config", {
      projectId: "leaf-project",
      repoConfig: {},
    });
    expect(portal.invoke).not.toHaveBeenCalledWith("update_repository_config", expect.anything());
    expect(saved.global.terminalScrollback).toBe(5_000);
    expect(Object.keys(saved.repositories)).toEqual(["leaf-project"]);
  });
  test("workspace consumers retain leaf machine values and only inherit preference keys", async () => {
    installLeafWindow();
    const loaded = await getConfig();
    expect(loaded.global.enabledAgentPlatforms).toEqual(["claude"]);
    expect(loaded.global.agentSettings?.defaultAgent).toBe("claude");
    expect(loaded.global.allowedDomains).toEqual(["leaf.test"]);
    expect(loaded.global.envFilePatterns).toEqual([".env.leaf"]);
    expect(loaded.global.containerResourceLimits).toEqual(
      config("leaf").global.containerResourceLimits,
    );
    expect(loaded.global.reviewInstruction).toBeUndefined();
    const saved = await updateRepositoryConfig("leaf-project", {} as RepositoryConfig);
    expect(saved.global.allowedDomains).toEqual(["leaf.test"]);
    expect(saved.global.containerResourceLimits).toEqual(
      config("leaf").global.containerResourceLimits,
    );
  });

  test("paired read failure prevents global mutation and is visible to callers", async () => {
    const portal = installLeafWindow();
    invokeMock.mockImplementation(async () => {
      throw new Error("Workspace unavailable");
    });
    await expect(updateGlobalConfig(config("leaf").global)).rejects.toThrow(
      "Workspace unavailable",
    );
    expect(portal.invoke).not.toHaveBeenCalledWith("update_global_config", expect.anything());
    await expect(getConfig()).rejects.toThrow("Workspace unavailable");
  });

  test("reports partial failure after the command-node save succeeds", async () => {
    const portal = installLeafWindow();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "update_global_config") throw new Error("Leaf save failed");
      return config("leaf");
    });
    await expect(
      updateGlobalConfig({ ...(await getConfig()).global, terminalScrollback: 7000 }),
    ).rejects.toThrow("Leaf save failed");
    expect(portal.invoke).toHaveBeenCalledWith("update_global_config", expect.anything());
  });
  test("editing agent preferences preserves an unchanged leaf-coerced command default", async () => {
    const portal = installLeafWindow();
    const loaded = await getConfig();
    await updateGlobalConfig({
      ...loaded.global,
      agentSettings: { ...loaded.global.agentSettings, platforms: { claude: { mode: "native" } } },
    });
    expect(portal.invoke).toHaveBeenCalledWith("update_global_config", {
      global: expect.objectContaining({
        agentSettings: expect.objectContaining({
          defaultAgent: "codex",
          platforms: { claude: { mode: "native" } },
        }),
      }),
    });
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
        throw new Error("Unknown command: patch_global_config");
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

  test("a leaf window routes inherited keys to the command node and the rest to the leaf", async () => {
    const portal = installLeafWindow();
    await patchGlobalConfig(
      { terminalScrollback: 7_000, allowedDomains: ["edited.test"] },
      { unset: ["reviewInstruction", "sshAgentSocketPath"] },
    );
    expect(portal.invoke).toHaveBeenCalledWith("patch_global_config", {
      patch: { terminalScrollback: 7_000 },
      unset: ["reviewInstruction"],
    });
    expect(invokeMock).toHaveBeenCalledWith("patch_global_config", {
      patch: { allowedDomains: ["edited.test"] },
      unset: ["sshAgentSocketPath"],
    });
  });

  test("a leaf window writes nothing to a node with no changed keys", async () => {
    const portal = installLeafWindow();
    await patchGlobalConfig({ allowedDomains: ["edited.test"] });
    expect(portal.invoke).not.toHaveBeenCalledWith("patch_global_config", expect.anything());
    expect(portal.invoke).toHaveBeenCalledWith("get_config", undefined);
  });

  test("an unchanged leaf-coerced default agent keeps the command node's", async () => {
    const portal = installLeafWindow();
    const loaded = await getConfig();
    await patchGlobalConfig({
      agentSettings: { ...loaded.global.agentSettings, platforms: { claude: { mode: "native" } } },
    });
    expect(portal.invoke).toHaveBeenCalledWith("patch_global_config", {
      patch: {
        agentSettings: expect.objectContaining({
          defaultAgent: "codex",
          platforms: { claude: { mode: "native" } },
        }),
      },
    });
  });
});
