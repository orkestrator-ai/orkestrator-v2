/**
 * The whole cancel chain of a routed read, end to end (to-do 7543 task 6):
 * a client leaves the command node's gateway, the gateway aborts the call's
 * signal, the real backend registry hands it to `invoke_on_node`, the node
 * portal and `routeToNode` forward it to the node link, the link aborts its
 * request, and the leaf's own gateway sees its client go away and aborts the
 * leaf call's signal.
 *
 * Real here: both gateways (HTTP sockets), `OrkestratorBackend` and its
 * command registry on the command node, `NodePortal`, `routeToNode`,
 * `NodeService` and `NodeLink`. The test node network stands in only for the
 * leaf's hello and authentication; its `get_machine_load` forwards the
 * link's request, with the link's own signal, to the leaf's real gateway.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";
import type { CommandContext } from "../src/core/commands-context.js";
import { OrkestratorBackend } from "../src/core/index.js";
import { NodeOutcomeUnknownError } from "../src/core/nodes/node-link.js";
import {
  settle,
  stopTestNodeNetworks,
  TestNodeNetwork,
} from "../src/core/nodes/node-network-test-support.js";
import { startGateway, waitUntil } from "./gateway-test-harness.js";

// Stop every node a test left running; see `stopTestNodeNetworks`.
afterEach(stopTestNodeNetworks);

/** The leaf's backend: `get_machine_load` answers only once its caller leaves. */
function leafBackend() {
  const signals: AbortSignal[] = [];
  const reached = Promise.withResolvers<void>();
  return {
    signals,
    reached: reached.promise,
    backend: {
      invoke: async (command: string, _args: Record<string, unknown>, ...rest: unknown[]) => {
        if (command !== "get_machine_load") throw new Error(`Unexpected ${command}`);
        const signal = (rest[0] as { signal?: AbortSignal } | undefined)?.signal;
        if (!signal) throw new Error("The leaf gateway gave the call no signal.");
        signals.push(signal);
        reached.resolve();
        // Settles only once the caller has gone, so nothing outlives the test.
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ late: true }), { once: true }),
        );
      },
      hasCommand: (command: string) => command === "get_machine_load",
      commandAccess: () => "workspace" as const,
    },
  };
}

test("a client leaving the command node's gateway cancels the routed read on the leaf's gateway", async () => {
  // The leaf's real gateway.
  const leaf = leafBackend();
  const leafGateway = await startGateway({ backend: leaf.backend });
  const leafInvokeUrl = new URL("/__orkestrator/invoke", leafGateway.info.url).toString();

  // The command node and the leaf, linked by a real NodeService and NodeLink.
  const network = new TestNodeNetwork();
  const commandNode = await network.add("command", { forceRegistration: true });
  const leafNode = await network.add("leaf");
  leafNode.commands.set("get_machine_load", async (args, signal) => {
    const response = await fetch(leafInvokeUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${leafGateway.info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "get_machine_load", args }),
      ...(signal ? { signal } : {}),
    });
    return ((await response.json()) as { result: unknown }).result;
  });
  const route: NodeRoute = {
    id: "primary" as RouteId,
    kind: "https",
    enabled: true,
    origin: leafNode.origin,
  };
  await commandNode.service.addNode({ routes: [route], token: leafNode.token });
  await settle(40);

  // The command node's real backend, its registry serving `invoke_on_node`
  // through the network's command-node portal, behind its own real gateway.
  const dataDir = await mkdtemp(path.join(tmpdir(), "ork-node-cancel-chain-"));
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: {
      start: async () => undefined,
      stop: async () => undefined,
      connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "fixture" }),
      revokeEnvironment: () => undefined,
    },
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  });
  (backend as unknown as { context: CommandContext }).context.nodePortal = commandNode.portal;
  const invoke = spyOn(backend, "invoke");
  try {
    const hubGateway = await startGateway({ backend });
    const hubInvokeUrl = new URL("/__orkestrator/invoke", hubGateway.info.url).toString();

    const client = new AbortController();
    const request = fetch(hubInvokeUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${hubGateway.info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "invoke_on_node",
        args: { nodeId: "bk_leaf", command: "get_machine_load", args: {} },
      }),
      signal: client.signal,
    }).catch(() => "aborted");

    // The read has crossed both gateways and is running on the leaf.
    await leaf.reached;
    const hubSignal = (invoke.mock.calls[0]?.[2] as { signal?: AbortSignal } | undefined)?.signal;
    expect(invoke.mock.calls[0]?.[0]).toBe("invoke_on_node");
    expect(hubSignal?.aborted).toBe(false);
    expect(leaf.signals).toHaveLength(1);
    expect(leaf.signals[0]!.aborted).toBe(false);

    // The client leaves.
    client.abort();
    expect(await request).toBe("aborted");

    // The command node's call is aborted, its routed read rejects with its
    // outcome unknown, and the leaf's call is aborted in turn.
    await waitUntil(() => hubSignal?.aborted === true, "the hub call's signal never aborted");
    await expect(invoke.mock.results[0]!.value as Promise<unknown>).rejects.toBeInstanceOf(
      NodeOutcomeUnknownError,
    );
    await waitUntil(
      () => leaf.signals[0]!.aborted,
      "the leaf gateway never saw its client go away",
    );
    // A read is never recorded as an unknown write.
    expect(commandNode.portal.outcomes.list()).toEqual([]);
  } finally {
    invoke.mockRestore();
    await backend.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
