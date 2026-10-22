import type {
  CommandHandoverPreview,
  CommandHandoverResult,
} from "@orkestrator/protocol/command-nodes";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import { portalInvoke } from "@/lib/portal/portal-transport";

/**
 * Making another machine the command node. The command node in charge hands
 * the target its machines (tokens included) and follows as its leaf; the
 * target detaches whatever controlled it. On the desktop, Electron main adds
 * the machines saved only on this device. See `docs/architecture/command-nodes.md`.
 */

export const COMMAND_HANDOVER_REQUEST_EVENT = "orkestrator:command-handover";

/** The machine to make the command node. */
export interface HandoverTarget {
  name: string;
  /** Desktop: the saved connection (or Local) the window switches to. */
  connectionId?: string;
  /** Browser: the node in the command node's registry. */
  nodeId?: BackendId;
  /** Browser: the address the tab opens afterwards. */
  address?: string | null;
}

export function requestCommandHandover(target: HandoverTarget): void {
  window.dispatchEvent(
    new CustomEvent<HandoverTarget>(COMMAND_HANDOVER_REQUEST_EVENT, { detail: target }),
  );
}

export function onCommandHandoverRequest(listener: (target: HandoverTarget) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<HandoverTarget>).detail);
  window.addEventListener(COMMAND_HANDOVER_REQUEST_EVENT, handle);
  return () => window.removeEventListener(COMMAND_HANDOVER_REQUEST_EVENT, handle);
}

type ConnectionsApi = NonNullable<NonNullable<Window["orkestrator"]>["connections"]>;

function connectionsApi(): ConnectionsApi | null {
  return window.orkestrator?.connections ?? null;
}

/** A machine that can go with the handover. */
export interface HandoverMachine {
  key: string;
  name: string;
  colorToken?: string;
  /** Held by the command node in charge, or saved on this device only. */
  from: "command-node" | "device";
  /** Why it would arrive needing a token, if it would. */
  note?: string;
  nodeId?: BackendId;
  connectionId?: string;
}

export type HandoverPlan =
  | { kind: "already-command-node" }
  | {
      kind: "plan";
      preview: CommandHandoverPreview;
      /** Machines the target does not control yet, all chosen by default. */
      machines: HandoverMachine[];
    };

/**
 * Saved machines on this device the target would not get otherwise: proved
 * identity, a token on this device, and not already among the others.
 */
export function deviceOnlyMachines(
  list: ConnectionList,
  preview: CommandHandoverPreview,
  targetConnectionId: string | undefined,
): HandoverMachine[] {
  const known = new Set<string>([
    preview.targetNodeId,
    preview.self.nodeId,
    ...preview.targetNodeIds,
    ...preview.candidates.map((entry) => entry.nodeId),
  ]);
  const machines: HandoverMachine[] = [];
  for (const connection of list.connections) {
    const id = connection.backendId;
    if (connection.id === targetConnectionId || !id || connection.identity === "conflict") continue;
    if (connection.requiresToken || known.has(id)) continue;
    known.add(id);
    machines.push({
      key: `device:${connection.id}`,
      name: machineName(connection),
      ...(connection.profile?.colorToken ? { colorToken: connection.profile.colorToken } : {}),
      from: "device",
      connectionId: connection.id,
    });
  }
  return machines;
}

function machineName(connection: ConnectionSummary): string {
  return connection.nickname?.trim() || connection.profile?.displayName || connection.name;
}

export async function loadHandoverPlan(target: HandoverTarget): Promise<HandoverPlan> {
  const api = connectionsApi();
  let preview: CommandHandoverPreview;
  if (api?.previewCommandHandover && target.connectionId) {
    const result = await api.previewCommandHandover(target.connectionId);
    if (result.kind === "already-command-node") return result;
    preview = result.preview;
  } else if (target.nodeId) {
    preview = await portalInvoke<CommandHandoverPreview>("preview_command_handover", {
      nodeId: target.nodeId,
    });
  } else {
    throw new Error("This client cannot make that machine the command node.");
  }
  const machines: HandoverMachine[] = preview.candidates.map((entry) => ({
    key: `node:${entry.nodeId}`,
    name: entry.displayName,
    ...(entry.colorToken ? { colorToken: entry.colorToken } : {}),
    from: "command-node",
    nodeId: entry.nodeId,
    ...(entry.hasCredential ? {} : { note: "No token is saved for it" }),
  }));
  if (api) machines.push(...deviceOnlyMachines(await api.list(), preview, target.connectionId));
  return { kind: "plan", preview, machines };
}

export async function runHandover(
  target: HandoverTarget,
  plan: Extract<HandoverPlan, { kind: "plan" }>,
  chosen: { keys: Set<string>; includeSelf: boolean },
): Promise<CommandHandoverResult | null> {
  const nodeIds = plan.machines
    .filter((machine) => machine.nodeId && chosen.keys.has(machine.key))
    .map((machine) => machine.nodeId!);
  const connectionIds = plan.machines
    .filter((machine) => machine.connectionId && chosen.keys.has(machine.key))
    .map((machine) => machine.connectionId!);
  const api = connectionsApi();
  if (api?.handOverCommand && target.connectionId) {
    return api.handOverCommand({
      targetConnectionId: target.connectionId,
      nodeIds,
      connectionIds,
      includeSelf: chosen.includeSelf,
    });
  }
  return portalInvoke<CommandHandoverResult>("hand_over_command", {
    nodeId: plan.preview.targetNodeId,
    nodeIds,
    includeSelf: chosen.includeSelf,
  });
}
