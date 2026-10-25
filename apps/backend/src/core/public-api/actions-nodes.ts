import { APP_VERSION } from "../constants.js";
import type { PublicNodeList, PublicNodeSummary } from "@orkestrator/protocol/public-api-resources";
import { onlyActionKeys } from "./input.js";
import { nodeRoutingRefusal } from "./node-targets.js";
import type { PublicActionHandler, ReadActionHandler } from "./types.js";

/**
 * `node.list`: this node and the nodes it controls, so a caller can name one
 * with `request.node` (CLI `--node`, Control MCP `nodeId`). It never returns
 * routes, addresses or credentials. A leaf lists only itself: its own
 * registry is suspended while a command node controls it.
 */
const nodeList: ReadActionHandler<Record<string, never>> = {
  kind: "read",
  action: "node.list",
  parse(input) {
    onlyActionKeys(input, "node.list");
    return {};
  },
  async run(_input, context) {
    const nodes = context.command.nodes;
    const profile = await nodes?.selfProfile().catch(() => null);
    const self: PublicNodeSummary = {
      nodeId: (await nodes?.selfIdentity().catch(() => null)) ?? context.installationId,
      name: profile?.displayName ?? "This node",
      self: true,
      enabled: true,
      available: true,
      state: "self",
      mode: nodes?.mode() ?? "standalone",
      version: APP_VERSION,
      publicActions: true,
    };
    const leaf = nodes?.isLeaf() === true;
    const items: PublicNodeSummary[] = [self];
    if (nodes && !leaf) {
      for (const view of (await nodes.listNodes()).nodes) {
        const link = nodes.link(view.nodeId);
        const available = view.enabled && link?.connected === true;
        const refusal = !view.enabled ? "disabled" : nodeRoutingRefusal(link);
        items.push({
          nodeId: view.nodeId,
          name: view.displayName || view.fallbackName || view.nodeId,
          self: false,
          enabled: view.enabled,
          available,
          state: view.enabled ? view.connection.state : "disabled",
          mode: view.connection.remoteMode ?? null,
          version: available ? (link?.hello?.appVersion ?? null) : null,
          publicActions: refusal === null,
          ...(refusal ? { reason: refusal } : {}),
          ...(view.lastConnectedAt ? { lastConnectedAt: view.lastConnectedAt } : {}),
        });
      }
    }
    const result: PublicNodeList = {
      items,
      total: items.length,
      mode: nodes?.mode() ?? "standalone",
      controlledBy: leaf
        ? nodes!
            .listControllers()
            .map((entry) => ({ nodeId: entry.controllerId, name: entry.displayName }))
        : [],
    };
    return { result };
  },
};

export const NODE_HANDLERS: PublicActionHandler[] = [nodeList];
