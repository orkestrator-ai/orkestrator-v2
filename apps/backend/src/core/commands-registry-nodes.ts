import { portalLayoutChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import {
  acceptCommandHandoverCommand,
  addNodeCommand,
  allowControllerCommand,
  answerNodeSshPromptCommand,
  applyEnvKeysCommand,
  approveSetupCommandsOnNodesCommand,
  attachControllerCommand,
  closeNodeWorkspaceCommand,
  compareProjectFilesCommand,
  copyProjectToNodeCommand,
  createClientGrantCommand,
  detachControllerCommand,
  detachControllerHereCommand,
  discardNodeDetachCommand,
  dismissNodeOutcomeCommand,
  fingerprintProjectFilesCommand,
  forgetNodeCommand,
  getNodeStatusCommand,
  getNodeSummariesCommand,
  getPortalLayoutCommand,
  getProjectCopyOptionsCommand,
  getProjectSeedFilesCommand,
  handOverCommandCommand,
  importDesktopConnectionsCommand,
  invokeOnNodeCommand,
  listControllersCommand,
  listNodeOutcomesCommand,
  listNodeSshPromptsCommand,
  listNodesCommand,
  listProjectCopiesCommand,
  openNodeWorkspaceCommand,
  previewAgentsMdUpdateCommand,
  previewCommandHandoverCommand,
  probeNodeHostKeyCommand,
  readEnvValuesCommand,
  readEnvironmentDetailsCommand,
  reconnectNodeCommand,
  renewClientGrantCommand,
  renewNodeWorkspaceCommand,
  revokeClientGrantCommand,
  runGrantedAgentAccountSwitchCommand,
  runTimerAgentAccountSwitchCommand,
  setCommandNodeEnabledCommand,
  syncControllerSettingsCommand,
  trustNodeHostKeyCommand,
  unwatchNodeEventsCommand,
  updateNodeCommand,
  updatePortalLayoutCommand,
  watchNodeEventsCommand,
} from "@orkestrator/protocol/contract/domains/nodes";
import { workerSessionActivity } from "./worker-session-activity.js";
import { parseNodeImportEntries } from "@orkestrator/protocol/command-nodes";
import { isBackendId } from "@orkestrator/protocol/federation";
import { parsePortalLayoutUpdate } from "@orkestrator/protocol/portal-layout";
import {
  abortNodeFileWriteCommand,
  appendNodeFileWriteCommand,
  beginNodeFileWriteCommand,
  commitNodeFileWriteCommand,
  listNodeTransfersCommand,
  readNodeFileCommand,
  statNodeFileCommand,
  transferNodeFilesCommand,
} from "@orkestrator/protocol/contract/domains/node-files";
import {
  ackNodeOutboxCommand,
  collectNodeOutboxCommand,
  createNodeActionRequestCommand,
  deliverNodeMailCommand,
  getNodeProjectCoordinatorCommand,
  getWorkerRequestStateCommand,
  listNodeActionRequestsCommand,
  recordNodeEnvironmentOriginCommand,
  resolveNodeActionRequestCommand,
  returnNodeOutboxMailCommand,
} from "@orkestrator/protocol/contract/domains/node-mail";

import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  coordinatorDeliverNowResult,
  settleCoordinatorDeliverNow,
} from "./coordinator-deliver-now.js";
import {
  approveSetupCommandsOnNodes,
  parseNodeActionApproval,
  parseNodeFileScope,
  runGrantedAccountSwitch,
  runTimerAccountSwitch,
  type NodeCoordination,
  type NodePortal,
  type NodeService,
} from "./nodes/index.js";

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
 * the one-time import of the desktop's saved machines, and handing command
 * over to another node (`preview_command_handover`, `hand_over_command`, and
 * `accept_command_handover` on the receiving side).
 * Both: `get_node_status`, `set_command_node_enabled`.
 *
 * No command returns a node's gateway credential.
 */

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
  register(getNodeStatusCommand, async (_args, context) => {
    return nodes(context).status();
  });

  // The portal sidebar's cross-machine order, shared by every client of this node.
  register(getPortalLayoutCommand, async (_args, context) => {
    return context.storage.nodes.getPortalLayout();
  });

  register(updatePortalLayoutCommand, async (args, context) => {
    const layout = await context.storage.nodes.updatePortalLayout(parsePortalLayoutUpdate(args));
    context.emit(portalLayoutChangedEvent, layout);
    return layout;
  });

  register(setCommandNodeEnabledCommand, async (args, context) => {
    if (typeof args.enabled !== "boolean") throw new Error("Expected enabled to be a boolean.");
    return nodes(context).setRegistrationEnabled(args.enabled);
  });

  // Leaf side.
  register(attachControllerCommand, async (args, context) => {
    return nodes(context).attachController(args);
  });

  // Called by a command node that forgets this node.
  register(detachControllerCommand, async (args, context) => {
    return nodes(context).detachController(args.controllerId);
  });

  // The user detaching a command node on this node: it may not re-attach until allowed.
  register(detachControllerHereCommand, async (args, context) => {
    return nodes(context).detachController(args.controllerId, { byUser: true });
  });

  // An attached command node handing down its settings (see `controller-settings.ts`).
  register(syncControllerSettingsCommand, async (args, context) => {
    return nodes(context).inheritedSettings.receive(args);
  });

  register(allowControllerCommand, async (args, context) => {
    return nodes(context).allowController(args.controllerId);
  });

  register(listControllersCommand, async (_args, context) => {
    return nodes(context).listControllers();
  });

  // Command side.
  register(listNodesCommand, async (_args, context) => {
    return nodes(context).listNodes();
  });

  register(addNodeCommand, async (args, context) => {
    return nodes(context).addNode(args);
  });

  register(updateNodeCommand, async (args, context) => {
    return nodes(context).updateNode(args);
  });

  register(forgetNodeCommand, async (args, context) => {
    return nodes(context).forgetNode(args);
  });

  register(discardNodeDetachCommand, async (args, context) => {
    return nodes(context).discardPendingDetach(args.nodeId);
  });

  register(reconnectNodeCommand, async (args, context) => {
    return nodes(context).reconnectNode(args.nodeId);
  });

  register(listNodeSshPromptsCommand, async (_args, context) => {
    return nodes(context).prompts.list();
  });

  register(answerNodeSshPromptCommand, async (args, context) => {
    return nodes(context).answerSshPrompt(args);
  });

  register(probeNodeHostKeyCommand, async (args, context) => {
    return nodes(context).probeHostKey(args);
  });

  register(trustNodeHostKeyCommand, async (args, context) => {
    return nodes(context).trustHostKey(args.probeId);
  });

  // Portal (command node).
  register(getNodeSummariesCommand, async (args, context) => {
    return portal(context).summaries(args.nodeIds, args.includeSelf);
  });

  register(invokeOnNodeCommand, async (args, context) => {
    return portal(context).invokeOnNode(args);
  });

  register(watchNodeEventsCommand, async (args, context) => {
    return portal(context).events.watch(args);
  });

  register(unwatchNodeEventsCommand, async (args, context) => {
    return portal(context).events.unwatch(args.watchId);
  });

  register(listNodeOutcomesCommand, async (args, context) => {
    return portal(context).outcomes.list(typeof args.nodeId === "string" ? args.nodeId : undefined);
  });

  register(dismissNodeOutcomeCommand, async (args, context) => {
    if (typeof args.outcomeId !== "string") throw new Error("Expected outcomeId.");
    return { dismissed: await portal(context).outcomes.dismiss(args.outcomeId) };
  });

  register(openNodeWorkspaceCommand, async (args, context) => {
    return portal(context).openWorkspace(args.nodeId);
  });

  register(renewNodeWorkspaceCommand, async (args, context) => {
    return portal(context).renewWorkspace(args.workspaceId);
  });

  register(closeNodeWorkspaceCommand, async (args, context) => {
    return portal(context).closeWorkspace(args.workspaceId);
  });

  // Client grants (leaf), requested by an attached command node.
  register(createClientGrantCommand, async (args, context) => {
    return portal(context).createClientGrant(args);
  });

  register(renewClientGrantCommand, async (args, context) => {
    return portal(context).renewClientGrant(args);
  });

  register(revokeClientGrantCommand, async (args, context) => {
    return portal(context).revokeClientGrant(args);
  });

  // Leaf mail (leaf side, called by an attached command node). The node-mail
  // and node-files commands are defined (`@orkestrator/protocol/contract/domains`,
  // plan item 1010): their arguments decode tolerantly, so an unknown key is
  // dropped rather than refused, and a sender marks `steer` critical.
  register(deliverNodeMailCommand, async (args, context) => {
    const delivered = await coordination(context).deliverIncoming(args);
    if (args.steer !== true) return delivered;
    // Bounces live in the idempotency receipt, outside the recipient mailbox.
    if (delivered.placement !== "pending-inject") {
      return { ...delivered, ...coordinatorDeliverNowResult(delivered) };
    }
    // The coordinator's deliverNow, settled here as on its own node: one
    // delivery pass, then the outcome the command node reports unchanged.
    const settled = await settleCoordinatorDeliverNow(
      context,
      await context.storage.getAgentMailMessage(
        String(args.toEnvironmentId),
        delivered.toTabId,
        delivered.messageId,
      ),
    );
    const { placementReason: _previousReason, ...rest } = delivered;
    return {
      ...rest,
      placement: settled.placement,
      ...(settled.placementReason ? { placementReason: settled.placementReason } : {}),
      ...(settled.injectedVia ? { injectedVia: settled.injectedVia } : {}),
      deliverNow: settled.deliverNow,
      deliverNowNote: settled.deliverNowNote,
    };
  });

  // Whether a project here has a coordinator a command node's coordinator can
  // mail (`deliver_node_mail` to "coordinator").
  register(getNodeProjectCoordinatorCommand, async (args, context) => {
    if (typeof args.projectId !== "string") throw new Error("Expected projectId.");
    return coordination(context).projectCoordinator(args.projectId);
  });

  // Whether coordinator mail to a worker tab has reached a turn yet; a
  // command node asks before treating that tab's turn end as its answer.
  register(getWorkerRequestStateCommand, async (args, context) => {
    if (typeof args.environmentId !== "string" || typeof args.tabId !== "string") {
      throw new Error("Expected environmentId and tabId.");
    }
    const activity = await workerSessionActivity(
      context.storage,
      context.nativeAgents,
      args.environmentId,
      args.tabId,
    );
    return {
      backgroundWorkPending: activity.backgroundWorkPending,
      requestPending:
        activity.requestPending === true ||
        (await context.storage.hasUndeliveredCoordinatorRequest(args.environmentId, args.tabId)),
    };
  });

  register(recordNodeEnvironmentOriginCommand, async (args, context) => {
    return coordination(context).recordOrigin(args);
  });

  register(collectNodeOutboxCommand, async (args, context) => {
    if (!isBackendId(args.controllerId)) throw new Error("Expected controllerId.");
    const after =
      typeof args.after === "number" && Number.isSafeInteger(args.after) ? args.after : 0;
    const notices = args.coordinatorNotices as { repositoryHints?: unknown } | undefined;
    return coordination(context).leafMail.collect(
      args.controllerId,
      after,
      args.coordinatorMail === true,
      args.attachmentMail === true,
      notices
        ? {
            repositoryHints: Array.isArray(notices.repositoryHints)
              ? notices.repositoryHints.filter(
                  (hint): hint is string => typeof hint === "string" && hint.length <= 2_048,
                )
              : [],
          }
        : undefined,
    );
  });

  register(ackNodeOutboxCommand, async (args, context) => {
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
    const notices = args.coordinatorNotices as { declined?: unknown } | undefined;
    const declined = Array.isArray(notices?.declined)
      ? notices.declined.filter((seq): seq is number => Number.isSafeInteger(seq)).slice(0, 50)
      : [];
    return coordination(context).leafMail.ack(
      args.controllerId,
      args.upTo,
      sequences as number[] | undefined,
      args.coordinatorMail === true,
      args.attachmentMail === true,
      notices ? { declined } : undefined,
    );
  });

  register(returnNodeOutboxMailCommand, async (args, context) => {
    if (!isBackendId(args.controllerId)) throw new Error("Expected controllerId.");
    if (typeof args.seq !== "number" || !Number.isSafeInteger(args.seq) || args.seq <= 0) {
      throw new Error("Expected seq.");
    }
    await coordination(context).returnOutboxMail(args.controllerId, args.seq);
    return { returned: true as const };
  });

  // Action requests (command node): coordinators ask, the user decides.
  register(createNodeActionRequestCommand, async (args, context) => {
    return coordination(context).createActionRequest(args);
  });

  // A coordinator's account switch under the user's standing permission
  // (`control-mcp-account-tools.ts`); this machine's permission, never another's.
  register(runGrantedAgentAccountSwitchCommand, async (args, context) => {
    return runGrantedAccountSwitch(
      {
        actions: coordination(context).actions,
        loadGlobalConfig: async () => (await context.storage.loadConfig()).global,
        projectName: async (projectId) =>
          (await context.storage.getProject(projectId).catch(() => null))?.name,
        emit: context.emit,
      },
      args,
    );
  });

  // A coordinator's account switch under the permission of the self-timer that
  // woke it, checked by `switch_provider_account`; recorded so the user sees it.
  register(runTimerAgentAccountSwitchCommand, async (args, context) => {
    return runTimerAccountSwitch(
      {
        actions: coordination(context).actions,
        loadGlobalConfig: async () => (await context.storage.loadConfig()).global,
        projectName: async (projectId) =>
          (await context.storage.getProject(projectId).catch(() => null))?.name,
        emit: context.emit,
      },
      args,
    );
  });

  register(listNodeActionRequestsCommand, async (args, context) => {
    return coordination(context).actions.list({ pendingOnly: args.pendingOnly === true });
  });

  register(resolveNodeActionRequestCommand, async (args, context) => {
    if (typeof args.requestId !== "string") throw new Error("Expected requestId.");
    if (args.decision !== "approve" && args.decision !== "reject") {
      throw new Error("Expected decision approve or reject.");
    }
    return coordination(context).actions.resolve(
      args.requestId,
      args.decision,
      parseNodeActionApproval(args.approval),
    );
  });

  // The section an AGENTS.md request's review diffs against (command node).
  register(previewAgentsMdUpdateCommand, async (args, context) => {
    if (typeof args.requestId !== "string") throw new Error("Expected requestId.");
    return coordination(context).previewAgentsMd(args.requestId);
  });

  // Node files (any node; a command node calls them on itself and its nodes).
  register(statNodeFileCommand, async (args, context) => {
    return coordination(context).files.stat(parseNodeFileScope(args.scope), String(args.path));
  });

  register(readNodeFileCommand, async (args, context) => {
    return coordination(context).files.read(
      parseNodeFileScope(args.scope),
      String(args.path),
      safeInteger(args.offset, "offset"),
      safeInteger(args.length, "length"),
    );
  });

  register(beginNodeFileWriteCommand, async (args, context) => {
    return coordination(context).files.beginWrite({
      scope: parseNodeFileScope(args.scope),
      path: String(args.path),
      size: safeInteger(args.size, "size"),
      sha256: String(args.sha256),
      overwrite: args.overwrite === true,
    });
  });

  register(appendNodeFileWriteCommand, async (args, context) => {
    return coordination(context).files.appendWrite(
      String(args.uploadId),
      String(args.contentBase64),
    );
  });

  register(commitNodeFileWriteCommand, async (args, context) => {
    return coordination(context).files.commitWrite(String(args.uploadId));
  });

  register(abortNodeFileWriteCommand, async (args, context) => {
    return coordination(context).files.abortWrite(String(args.uploadId));
  });

  register(readEnvironmentDetailsCommand, async (args, context) => {
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

  register(getProjectSeedFilesCommand, async (args, context) => {
    return coordination(context).files.seedFiles(String(args.projectId));
  });

  register(fingerprintProjectFilesCommand, async (args, context) => {
    const key = Buffer.from(String(args.key), "base64");
    if (key.length < 16) throw new Error("Expected a fingerprint key.");
    if (!Array.isArray(args.files) || args.files.length > 200) throw new Error("Expected files.");
    return coordination(context).files.fingerprints(
      String(args.projectId),
      args.files.filter((entry): entry is string => typeof entry === "string"),
      key,
    );
  });

  register(applyEnvKeysCommand, async (args, context) => {
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

  register(readEnvValuesCommand, async (args, context) => {
    if (!Array.isArray(args.keys) || args.keys.length > 20) throw new Error("Expected keys.");
    return coordination(context).files.envValues(
      String(args.projectId),
      String(args.path),
      args.keys.map(String),
    );
  });

  // Command node: transfers and comparisons across its nodes.
  register(transferNodeFilesCommand, async (args, context) => {
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

  register(listNodeTransfersCommand, async (_args, context) => {
    return coordination(context).projectFiles.transfer.list();
  });

  // Command node: record an approved setup command list on every machine that
  // has the project (`nodes/node-setup-approvals.ts`). The user's action only.
  register(approveSetupCommandsOnNodesCommand, async (args, context) => {
    if (
      typeof args.nodeId !== "string" ||
      typeof args.projectId !== "string" ||
      typeof args.hash !== "string"
    ) {
      throw new Error("Expected nodeId, projectId and hash.");
    }
    return approveSetupCommandsOnNodes(
      {
        summaries: () => portal(context).summaries(undefined, true),
        invokerFor: coordination(context).projectFiles.invokerFor,
      },
      { nodeId: args.nodeId, projectId: args.projectId, hash: args.hash },
    );
  });

  register(compareProjectFilesCommand, async (args, context) => {
    return coordination(context).projectFiles.compare(
      String(args.projectId),
      Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : undefined,
    );
  });

  // Command node: copying a project between any two machines it controls.
  register(getProjectCopyOptionsCommand, async (args, context) => {
    if (typeof args.nodeId !== "string" || typeof args.projectId !== "string") {
      throw new Error("Expected nodeId and projectId.");
    }
    return coordination(context).copies.copyOptions({
      nodeId: args.nodeId,
      projectId: args.projectId,
    });
  });

  register(copyProjectToNodeCommand, async (args, context) => {
    const source = args.source as Record<string, unknown> | null;
    const target = args.target as Record<string, unknown> | null;
    if (
      typeof args.requestKey !== "string" ||
      !source ||
      typeof source.nodeId !== "string" ||
      typeof source.projectId !== "string" ||
      !target ||
      typeof target.nodeId !== "string" ||
      (target.location !== undefined && typeof target.location !== "string")
    ) {
      throw new Error("Expected requestKey, source { nodeId, projectId } and target { nodeId }.");
    }
    if (
      !Array.isArray(args.paths) ||
      !args.paths.every((entry) => typeof entry === "string" && entry.length <= 1_024)
    ) {
      throw new Error("Expected paths.");
    }
    return coordination(context).copies.start({
      requestKey: args.requestKey,
      source: { nodeId: source.nodeId, projectId: source.projectId },
      target: {
        nodeId: target.nodeId,
        ...(typeof target.location === "string" ? { location: target.location } : {}),
      },
      paths: args.paths as string[],
      rememberFiles: args.rememberFiles === true,
    });
  });

  register(listProjectCopiesCommand, async (_args, context) => {
    return coordination(context).copies.list();
  });

  register(importDesktopConnectionsCommand, async (args, context) => {
    return nodes(context).importDesktopConnections(parseNodeImportEntries(args.entries));
  });

  // Making another node the command node, from the current one: it hands over its
  // machines (credentials included) over its link and follows as the new one's leaf.
  register(previewCommandHandoverCommand, async (args, context) => {
    return nodes(context).previewHandover(args.nodeId, args.targetNodeIds);
  });

  register(handOverCommandCommand, async (args, context) => {
    return nodes(context).handOverCommand({
      nodeId: args.nodeId,
      nodeIds: args.nodeIds,
      includeSelf: args.includeSelf !== false,
      entries: args.entries === undefined ? [] : parseNodeImportEntries(args.entries),
    });
  });

  // Leaf side: an attached command node making this node the command node.
  register(acceptCommandHandoverCommand, async (args, context) => {
    return nodes(context).acceptHandover(
      args.controllerId,
      parseNodeImportEntries(args.entries),
      args.handoverId,
    );
  });
}
