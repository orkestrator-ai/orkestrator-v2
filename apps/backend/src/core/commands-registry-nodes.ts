import {
  parseGatewayCredential,
  parseNodeRoutes,
  normalizeNodeDisplayName,
  normalizeRouteOrder,
  type NodeRecord,
} from "@orkestrator/protocol/command-nodes";
import { SYNC_CONTROLLER_SETTINGS_COMMAND } from "@orkestrator/protocol/controller-settings";
import { isBackendId } from "@orkestrator/protocol/federation";
import {
  PORTAL_LAYOUT_CHANGED_EVENT,
  parsePortalLayoutUpdate,
} from "@orkestrator/protocol/portal-layout";

import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { assertOnlyKeys } from "./commands-validation.js";
import type { DesktopConnectionImport, NodeService } from "./nodes/node-service.js";
import type { NodePortal } from "./nodes/node-portal.js";
import type { NodeCoordination } from "./nodes/node-coordination.js";
import { parseNodeFileScope } from "./nodes/node-files.js";

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected ${label} to be a non-negative integer.`);
  }
  return value;
}

/**
 * Command-node and leaf commands. See docs/development/command-nodes-plan.md.
 *
 * Leaf side: `attach_controller`, `detach_controller`, `list_controllers`,
 * `sync_controller_settings`.
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

  // The portal sidebar's cross-machine order, shared by every client of this node.
  register("get_portal_layout", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return context.storage.getPortalLayout();
  });

  register("update_portal_layout", async (args, context) => {
    const layout = await context.storage.updatePortalLayout(parsePortalLayoutUpdate(args));
    context.emit(PORTAL_LAYOUT_CHANGED_EVENT, layout);
    return layout;
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

  // An attached command node handing down its settings (see `controller-settings.ts`).
  register(SYNC_CONTROLLER_SETTINGS_COMMAND, async (args, context) => {
    assertOnlyKeys(args, ["controllerId", "settings"], "arguments");
    return nodes(context).inheritedSettings.receive(args);
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
    assertOnlyKeys(args, ["nodeIds", "includeSelf"], "arguments");
    return portal(context).summaries(args.nodeIds, args.includeSelf);
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
    assertOnlyKeys(args, ["controllerId", "upTo", "sequences"], "arguments");
    if (!isBackendId(args.controllerId)) throw new Error("Expected controllerId.");
    if (typeof args.upTo !== "number" || !Number.isSafeInteger(args.upTo)) {
      throw new Error("Expected upTo.");
    }
    const sequences = args.sequences;
    if (
      sequences !== undefined &&
      (!Array.isArray(sequences) ||
        sequences.length > 50 ||
        !sequences.every((seq) => Number.isSafeInteger(seq) && seq > 0))
    )
      throw new Error("Invalid mail sequences.");
    return coordination(context).leafMail.ack(
      args.controllerId,
      args.upTo,
      sequences as number[] | undefined,
    );
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

  // Node files (any node; a command node calls them on itself and its nodes).
  register("stat_node_file", async (args, context) => {
    assertOnlyKeys(args, ["scope", "path"], "arguments");
    return coordination(context).files.stat(parseNodeFileScope(args.scope), String(args.path));
  });

  register("read_node_file", async (args, context) => {
    assertOnlyKeys(args, ["scope", "path", "offset", "length"], "arguments");
    return coordination(context).files.read(
      parseNodeFileScope(args.scope),
      String(args.path),
      safeInteger(args.offset, "offset"),
      safeInteger(args.length, "length"),
    );
  });

  register("begin_node_file_write", async (args, context) => {
    assertOnlyKeys(args, ["scope", "path", "size", "sha256", "overwrite"], "arguments");
    return coordination(context).files.beginWrite({
      scope: parseNodeFileScope(args.scope),
      path: String(args.path),
      size: safeInteger(args.size, "size"),
      sha256: String(args.sha256),
      overwrite: args.overwrite === true,
    });
  });

  register("append_node_file_write", async (args, context) => {
    assertOnlyKeys(args, ["uploadId", "contentBase64"], "arguments");
    return coordination(context).files.appendWrite(
      String(args.uploadId),
      String(args.contentBase64),
    );
  });

  register("commit_node_file_write", async (args, context) => {
    assertOnlyKeys(args, ["uploadId"], "arguments");
    return coordination(context).files.commitWrite(String(args.uploadId));
  });

  register("abort_node_file_write", async (args, context) => {
    assertOnlyKeys(args, ["uploadId"], "arguments");
    return coordination(context).files.abortWrite(String(args.uploadId));
  });

  register("read_environment_details", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "include", "path"], "arguments");
    const include = Array.isArray(args.include)
      ? args.include.filter(
          (entry): entry is "diff" | "file" | "tests" =>
            entry === "diff" || entry === "file" || entry === "tests",
        )
      : [];
    return coordination(context).files.environmentDetails({
      environmentId: String(args.environmentId),
      include,
      ...(typeof args.path === "string" ? { path: args.path } : {}),
    });
  });

  register("get_project_seed_files", async (args, context) => {
    assertOnlyKeys(args, ["projectId"], "arguments");
    return coordination(context).files.seedFiles(String(args.projectId));
  });

  register("fingerprint_project_files", async (args, context) => {
    assertOnlyKeys(args, ["projectId", "files", "key"], "arguments");
    const key = Buffer.from(String(args.key), "base64");
    if (key.length < 16) throw new Error("Expected a fingerprint key.");
    if (!Array.isArray(args.files) || args.files.length > 200) throw new Error("Expected files.");
    return coordination(context).files.fingerprints(
      String(args.projectId),
      args.files.filter((entry): entry is string => typeof entry === "string"),
      key,
    );
  });

  register("apply_env_keys", async (args, context) => {
    assertOnlyKeys(args, ["projectId", "path", "set", "remove"], "arguments");
    const set = (args.set && typeof args.set === "object" ? args.set : {}) as Record<
      string,
      unknown
    >;
    return coordination(context).files.applyEnvKeys(
      String(args.projectId),
      String(args.path),
      Object.fromEntries(Object.entries(set).map(([key, value]) => [key, String(value)])),
      Array.isArray(args.remove) ? args.remove.map(String) : [],
    );
  });

  register("read_env_values", async (args, context) => {
    assertOnlyKeys(args, ["projectId", "path", "keys"], "arguments");
    if (!Array.isArray(args.keys) || args.keys.length > 20) throw new Error("Expected keys.");
    return coordination(context).files.envValues(
      String(args.projectId),
      String(args.path),
      args.keys.map(String),
    );
  });

  // Command node: transfers and comparisons across its nodes.
  register("transfer_node_files", async (args, context) => {
    assertOnlyKeys(args, ["from", "to", "files", "toDirectory", "overwrite", "actor"], "arguments");
    const endpoint = (value: unknown, label: string) => {
      const record = value as Record<string, unknown> | null;
      if (!record || typeof record.nodeId !== "string")
        throw new Error(`Expected ${label}.nodeId.`);
      return { nodeId: record.nodeId, scope: parseNodeFileScope(record.scope) };
    };
    if (!Array.isArray(args.files)) throw new Error("Expected files.");
    return coordination(context).projectFiles.transfer.transfer({
      from: endpoint(args.from, "from"),
      to: endpoint(args.to, "to"),
      files: args.files.map(String),
      ...(typeof args.toDirectory === "string" ? { toDirectory: args.toDirectory } : {}),
      overwrite: args.overwrite === true,
      actor: typeof args.actor === "string" ? args.actor : "user",
    });
  });

  register("list_node_transfers", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return coordination(context).projectFiles.transfer.list();
  });

  register("compare_project_files", async (args, context) => {
    assertOnlyKeys(args, ["projectId", "nodeIds"], "arguments");
    return coordination(context).projectFiles.compare(
      String(args.projectId),
      Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : undefined,
    );
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
