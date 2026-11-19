/**
 * The machines the project page's machine switcher offers: every machine with
 * a project for the same repository as the one shown (the targets
 * `linearMachineTargets` finds, matched by `repositoryHint`), in the order
 * the sidebar keeps its machines, so the list does not reshuffle when the
 * user switches. Pure.
 */
import type { PortalLayout } from "@orkestrator/protocol/portal-layout";
import type { LinearMachineTarget } from "@/components/linear/linear-machines";
import { machineOrder } from "@/lib/federation/sidebar-layout";

export interface ProjectMachineOption {
  /** Stable key for React and the select's value. */
  key: string;
  name: string;
  colorToken?: string;
  /** The node to open (`openMachineWorkspace`'s `connectionId`). */
  connectionId: string;
  /** The same repository's project on that machine. */
  projectId: string;
  /** The machine the project page is showing now. */
  current: boolean;
  /** The command node can reach it now. */
  available: boolean;
}

export function projectMachineOptions(
  targets: readonly LinearMachineTarget[],
  layout: Pick<PortalLayout, "machineOrder">,
  commandNodeId: string,
): ProjectMachineOption[] {
  const options = targets.map((target): ProjectMachineOption => ({
    key: target.key,
    name: target.name,
    ...(target.colorToken ? { colorToken: target.colorToken } : {}),
    connectionId: target.nodeId ?? commandNodeId,
    projectId: target.projectId,
    current: target.current,
    available: target.available,
  }));
  const position = new Map(
    machineOrder(
      options.map((option) => ({ connectionId: option.connectionId })),
      layout,
      commandNodeId,
    ).map((id, index) => [id, index]),
  );
  return options.sort(
    (left, right) =>
      (position.get(left.connectionId) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(right.connectionId) ?? Number.MAX_SAFE_INTEGER),
  );
}
