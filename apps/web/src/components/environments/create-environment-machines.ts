/**
 * The machines the New Environment dialog offers.
 *
 * An environment is created on one machine, from that machine's own project,
 * so a machine is offered only when it holds a project for the same
 * repository (matched by `repositoryHint`, as Build launches and the Linear
 * connect dialog match) and the command node can reach it now. The dialog's
 * own machine is always first and is the default: whoever opens the dialog
 * picks it by opening the dialog on that machine. Without a Git remote there
 * is nothing to match on, so only the dialog's own machine is offered.
 */
import { useMemo } from "react";
import { useBuildLaunchMachines, type BuildLaunchMachine } from "@/components/build/build-machines";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";

export type CreateEnvironmentMachine = BuildLaunchMachine;

/** Drops the machines an environment cannot be created on right now. */
export function createEnvironmentMachines(
  machines: readonly BuildLaunchMachine[],
): CreateEnvironmentMachine[] {
  return machines.filter((machine) => machine.current || machine.available);
}

/** The dialog's machines for `projectId` on the dialog's own node. */
export function useCreateEnvironmentMachines(
  projectId: string | null | undefined,
): CreateEnvironmentMachine[] {
  const machines = useBuildLaunchMachines(projectId ?? "");
  return useMemo(() => createEnvironmentMachines(machines), [machines]);
}

/**
 * Moves the New Environment dialog to `machine`: its own dialog opens there
 * for its copy of the project, so the machine's defaults, Docker check and
 * agent settings apply, as for "New environment" on that machine's project.
 * The window's command node is reached through its own sidebar.
 */
export function openCreateEnvironmentOnMachine(
  machine: CreateEnvironmentMachine,
  title: string,
): void {
  openMachineWorkspace({
    // `null` only when the window does not know its own node id, which
    // `openMachineWorkspace` treats as the window's own node.
    connectionId: machine.nodeId ?? "",
    projectId: machine.projectId,
    createEnvironment: true,
    title,
  });
}
