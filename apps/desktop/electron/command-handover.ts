import type {
  CommandHandoverPreview,
  CommandHandoverPreviewResult,
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

export async function previewCommandHandover(
  deps: CommandHandoverDeps,
  targetConnectionId: string,
): Promise<CommandHandoverPreviewResult> {
  const nodeId = targetNodeId(deps, targetConnectionId);
  const source = await commandSource(deps);
  if (deps.installationIdOf(source) === nodeId) return { kind: "already-command-node" };
  const preview = await deps.invokeOn<CommandHandoverPreview>(source, "preview_command_handover", {
    nodeId,
  });
  return { kind: "preview", preview };
}

export async function handOverCommandNode(
  deps: CommandHandoverDeps,
  input: CommandHandoverInput,
): Promise<CommandHandoverResult | null> {
  const nodeId = targetNodeId(deps, input.targetConnectionId);
  const source = await commandSource(deps);
  if (deps.installationIdOf(source) === nodeId) return null;

  const registered = await deps.invokeOn<NodeListResult>(source, "list_nodes");
  if (!registered.nodes.some((node) => node.nodeId === nodeId)) {
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
  }

  const entries: NodeImportEntry[] = [];
  for (const connectionId of input.connectionIds) {
    if (connectionId === input.targetConnectionId || connectionId === source) continue;
    const entry = await deps.machineImportEntry(connectionId);
    if (entry) entries.push(entry);
  }
  return deps.invokeOn<CommandHandoverResult>(source, "hand_over_command", {
    nodeId,
    includeSelf: input.includeSelf,
    entries,
    ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}),
  });
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
