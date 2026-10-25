import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";
import {
  PUBLIC_ACTIONS,
  PUBLIC_API_SCHEMA_VERSION,
  type PublicActionName,
  type PublicActionResponse,
} from "@orkestrator/protocol/public-api";
import { registerNodeCommands } from "../commands-registry-nodes.js";
import { settle, TestNodeNetwork, type TestNode } from "../nodes/node-network-test-support.js";
import { withPublicAuthority } from "./dispatch.js";
import type { PublicAuthority } from "./operation-ledger.js";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * A command node and one leaf, each with real storage and the real
 * `public_action`, joined by the in-memory node network. The leaf is the
 * test-provider harness, so it has a ready environment (`env-1`) and a
 * project of its own.
 */

const harnesses: PublicApiHarness[] = [];

export async function cleanupNodeTopologies(): Promise<void> {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
  await cleanupSessionHarnesses();
}

function httpsRoute(node: TestNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.origin };
}

function attach(harness: PublicApiHarness, node: TestNode): void {
  Object.assign(harness.context, { nodes: node.service, nodePortal: node.portal });
}

export async function topology(options: { leafRelay?: boolean } = {}) {
  const network = new TestNodeNetwork();
  const commandNode = await network.add("command", { forceRegistration: true });
  const leafNode = await network.add("leaf");
  leafNode.publicActionRelay = options.leafRelay ?? true;
  const leaf = await setup();
  attach(leaf.harness, leafNode);
  // The leaf answers its command node with its own registry; the node
  // commands stay the network's (bound to the leaf's node service).
  const nodeCommands = new Set<string>();
  registerNodeCommands((name) => nodeCommands.add(name));
  for (const [name, handler] of leaf.harness.commands) {
    if (nodeCommands.has(name)) continue;
    leafNode.commands.set(name, (args) => handler(args, leaf.harness.context));
  }
  const command = await createPublicApiHarness();
  harnesses.push(command);
  attach(command, commandNode);
  await commandNode.service.addNode({ routes: [httpsRoute(leafNode)], token: leafNode.token });
  await settle(40);
  const leafId = leafNode.storage.instanceId;
  const commandId = commandNode.storage.instanceId;
  return { network, commandNode, leafNode, command, leaf, leafId, commandId };
}

export async function call<T = unknown>(
  harness: PublicApiHarness,
  action: PublicActionName,
  input: Record<string, unknown>,
  options: { node?: string; requestId?: string; authority?: PublicAuthority } = {},
): Promise<PublicActionResponse<T>> {
  const request = {
    schemaVersion: PUBLIC_API_SCHEMA_VERSION,
    action,
    actionVersion: PUBLIC_ACTIONS[action].version,
    input,
    ...(options.requestId ? { request: { requestId: options.requestId } } : {}),
    ...(options.node ? { node: options.node } : {}),
  };
  return (await harness.commands.get("public_action")!(
    options.authority ? withPublicAuthority(request, options.authority) : request,
    harness.context,
  )) as PublicActionResponse<T>;
}
