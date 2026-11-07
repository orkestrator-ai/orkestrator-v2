import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createSignal } from "@/lib/node-scope/signal";
import { NO_ARGS, nodesApi, nodesApiOver } from "./nodes";

function fakeClient(
  domains: NegotiatedDomains | null,
  answer: () => unknown,
): BackendClient & { invokeRaw: ReturnType<typeof mock> } {
  return {
    invokeRaw: mock(async () => answer()) as never,
    domains: createSignal<NegotiatedDomains | null>(domains),
    capabilities: createSignal<ReadonlySet<string> | null>(null),
  };
}

describe("nodes over a lib/backend client", () => {
  test("a node with the domain gets typed calls with the envelope and decoded results", async () => {
    const client = fakeClient({ nodes: { min: 1, max: 1 } }, () => ({
      forgotten: true,
      detached: true,
      newer: "kept",
    }));
    await expect<unknown>(
      nodesApi(client).forget_node({ nodeId: "bk_a", withoutDetach: true }),
    ).resolves.toEqual({ forgotten: true, detached: true, newer: "kept" });
    expect(client.invokeRaw).toHaveBeenCalledWith(
      "forget_node",
      { nodeId: "bk_a", withoutDetach: true },
      { envelope: { domain: "nodes", version: 1, critical: ["withoutDetach"] } },
    );
  });

  test("a pre-contract node gets today's calls, answered as sent", async () => {
    const answer = { older: true };
    const client = fakeClient(null, () => answer);
    await expect<unknown>(nodesApi(client).get_node_status(NO_ARGS)).resolves.toBe(answer);
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual(["get_node_status"]);
    await nodesApi(client).reconnect_node({ nodeId: "bk_a" });
    expect(client.invokeRaw).toHaveBeenLastCalledWith("reconnect_node", { nodeId: "bk_a" });
  });

  test("the portal's bare invoke takes version 0 with today's arguments", async () => {
    const invoke = mock(async (..._call: unknown[]) => ({ revision: 1, nodes: [] }));
    const api = nodesApiOver(invoke as never);
    await api.list_nodes(NO_ARGS);
    await api.list_project_copies({});
    await api.open_node_workspace({ nodeId: "bk_a" });
    expect(invoke.mock.calls).toEqual([
      ["list_nodes"],
      ["list_project_copies"],
      ["open_node_workspace", { nodeId: "bk_a" }],
    ] as never);
  });
});
