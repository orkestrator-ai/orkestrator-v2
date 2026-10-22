import { describe, expect, mock, test } from "bun:test";

import type { NodeImportEntry } from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";

import { handOverCommandNode, previewCommandHandover } from "../electron/command-handover.js";

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
            mostRecentControllerId: options.leafOf,
          }
        : { mode: "command", controllers: [] };
    }
    if (command === "list_nodes") {
      return { nodes: (options.registered ?? []).map((nodeId) => ({ nodeId })) };
    }
    return { ok: true };
  });
  return {
    calls,
    deps: {
      currentConnectionId: options.current,
      invokeOn: invokeOn as never,
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
    expect(calls.map((entry) => entry.command)).toEqual([
      "get_node_status",
      "list_nodes",
      "add_node",
      "hand_over_command",
    ]);
    expect(calls[2]?.args).toMatchObject({ token: "token-mini" });
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
