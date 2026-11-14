/**
 * The machines a Build can be started on.
 *
 * A pipeline creates its environment on one machine and runs there, so a
 * machine is offered only when it holds a project for the ticket's repository
 * (matched by `repositoryHint`, the same match ticket sync and the Linear
 * connect dialog use). This tab's own machine is always first and the default.
 * Without a Git remote there is nothing to match on, so only it is offered.
 */
import { useMemo } from "react";
import {
  useLinearMachineTargets,
  type LinearMachineTarget,
} from "@/components/linear/linear-machines";
import type { AccountMachine } from "@/lib/backend/client";

export interface BuildLaunchMachine {
  /** Stable key for React and the radio group. */
  key: string;
  name: string;
  /**
   * How to reach it (`AccountMachine`): `undefined` is this tab's machine,
   * `null` the window's command node, a node id any other machine.
   */
  machine: AccountMachine;
  /** The machine's node id, when known. */
  nodeId: string | null;
  /** The same repository's project on that machine. */
  projectId: string;
  /** This tab's own machine. */
  current: boolean;
  /** The command node can reach it now. */
  available: boolean;
}

/** The machine a launch was aimed at, when it is not this tab's own. */
export interface BuildLaunchMachineChoice {
  machine: AccountMachine;
  nodeId: string | null;
  projectId: string;
  name: string;
}

export function buildLaunchMachines(targets: readonly LinearMachineTarget[]): BuildLaunchMachine[] {
  return targets.map((target) => ({
    key: target.key,
    name: target.name,
    machine: target.machine,
    nodeId: target.nodeId,
    projectId: target.projectId,
    current: target.current,
    available: target.available,
  }));
}

/** The launcher's machines for `projectId` on this tab's node; one entry when there is no choice. */
export function useBuildLaunchMachines(projectId: string): BuildLaunchMachine[] {
  const targets = useLinearMachineTargets(projectId);
  return useMemo(() => buildLaunchMachines(targets), [targets]);
}

/** What `onConfirm` reports for a pick: nothing for this tab's own machine. */
export function machineChoiceFor(
  machines: readonly BuildLaunchMachine[] | undefined,
  key: string | null,
): BuildLaunchMachineChoice | undefined {
  const picked = machines?.find((entry) => entry.key === key);
  if (!picked || picked.current) return undefined;
  return {
    machine: picked.machine,
    nodeId: picked.nodeId,
    projectId: picked.projectId,
    name: picked.name,
  };
}
