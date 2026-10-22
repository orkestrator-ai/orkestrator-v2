import type { BackendId } from "@orkestrator/protocol/federation";
import { hostMaintenanceClient, type HostMaintenanceClient } from "@/lib/host-maintenance-client";
import { portalStore } from "@/lib/portal/portal-store";
import { portalInvoke } from "@/lib/portal/portal-transport";
import type { MachineEntry } from "./machine-list";

export type MachineInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Sends a command to one machine: the command node's own commands for
 * itself, otherwise routed through it to the node. Null for a machine the
 * command node does not know (saved on this device only).
 */
export function machineInvoke(
  machine: Pick<MachineEntry, "role" | "nodeId">,
): MachineInvoke | null {
  if (machine.role === "self") {
    return <T>(command: string, args: Record<string, unknown> = {}) =>
      portalInvoke<T>(command, args);
  }
  if (machine.role === "node" && machine.nodeId) {
    const nodeId = machine.nodeId as BackendId;
    return <T>(command: string, args: Record<string, unknown> = {}) =>
      portalStore.invokeOnNode<T>(nodeId, command, args);
  }
  return null;
}

export function machineMaintenanceClient(
  machine: Pick<MachineEntry, "role" | "nodeId">,
): HostMaintenanceClient | null {
  const call = machineInvoke(machine);
  return call ? hostMaintenanceClient(call) : null;
}
