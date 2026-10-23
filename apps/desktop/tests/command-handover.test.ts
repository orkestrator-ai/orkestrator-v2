import { describe, expect, mock, test } from "bun:test";

import type { NodeImportEntry } from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";

import {
  handOverCommandNode,
  previewCommandHandover,
  type CommandHandoverDeps,
} from "../electron/command-handover.js";

const ids: Record<string, BackendId> = {
  local: "bk_mbp3" as BackendId,
  mini: "bk_mini" as BackendId,
  gram: "bk_gram" as BackendId,
};

function entry(name: string): NodeImportEntry {
  return {
    importedFrom: `device:${name}`,
    fallbackName: name,
    verifiedNodeId: ids[name]!,
    routes: [
      { id: "primary" as RouteId, kind: "https", enabled: true, origin: `https://${name}.test` },
    ],
    routeOrder: ["primary" as RouteId],
    token: `token-${name}`,
    enabled: true,
  };
}

function deps(options: { current: string; leafOf?: BackendId; registered?: BackendId[] }) {
  const calls: Array<{ connectionId: string; command: string; args: unknown }> = [];
  const invokeOn = mock(async (connectionId: string, command: string, args: unknown = {}) => {
    calls.push({ connectionId, command, args });
    if (command === "get_node_status") {
      return options.leafOf
        ? {
            mode: "leaf",
            controllers: [{ controllerId: options.leafOf, displayName: "mbp3" }],
            detachedControllers: [],
            mostRecentControllerId: options.leafOf,
          }
        : { mode: "command", controllers: [], detachedControllers: [] };
    }
    if (command === "list_nodes") {
      return {
        nodes: (options.registered ?? []).map((nodeId) => ({
          nodeId,
          connection: { state: "connected" },
        })),
      };
    }
    return { ok: true };
  });
  return {
    calls,
    deps: {
      currentConnectionId: options.current,
      invokeOn: invokeOn as CommandHandoverDeps["invokeOn"],
      installationIdOf: (connectionId: string) => ids[connectionId] ?? null,
      connectionIdOf: (nodeId: BackendId) =>
        Object.entries(ids).find(([, id]) => id === nodeId)?.[0] ?? null,
      machineImportEntry: async (connectionId: string) => entry(connectionId),
    },
  };
}

describe("making another machine the command node", () => {
  test("the window's command node hands over, with the chosen saved machines", async () => {
    const { calls, deps: handover } = deps({ current: "local", registered: [ids.mini!] });
    await handOverCommandNode(handover, {
      targetConnectionId: "mini",
      connectionIds: ["gram", "mini", "local"],
      includeSelf: true,
    });
    const call = calls.find((entry) => entry.command === "hand_over_command")!;
    expect(call.connectionId).toBe("local");
    expect(call.args).toMatchObject({ nodeId: "bk_mini", includeSelf: true });
    // Neither the target nor the handing node is sent as a saved machine.
    expect(
      (call.args as { entries: NodeImportEntry[] }).entries.map((item) => item.fallbackName),
    ).toEqual(["gram"]);
    expect(calls.some((entry) => entry.command === "add_node")).toBe(false);
  });

  test("a target the command node does not control yet is registered first", async () => {
    const { calls, deps: handover } = deps({ current: "local", registered: [] });
    await handOverCommandNode(handover, {
      targetConnectionId: "mini",
      connectionIds: [],
      includeSelf: true,
    });
    const onSource = calls.filter((entry) => entry.connectionId === "local");
    expect(onSource.map((entry) => entry.command)).toEqual([
      "get_node_status",
      "list_nodes",
      "get_node_status",
      "add_node",
      "hand_over_command",
    ]);
    expect(onSource[3]?.args).toMatchObject({ token: "token-mini" });
    // The target is only read: nothing refuses the source there.
    expect(
      calls.filter((entry) => entry.connectionId === "mini").map((entry) => entry.command),
    ).toEqual(["get_node_status", "list_nodes"]);
  });

  test("from a leaf's window, the command node controlling it hands over", async () => {
    const { calls, deps: handover } = deps({
      current: "mini",
      leafOf: ids.local!,
      registered: [ids.mini!],
    });
    const preview = await previewCommandHandover(handover, "mini");
    expect(preview.kind).toBe("preview");
    await handOverCommandNode(handover, {
      targetConnectionId: "mini",
      connectionIds: [],
      includeSelf: true,
    });
    expect(calls.find((entry) => entry.command === "hand_over_command")?.connectionId).toBe(
      "local",
    );
  });

  test("nothing happens when the target already is the command node", async () => {
    const { calls, deps: handover } = deps({ current: "local" });
    expect(await previewCommandHandover(handover, "local")).toEqual({
      kind: "already-command-node",
    });
    expect(
      await handOverCommandNode(handover, {
        targetConnectionId: "local",
        connectionIds: [],
        includeSelf: true,
      }),
    ).toBeNull();
    expect(calls.some((entry) => entry.command === "hand_over_command")).toBe(false);
  });
});

describe("a target that refuses the command node in charge", () => {
  /**
   * mbp3 controls mini, but mini lists mbp3 among its own machines and its
   * user detached mbp3 there, so each refuses the other.
   */
  function looped() {
    const calls: Array<{ connectionId: string; command: string; args: unknown }> = [];
    const mini = { registered: [ids.local!, ids.gram!], detached: [ids.local!] };
    let link: "refused" | "connected" = "refused";
    const invokeOn = (async (connectionId: string, command: string, args: unknown = {}) => {
      calls.push({ connectionId, command, args });
      const nodeId = (args as { nodeId?: BackendId }).nodeId;
      if (connectionId === "mini") {
        if (command === "get_node_status") {
          return {
            mode: "standalone",
            controllers: [],
            detachedControllers: mini.detached.map((controllerId) => ({ controllerId })),
          };
        }
        if (command === "list_nodes") {
          return { nodes: mini.registered.map((id) => ({ nodeId: id })) };
        }
        if (command === "forget_node") {
          mini.registered = mini.registered.filter((id) => id !== nodeId);
          return { forgotten: true, detached: false };
        }
        if (command === "allow_controller") {
          const { controllerId } = args as { controllerId: BackendId };
          mini.detached = mini.detached.filter((id) => id !== controllerId);
          return { allowed: true };
        }
      }
      if (connectionId === "local") {
        if (command === "get_node_status") {
          return { mode: "command", controllers: [], detachedControllers: [] };
        }
        if (command === "list_nodes") {
          return { nodes: [{ nodeId: ids.mini, connection: { state: link } }] };
        }
        if (command === "preview_command_handover") return { targetNodeId: nodeId };
        if (command === "reconnect_node") {
          link =
            mini.registered.includes(ids.local!) || mini.detached.includes(ids.local!)
              ? "refused"
              : "connected";
          return { nodeId, connection: { state: link } };
        }
        if (command === "hand_over_command") {
          if (link !== "connected") throw new Error("mini is not connected");
          return { targetNodeId: nodeId };
        }
      }
      throw new Error(`unexpected ${command} on ${connectionId}`);
    }) as CommandHandoverDeps["invokeOn"];
    const { deps: base } = deps({ current: "local" });
    return { calls, mini, deps: { ...base, invokeOn } };
  }

  test("the preview names the loop without changing anything", async () => {
    const { calls, deps: handover } = looped();
    const result = await previewCommandHandover(handover, "mini");
    expect(result).toMatchObject({
      kind: "preview",
      repairs: ["forget-source-on-target", "allow-source-on-target"],
    });
    // The source's refused link cannot say what mini controls; the device read it.
    expect(calls.find((entry) => entry.command === "preview_command_handover")?.args).toEqual({
      nodeId: ids.mini,
      targetNodeIds: [ids.gram],
    });
    expect(calls.map((entry) => entry.command)).not.toContain("forget_node");
    expect(calls.map((entry) => entry.command)).not.toContain("allow_controller");
  });

  test("confirming clears the loop on the target, reconnects, then hands over", async () => {
    const { calls, mini, deps: handover } = looped();
    await handOverCommandNode(handover, {
      targetConnectionId: "mini",
      connectionIds: [],
      includeSelf: true,
    });
    expect(mini).toEqual({ registered: [ids.gram!], detached: [] });
    const writes = calls
      .filter((entry) => !["get_node_status", "list_nodes"].includes(entry.command))
      .map((entry) => `${entry.connectionId}:${entry.command}`);
    expect(writes).toEqual([
      "mini:forget_node",
      "mini:allow_controller",
      "local:reconnect_node",
      "local:hand_over_command",
    ]);
  });

  test("without its own connection to the target, the device leaves the refusal to the backend", async () => {
    const { calls, deps: handover } = looped();
    const invoke = handover.invokeOn;
    handover.invokeOn = ((connectionId: string, command: string, args?: Record<string, unknown>) =>
      connectionId === "mini"
        ? Promise.reject(new Error("mini is not connected. Connect to it first."))
        : invoke(connectionId, command, args)) as CommandHandoverDeps["invokeOn"];
    const result = await previewCommandHandover(handover, "mini");
    expect(result).toEqual({ kind: "preview", preview: { targetNodeId: ids.mini } as never });
    expect(calls.find((entry) => entry.command === "preview_command_handover")?.args).toEqual({
      nodeId: ids.mini,
    });
  });
});

describe("handover client failure paths", () => {
  test("compensates a target registered by this flow after handover rejection", async () => {
    const { deps: handover } = deps({ current: "local" });
    const calls: string[] = [];
    let added = false;
    handover.invokeOn = (async (_connection: string, command: string) => {
      calls.push(command);
      if (command === "get_node_status")
        return { mode: "command", controllers: [], detachedControllers: [] };
      if (command === "list_nodes")
        return { nodes: added ? [{ nodeId: ids.mini, connection: { state: "connected" } }] : [] };
      if (command === "add_node") {
        added = true;
        return {};
      }
      if (command === "hand_over_command") throw new Error("target rejected handover");
      if (command === "forget_node") {
        added = false;
        return {};
      }
      return {};
    }) as never;
    await expect(
      handOverCommandNode(handover, {
        targetConnectionId: "mini",
        connectionIds: [],
        includeSelf: true,
      }),
    ).rejects.toThrow("target rejected");
    expect(added).toBe(false);
    expect(calls.at(-1)).toBe("forget_node");
  });

  test("does not compensate an ambiguous handover that already removed its target", async () => {
    const { deps: handover } = deps({ current: "local" });
    const calls: string[] = [];
    handover.invokeOn = (async (_connection: string, command: string) => {
      calls.push(command);
      if (command === "get_node_status")
        return { mode: "command", controllers: [], detachedControllers: [] };
      if (command === "list_nodes") return { nodes: [] };
      if (command === "hand_over_command") throw new Error("outcome unknown");
      return {};
    }) as never;
    await expect(
      handOverCommandNode(handover, {
        targetConnectionId: "mini",
        connectionIds: [],
        includeSelf: true,
      }),
    ).rejects.toThrow("outcome unknown");
    expect(calls).not.toContain("forget_node");
  });

  test("an independent standalone source switches directly with registration disabled", async () => {
    const { deps: handover } = deps({ current: "mini" });
    const calls: string[] = [];
    handover.invokeOn = (async (_connection: string, command: string) => {
      calls.push(command);
      if (command === "get_node_status")
        return {
          mode: "standalone",
          registrationEnabled: false,
          controllers: [],
          detachedControllers: [],
        };
      if (command === "list_nodes") return { nodes: [] };
      if (command === "add_node") throw new Error("registration-disabled");
      throw new Error(`unexpected command ${command}`);
    }) as never;
    expect(await previewCommandHandover(handover, "gram")).toEqual({
      kind: "already-command-node",
    });
    expect(
      await handOverCommandNode(handover, {
        targetConnectionId: "gram",
        connectionIds: [],
        includeSelf: true,
      }),
    ).toBeNull();
    expect(calls).not.toContain("add_node");
  });

  test("a leaf with a saved but disconnected remote controller gets a connect-first error", async () => {
    const { deps: handover } = deps({ current: "mini", leafOf: ids.gram });
    const invoke = handover.invokeOn;
    handover.invokeOn = ((connection: string, command: string, args?: Record<string, unknown>) => {
      if (connection === "gram")
        return Promise.reject(new Error("gram is not connected. Connect to it first."));
      return invoke(connection, command, args);
    }) as never;
    await expect(previewCommandHandover(handover, "mini")).rejects.toThrow("Connect to it first");
  });
});
