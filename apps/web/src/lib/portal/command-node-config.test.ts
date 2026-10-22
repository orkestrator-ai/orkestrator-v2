import { afterEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { getConfig, updateGlobalConfig, updateRepositoryConfig } from "@/lib/backend";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "@/types";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function config(owner: string): AppConfig {
  return {
    version: owner,
    global: { terminalScrollback: owner === "command" ? 5_000 : 1_000 } as unknown as GlobalConfig,
    repositories: { [`${owner}-project`]: {} as RepositoryConfig },
  };
}

function installLeafWindow() {
  const portal = {
    invoke: mock(async (_command: string, _args?: Record<string, unknown>) => config("command")),
    listen: mock(() => () => undefined),
  };
  window.orkestratorPortal = portal as never;
  window.orkestratorWorkspaceTarget = { nodeId: "bk_leaf", nodeName: "Leaf", path: "direct" };
  invokeMock.mockImplementation(async () => config("leaf"));
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

  test("on a leaf window the global settings are the command node's, the repositories the leaf's", async () => {
    const portal = installLeafWindow();
    const loaded = await getConfig();
    expect(loaded.global.terminalScrollback).toBe(5_000);
    expect(Object.keys(loaded.repositories)).toEqual(["leaf-project"]);

    const global = { terminalScrollback: 7_000 } as unknown as GlobalConfig;
    await updateGlobalConfig(global);
    expect(portal.invoke).toHaveBeenCalledWith("update_global_config", { global });
    expect(invokeMock).not.toHaveBeenCalledWith("update_global_config", expect.anything());
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
});
