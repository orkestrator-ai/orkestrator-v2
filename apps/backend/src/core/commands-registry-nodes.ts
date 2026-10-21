import {
  parseGatewayCredential,
  parseNodeRoutes,
  normalizeNodeDisplayName,
  normalizeRouteOrder,
  type NodeRecord,
} from "@orkestrator/protocol/command-nodes";
import { isBackendId } from "@orkestrator/protocol/federation";

import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { assertOnlyKeys } from "./commands-validation.js";
import type { DesktopConnectionImport, NodeService } from "./nodes/node-service.js";
import type { NodePortal } from "./nodes/node-portal.js";
import type { NodeCoordination } from "./nodes/node-coordination.js";

/**
 * Command-node and leaf commands. See docs/development/command-nodes-plan.md.
 *
 * Leaf side: `attach_controller`, `detach_controller`, `list_controllers`.
 * Command side: the registry (`list_nodes`, `add_node`, `update_node`,
 * `forget_node`, `reconnect_node`, …), SSH prompts and host-key trust, and
 * the one-time import of the desktop's saved machines.
 * Both: `get_node_status`, `set_command_node_enabled`.
 *
 * No command returns a node's gateway credential.
 */

const MAX_IMPORT_ENTRIES = 64;

function portal(context: CommandContext): NodePortal {
  if (!context.nodePortal)
    throw new Error("The command-node portal is not available in this backend.");
  return context.nodePortal;
}

function coordination(context: CommandContext): NodeCoordination {
  if (!context.nodeCoordination) {
    throw new Error("Cross-node coordination is not available in this backend.");
  }
  return context.nodeCoordination;
}

function nodes(context: CommandContext): NodeService {
  if (!context.nodes) throw new Error("Command nodes are not available in this backend.");
  return context.nodes;
}

export function registerNodeCommands(register: CommandRegistrar): void {
  register("get_node_status", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return nodes(context).status();
  });

  register("set_command_node_enabled", async (args, context) => {
    assertOnlyKeys(args, ["enabled"], "arguments");
    if (typeof args.enabled !== "boolean") throw new Error("Expected enabled to be a boolean.");
    return nodes(context).setRegistrationEnabled(args.enabled);
  });

  // Leaf side.
  register("attach_controller", async (args, context) => {
    assertOnlyKeys(args, ["controllerId", "displayName", "portalOrigins"], "arguments");
    return nodes(context).attachController(args);
  });

  // Called by a command node that forgets this node.
  register("detach_controller", async (args, context) => {
    assertOnlyKeys(args, ["controllerId"], "arguments");
    return nodes(context).detachController(args.controllerId);
  });

  // The user detaching a command node on this node: it may not re-attach until allowed.
  register("detach_controller_here", async (args, context) => {
    assertOnlyKeys(args, ["controllerId"], "arguments");
    return nodes(context).detachController(args.controllerId, { byUser: true });
  });

  register("allow_controller", async (args, context) => {
    assertOnlyKeys(args, ["controllerId"], "arguments");
    return nodes(context).allowController(args.controllerId);
  });

  register("list_controllers", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return nodes(context).listControllers();
  });

  // Command side.
  register("list_nodes", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return nodes(context).listNodes();
  });

  register("add_node", async (args, context) => {
    assertOnlyKeys(args, ["routes", "routeOrder", "token", "displayName"], "arguments");
    return nodes(context).addNode(args);
  });

  register("update_node", async (args, context) => {
    assertOnlyKeys(args, ["nodeId", "routes", "routeOrder", "token", "enabled"], "arguments");
    return nodes(context).updateNode(args);
  });

  register("forget_node", async (args, context) => {
    assertOnlyKeys(args, ["nodeId", "withoutDetach"], "arguments");
    return nodes(context).forgetNode(args);
  });

  register("discard_node_detach", async (args, context) => {
    assertOnlyKeys(args, ["nodeId"], "arguments");
    return nodes(context).discardPendingDetach(args.nodeId);
  });

  register("reconnect_node", async (args, context) => {
    assertOnlyKeys(args, ["nodeId"], "arguments");
    return nodes(context).reconnectNode(args.nodeId);
  });

  register("list_node_ssh_prompts", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return nodes(context).prompts.list();
  });

  register("answer_node_ssh_prompt", async (args, context) => {
    assertOnlyKeys(args, ["promptId", "answer", "cancel"], "arguments");
    return nodes(context).answerSshPrompt(args);
  });

  register("probe_node_host_key", async (args, context) => {
    assertOnlyKeys(args, ["destination", "sshPort"], "arguments");
    return nodes(context).probeHostKey(args);
  });

  register("trust_node_host_key", async (args, context) => {
    assertOnlyKeys(args, ["probeId"], "arguments");
    return nodes(context).trustHostKey(args.probeId);
  });

  // Portal (command node).
  register("get_node_summaries", async (args, context) => {
    assertOnlyKeys(args, ["nodeIds"], "arguments");
    return portal(context).summaries(args.nodeIds);
  });

  register("invoke_on_node", async (args, context) => {
    assertOnlyKeys(args, ["nodeId", "command", "args", "requestKey"], "arguments");
    return portal(context).invokeOnNode(args);
  });

  register("list_node_outcomes", async (args, context) => {
    assertOnlyKeys(args, ["nodeId"], "arguments");
    return portal(context).outcomes.list(typeof args.nodeId === "string" ? args.nodeId : undefined);
  });

  register("dismiss_node_outcome", async (args, context) => {
    assertOnlyKeys(args, ["outcomeId"], "arguments");
    if (typeof args.outcomeId !== "string") throw new Error("Expected outcomeId.");
    return { dismissed: await portal(context).outcomes.dismiss(args.outcomeId) };
  });

  register("open_node_workspace", async (args, context) => {
    assertOnlyKeys(args, ["nodeId"], "arguments");
    return portal(context).openWorkspace(args.nodeId);
  });

  register("renew_node_workspace", async (args, context) => {
    assertOnlyKeys(args, ["workspaceId"], "arguments");
    return portal(context).renewWorkspace(args.workspaceId);
  });

  register("close_node_workspace", async (args, context) => {
    assertOnlyKeys(args, ["workspaceId"], "arguments");
    return portal(context).closeWorkspace(args.workspaceId);
  });

  // Client grants (leaf), requested by an attached command node.
  register("create_client_grant", async (args, context) => {
    assertOnlyKeys(args, ["controllerId", "ttlSeconds", "label"], "arguments");
    return portal(context).createClientGrant(args);
  });

  register("renew_client_grant", async (args, context) => {
    assertOnlyKeys(args, ["controllerId", "grantId", "ttlSeconds"], "arguments");
    return portal(context).renewClientGrant(args);
  });

  register("revoke_client_grant", async (args, context) => {
    assertOnlyKeys(args, ["controllerId", "grantId"], "arguments");
    return portal(context).revokeClientGrant(args);
  });

  // Leaf mail (leaf side, called by an attached command node).
  register("deliver_node_mail", async (args, context) => {
    assertOnlyKeys(
      args,
      [
        "controllerId",
        "coordinatorEnvironmentId",
        "coordinatorTabId",
        "requestId",
        "toEnvironmentId",
        "toTabId",
        "subject",
        "body",
      ],
      "arguments",
    );
    return coordination(context).deliverIncoming(args);
  });

  register("record_node_environment_origin", async (args, context) => {
    assertOnlyKeys(
      args,
      ["environmentId", "controllerId", "coordinatorEnvironmentId", "coordinatorTabId"],
      "arguments",
    );
    return coordination(context).recordOrigin(args);
  });

  register("collect_node_outbox", async (args, context) => {
    assertOnlyKeys(args, ["controllerId", "after"], "arguments");
    if (!isBackendId(args.controllerId)) throw new Error("Expected controllerId.");
    const after =
      typeof args.after === "number" && Number.isSafeInteger(args.after) ? args.after : 0;
    return coordination(context).leafMail.collect(args.controllerId, after);
  });

  register("ack_node_outbox", async (args, context) => {
    assertOnlyKeys(args, ["controllerId", "upTo"], "arguments");
    if (!isBackendId(args.controllerId)) throw new Error("Expected controllerId.");
    if (typeof args.upTo !== "number" || !Number.isSafeInteger(args.upTo)) {
      throw new Error("Expected upTo.");
    }
    return coordination(context).leafMail.ack(args.controllerId, args.upTo);
  });

  // Action requests (command node): coordinators ask, the user decides.
  register("create_node_action_request", async (args, context) => {
    assertOnlyKeys(args, ["kind", "targets", "requestedBy", "reason"], "arguments");
    return coordination(context).createActionRequest(args);
  });

  register("list_node_action_requests", async (args, context) => {
    assertOnlyKeys(args, ["pendingOnly"], "arguments");
    return coordination(context).actions.list({ pendingOnly: args.pendingOnly === true });
  });

  register("resolve_node_action_request", async (args, context) => {
    assertOnlyKeys(args, ["requestId", "decision"], "arguments");
    if (typeof args.requestId !== "string") throw new Error("Expected requestId.");
    if (args.decision !== "approve" && args.decision !== "reject") {
      throw new Error("Expected decision approve or reject.");
    }
    return coordination(context).actions.resolve(args.requestId, args.decision);
  });

  register("import_desktop_connections", async (args, context) => {
    assertOnlyKeys(args, ["entries"], "arguments");
    return nodes(context).importDesktopConnections(parseImportEntries(args.entries));
  });
}

function parseImportEntries(value: unknown): DesktopConnectionImport[] {
  if (!Array.isArray(value) || value.length > MAX_IMPORT_ENTRIES) {
    throw new Error("Expected entries to be a bounded array.");
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Expected entries[${index}] to be an object.`);
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.importedFrom !== "string" ||
      !entry.importedFrom ||
      entry.importedFrom.length > 200
    ) {
      throw new Error(`Expected entries[${index}].importedFrom.`);
    }
    const routes = parseNodeRoutes(entry.routes);
    const parsed: DesktopConnectionImport = {
      importedFrom: entry.importedFrom,
      fallbackName: normalizeNodeDisplayName(entry.fallbackName, "fallbackName"),
      routes,
      routeOrder: normalizeRouteOrder(routes, entry.routeOrder),
      token:
        entry.token === null || entry.token === undefined
          ? null
          : parseGatewayCredential(entry.token),
      enabled: entry.enabled !== false,
    };
    if (entry.verifiedNodeId !== undefined) {
      if (!isBackendId(entry.verifiedNodeId) || entry.verifiedNodeId.startsWith("provisional:")) {
        throw new Error(`Expected entries[${index}].verifiedNodeId to be a node identity.`);
      }
      parsed.verifiedNodeId = entry.verifiedNodeId;
    }
    const cache = entry.profileCache as NodeRecord["profileCache"] | undefined;
    if (
      cache &&
      typeof cache.displayName === "string" &&
      typeof cache.colorToken === "string" &&
      Number.isSafeInteger(cache.revision)
    ) {
      parsed.profileCache = {
        displayName: cache.displayName.slice(0, 64),
        colorToken: cache.colorToken.slice(0, 32),
        revision: cache.revision,
      };
    }
    return parsed;
  });
}
