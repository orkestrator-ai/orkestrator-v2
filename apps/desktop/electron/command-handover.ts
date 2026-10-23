import type {
  CommandHandoverPreview,
  CommandHandoverPreviewResult,
  CommandHandoverRepair,
  CommandHandoverResult,
  NodeImportEntry,
  NodeListResult,
  NodeStatus,
} from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";

/**
 * Making another machine the command node from a desktop window.
 *
 * The command node in charge (the window's own, or the one controlling it
 * when the window is on a leaf) hands its machines to the target over its
 * link (`hand_over_command`). This device adds what only it knows: the
 * target itself when that command node does not control it yet, and the
 * saved machines the user chose, with their tokens. Tokens leave Electron
 * main only in requests to that command node.
 *
 * The target can refuse that command node: it may list it among its own
 * machines (a loop left by an earlier switch), or its user may have
 * detached it there. This device usually has its own connection to the
 * target, so it reads those records in the preview and clears them on the
 * target once the user confirms.
 */

export interface CommandHandoverDeps {
  /** The window's own connection. */
  currentConnectionId: string;
  invokeOn<T>(connectionId: string, command: string, args?: Record<string, unknown>): Promise<T>;
  installationIdOf(connectionId: string): BackendId | null;
  connectionIdOf(nodeId: BackendId): string | null;
  machineImportEntry(connectionId: string): Promise<NodeImportEntry | null>;
}

export interface CommandHandoverInput {
  targetConnectionId: string;
  /** The command node's machines to move; all when omitted. */
  nodeIds?: string[];
  /** Saved machines on this device to send along. */
  connectionIds: string[];
  /** Whether the current command node follows as the target's leaf. */
  includeSelf: boolean;
}

/** The connection of the command node in charge of the window's machine. */
async function commandSource(deps: CommandHandoverDeps): Promise<string> {
  const status = await deps.invokeOn<NodeStatus>(deps.currentConnectionId, "get_node_status");
  if (status.mode !== "leaf") return deps.currentConnectionId;
  const controllerId = status.mostRecentControllerId ?? status.controllers[0]?.controllerId;
  const source = controllerId ? deps.connectionIdOf(controllerId) : null;
  if (!source) {
    const name = status.controllers[0]?.displayName ?? "Its command node";
    throw new Error(
      `${name} controls this machine, and this device has no connection to it. Connect to ${name} first.`,
    );
  }
  return source;
}

function targetNodeId(deps: CommandHandoverDeps, targetConnectionId: string): BackendId {
  const nodeId = deps.installationIdOf(targetConnectionId);
  if (!nodeId) {
    throw new Error("Connect to that machine once first, so its identity is known.");
  }
  return nodeId;
}

interface TargetBlocks {
  repairs: CommandHandoverRepair[];
  /** What the target controls once the repairs are made. */
  targetNodeIds: BackendId[];
}

/**
 * What on the target refuses the source, read over this device's own
 * connection to it. Nothing is known (and nothing repaired) when this
 * device cannot reach the target itself.
 */
async function targetBlocks(
  deps: CommandHandoverDeps,
  targetConnectionId: string,
  sourceNodeId: BackendId | null,
): Promise<TargetBlocks> {
  if (!sourceNodeId) return { repairs: [], targetNodeIds: [] };
  const [status, nodes] = await Promise.all([
    deps.invokeOn<NodeStatus>(targetConnectionId, "get_node_status").catch(() => null),
    deps.invokeOn<NodeListResult>(targetConnectionId, "list_nodes").catch(() => null),
  ]);
  const repairs: CommandHandoverRepair[] = [];
  if (nodes?.nodes.some((node) => node.nodeId === sourceNodeId)) {
    repairs.push("forget-source-on-target");
  }
  if (status?.detachedControllers.some((entry) => entry.controllerId === sourceNodeId)) {
    repairs.push("allow-source-on-target");
  }
  return {
    repairs,
    targetNodeIds: (nodes?.nodes ?? [])
      .map((node) => node.nodeId)
      .filter((id) => id !== sourceNodeId),
  };
}

export async function previewCommandHandover(
  deps: CommandHandoverDeps,
  targetConnectionId: string,
): Promise<CommandHandoverPreviewResult> {
  const status = await deps.invokeOn<NodeStatus>(deps.currentConnectionId, "get_node_status");
  // An independent machine with no fleet needs only a native connection switch.
  if (status.mode === "standalone") return { kind: "already-command-node" };
  const nodeId = targetNodeId(deps, targetConnectionId);
  const source = await commandSource(deps);
  const sourceNodeId = deps.installationIdOf(source);
  if (sourceNodeId === nodeId) return { kind: "already-command-node" };
  const blocks = await targetBlocks(deps, targetConnectionId, sourceNodeId);
  const preview = await deps.invokeOn<CommandHandoverPreview>(source, "preview_command_handover", {
    nodeId,
    // The source's link to a target that refuses it cannot say what the target controls.
    ...(blocks.repairs.length > 0 ? { targetNodeIds: blocks.targetNodeIds } : {}),
  });
  return {
    kind: "preview",
    preview,
    ...(blocks.repairs.length > 0 ? { repairs: blocks.repairs } : {}),
  };
}

export async function handOverCommandNode(
  deps: CommandHandoverDeps,
  input: CommandHandoverInput,
): Promise<CommandHandoverResult | null> {
  const nodeId = targetNodeId(deps, input.targetConnectionId);
  const source = await commandSource(deps);
  const sourceNodeId = deps.installationIdOf(source);
  if (sourceNodeId === nodeId) return null;

  const registered = await deps.invokeOn<NodeListResult>(source, "list_nodes");
  const sourceStatus = await deps.invokeOn<NodeStatus>(source, "get_node_status");
  if (sourceStatus.mode === "standalone" && registered.nodes.length === 0) return null;

  // The user confirmed: clear what refuses the source on the target. The
  // source becomes the target's machine again through the handover itself.
  const { repairs } = await targetBlocks(deps, input.targetConnectionId, sourceNodeId);
  if (repairs.includes("forget-source-on-target")) {
    await deps.invokeOn(input.targetConnectionId, "forget_node", { nodeId: sourceNodeId });
  }
  if (repairs.includes("allow-source-on-target")) {
    await deps.invokeOn(input.targetConnectionId, "allow_controller", {
      controllerId: sourceNodeId,
    });
  }

  let addedTarget = false;
  const existing = registered.nodes.find((node) => node.nodeId === nodeId);
  if (existing && existing.connection.state !== "connected") {
    // A refused link does not retry by itself. If it still cannot connect,
    // the handover reports why.
    await deps.invokeOn(source, "reconnect_node", { nodeId });
  } else if (!existing) {
    const target = await deps.machineImportEntry(input.targetConnectionId);
    if (!target?.token) {
      throw new Error(
        "The command node does not control that machine yet, and this device has no address and token for it.",
      );
    }
    await deps.invokeOn(source, "add_node", {
      routes: target.routes,
      routeOrder: target.routeOrder,
      token: target.token,
      displayName: target.fallbackName,
    });
    addedTarget = true;
  }

  try {
    const entries: NodeImportEntry[] = [];
    for (const connectionId of input.connectionIds) {
      if (connectionId === input.targetConnectionId || connectionId === source) continue;
      const entry = await deps.machineImportEntry(connectionId);
      if (entry) entries.push(entry);
    }
    return await deps.invokeOn<CommandHandoverResult>(source, "hand_over_command", {
      nodeId,
      includeSelf: input.includeSelf,
      entries,
      ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}),
    });
  } catch (error) {
    if (addedTarget) {
      // A pending/committed backend handover removes the target itself. Only
      // compensate a registration that is still owned by this source.
      const current = await deps.invokeOn<NodeListResult>(source, "list_nodes").catch(() => null);
      if (current?.nodes.some((node) => node.nodeId === nodeId)) {
        await deps.invokeOn(source, "forget_node", { nodeId }).catch(() => undefined);
      }
    }
    throw error;
  }
}

export function parseCommandHandoverInput(value: unknown): CommandHandoverInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected handover details");
  }
  const input = value as Record<string, unknown>;
  const strings = (entry: unknown, label: string): string[] => {
    if (
      !Array.isArray(entry) ||
      entry.length > 64 ||
      !entry.every((id) => typeof id === "string")
    ) {
      throw new Error(`Expected ${label} to be a list of IDs`);
    }
    return entry as string[];
  };
  if (typeof input.targetConnectionId !== "string" || !input.targetConnectionId) {
    throw new Error("Expected a target connection ID");
  }
  return {
    targetConnectionId: input.targetConnectionId,
    ...(input.nodeIds === undefined ? {} : { nodeIds: strings(input.nodeIds, "nodeIds") }),
    connectionIds:
      input.connectionIds === undefined ? [] : strings(input.connectionIds, "connectionIds"),
    includeSelf: input.includeSelf !== false,
  };
}
