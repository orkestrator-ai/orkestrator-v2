import type { BackendId } from "@orkestrator/protocol/federation";
import { hostMaintenanceClient, type HostMaintenanceClient } from "@/lib/host-maintenance-client";
import { commandScopeInvoke } from "@/lib/portal/command-scope";
import { invokeOnMachine } from "@/lib/portal/machine-scope";
import type { MachineEntry } from "./machine-list";

export type MachineInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Sends a command to one machine: the command scope's own commands for the
 * command node; for another node, its own scope when the window holds it
 * warm or live, else routed through the command scope (`invokeOnMachine`,
 * plan item 5004). Null for a machine the command node does not know (saved
 * on this device only).
 */
export function machineInvoke(
  machine: Pick<MachineEntry, "role" | "nodeId">,
): MachineInvoke | null {
  if (machine.role === "self") {
    return <T>(command: string, args: Record<string, unknown> = {}) =>
      commandScopeInvoke<T>(command, args);
  }
  if (machine.role === "node" && machine.nodeId) {
    const nodeId = machine.nodeId as BackendId;
    return <T>(command: string, args: Record<string, unknown> = {}) =>
      invokeOnMachine<T>(nodeId, command, args);
  }
  return null;
}

export function machineMaintenanceClient(
  machine: Pick<MachineEntry, "role" | "nodeId">,
): HostMaintenanceClient | null {
  const call = machineInvoke(machine);
  return call ? hostMaintenanceClient(call) : null;
}
