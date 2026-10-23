import { afterEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { getConfig, updateGlobalConfig, updateRepositoryConfig } from "@/lib/backend";
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

afterEach(() => {
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
