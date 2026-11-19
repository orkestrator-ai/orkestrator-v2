import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import {
  configTargetsForScopes,
  readSettingSourcesLayers,
  runResetGlobalSettings,
} from "@/lib/portal/command-node-config";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { AppConfig, GlobalConfig } from "@/types";

type FakeArgs = Readonly<Record<string, unknown>>;

function config(owner: string, global: Partial<GlobalConfig> = {}): AppConfig {
  return {
    version: owner,
    global: {
      enabledAgentPlatforms: ["claude"],
      agentSettings: { defaultAgent: "claude" },
      terminalScrollback: owner === "command" ? 5_000 : 1_000,
      ...global,
    } as GlobalConfig,
    repositories: {},
  };
}

describe("setting sources and resets across two nodes", () => {
  let windowScope: WindowScope;
  let commandScope: NodeScope;
  let leafScope: NodeScope;
  let commandClient: FakeNodeClient;
  let leafClient: FakeNodeClient;
  let commandStored: Partial<GlobalConfig>;
  let leafStored: Partial<GlobalConfig>;

  function fakeNode(
    nodeId: string,
    owner: string,
    stored: () => Partial<GlobalConfig>,
    reset: (args: FakeArgs) => { status: "reset" | "conflict"; conflicts: string[] },
  ) {
    return new FakeNodeClient({
      nodeId: nodeId as BackendId,
      invoke: {
        get_config: () => config(owner, stored()),
        get_global_setting_sources: () => ({
          storedKeys: Object.keys(stored()).sort(),
          inheritedKeys: null,
        }),
        reset_global_settings: (args: FakeArgs) => ({
          ...reset(args),
          config: config(owner, stored()),
        }),
      },
    });
  }

  beforeEach(() => {
    commandStored = { autoSteer: true };
    leafStored = { debugLogging: true, autoSteer: false };
    windowScope = new WindowScope();
    commandClient = fakeNode(
      "bk_cmd",
      "command",
      () => commandStored,
      (args) => {
        for (const key of args.keys as string[])
          delete (commandStored as Record<string, unknown>)[key];
        return { status: "reset", conflicts: [] };
      },
    );
    leafClient = fakeNode(
      "bk_leaf",
      "leaf",
      () => leafStored,
      (args) => {
        const expectation = (args.expect as Array<{ key: string; value?: unknown }>)[0]!;
        const current = (leafStored as Record<string, unknown>)[expectation.key];
        if (current !== expectation.value)
          return { status: "conflict", conflicts: [expectation.key] };
        for (const key of args.keys as string[])
          delete (leafStored as Record<string, unknown>)[key];
        return { status: "reset", conflicts: [] };
      },
    );
    commandScope = windowScope.open({ role: "command", client: commandClient });
    leafScope = windowScope.open({ role: "leaf", client: leafClient });
  });

  afterEach(() => windowScope.dispose());

  test("reads both nodes' stored keys", async () => {
    const layers = await readSettingSourcesLayers(configTargetsForScopes(leafScope, commandScope));
    expect(layers.commandNode).toEqual({
      status: "ok",
      sources: { storedKeys: ["autoSteer"], inheritedKeys: null },
    });
    expect(layers.node).toEqual({
      status: "ok",
      sources: { storedKeys: ["autoSteer", "debugLogging"], inheritedKeys: null },
    });
  });

  test("a node that predates the read answers unsupported, not empty", async () => {
    const older = new FakeNodeClient({
      nodeId: "bk_old" as BackendId,
      invoke: {
        get_global_setting_sources: () => {
          throw new Error(unknownBackendCommandMessage("get_global_setting_sources"));
        },
      },
    });
    const olderScope = windowScope.open({ role: "leaf", client: older });
    const layers = await readSettingSourcesLayers(configTargetsForScopes(olderScope, commandScope));
    expect(layers.node).toEqual({ status: "unsupported" });
    expect(layers.commandNode.status).toBe("ok");
  });

  test("an inherited preference is reset on the command node, never the leaf", async () => {
    const outcome = await runResetGlobalSettings(
      configTargetsForScopes(leafScope, commandScope),
      ["autoSteer"],
      [{ key: "autoSteer", present: true, value: true }],
    );
    expect(outcome.status).toBe("reset");
    expect(commandClient.calls("reset_global_settings")).toHaveLength(1);
    expect(commandClient.calls("reset_global_settings")[0]?.args).toEqual({
      keys: ["autoSteer"],
      expect: [{ key: "autoSteer", present: true, value: true }],
    });
    expect(leafClient.calls("reset_global_settings")).toHaveLength(0);
    // The leaf's own copy underneath is untouched.
    expect(leafStored.autoSteer).toBe(false);
  });

  test("a machine setting is reset on the machine, and a moved value is a conflict", async () => {
    const targets = configTargetsForScopes(leafScope, commandScope);
    const conflict = await runResetGlobalSettings(
      targets,
      ["debugLogging"],
      [{ key: "debugLogging", present: true, value: false }],
    );
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflicts).toEqual(["debugLogging"]);
    expect(leafStored.debugLogging).toBe(true);
    expect(commandClient.calls("reset_global_settings")).toHaveLength(0);

    const reset = await runResetGlobalSettings(
      targets,
      ["debugLogging"],
      [{ key: "debugLogging", present: true, value: true }],
    );
    expect(reset.status).toBe("reset");
    expect(leafStored.debugLogging).toBeUndefined();
    // The answer is the layered view: the leaf's own machine settings, the command node's preferences.
    expect(reset.config.global.terminalScrollback).toBe(5_000);
  });
});
